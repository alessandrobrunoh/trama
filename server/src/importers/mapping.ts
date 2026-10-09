import { BadRequestException } from '@nestjs/common';
import {
  LABEL_NAME_MAX,
  type ExternalProvider,
  type ExternalRef,
  type ExternalStateType,
  type ImportMapping,
  type ImportOptions,
  type ImportPreview,
  type ImportTarget,
  type IssueKind,
  type IssueStatus,
  type Priority,
} from '../contracts/domain.js';
import { STATE_TYPES, type Discovery, type ExternalIssue, type ExternalState, type ExternalUser, type ParsedExternalUrl } from './types.js';

const ISSUE_STATUSES: readonly IssueStatus[] = ['draft', 'backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'];
const ISSUE_KINDS: readonly IssueKind[] = ['bug', 'feature', 'incident', 'tech_debt', 'feedback', 'idea', 'security'];
const MAX_MAPPING_ENTRIES = 5_000;
const MAX_TITLE = 300;
const MAX_BODY = 100_000;

// ───────────────────────────── states, priorities, kinds ─────────────────────────────

/** Linear priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
export function mapLinearPriority(value: number | null | undefined): Priority {
  switch (value) {
    case 1:
      return 'urgent';
    case 2:
      return 'high';
    case 3:
      return 'medium';
    case 4:
      return 'low';
    default:
      return 'none';
  }
}

/**
 * Linear states are grouped by `type`: triage and backlog wait, unstarted is todo, started is in progress
 * (or in review when the team named the column that way), completed is done and canceled is canceled.
 */
export function mapLinearStateType(type: string, name = ''): IssueStatus {
  switch (type) {
    case 'triage':
    case 'backlog':
      return 'backlog';
    case 'unstarted':
      return 'todo';
    case 'started':
      return /review|qa\b|verif|testing/i.test(name) ? 'in_review' : 'in_progress';
    case 'completed':
      return 'done';
    case 'canceled':
      return 'canceled';
    default:
      return 'backlog';
  }
}

/** GitHub issues are open, or closed as completed / not planned. An open issue is not yet scheduled: backlog. */
export function mapGithubState(state: string, reason?: string | null): ExternalState {
  if (state === 'open') return { id: 'open', name: 'Open', type: 'open' };
  if (reason === 'not_planned') return { id: 'not_planned', name: 'Closed (not planned)', type: 'not_planned' };
  return { id: 'closed', name: 'Closed', type: 'closed' };
}

export function suggestStatus(provider: ExternalProvider, state: ExternalState): IssueStatus {
  if (provider === 'linear') return mapLinearStateType(state.type, state.name);
  if (state.type === 'open') return 'backlog';
  return state.type === 'not_planned' ? 'canceled' : 'done';
}

export function stateTypeOf(state: ExternalState): ExternalStateType {
  return STATE_TYPES[state.type] ?? 'open';
}

/** `priority: high`, `P1`, `urgent`… on a GitHub label. Only labels that look like a priority count. */
export function priorityFromLabels(names: readonly string[]): Priority | undefined {
  const byWord: Record<string, Priority> = { urgent: 'urgent', critical: 'urgent', blocker: 'urgent', high: 'high', medium: 'medium', normal: 'medium', low: 'low' };
  const byRank: Priority[] = ['urgent', 'high', 'medium', 'low', 'low'];
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    const word = /^(?:priority\s*[:/\-–]\s*)?(urgent|critical|blocker|high|medium|normal|low)$/.exec(name)?.[1];
    // A bare "high" or "low" is too ambiguous: only "urgent" and "critical" stand alone.
    if (word && (name.startsWith('priority') || word === 'urgent' || word === 'critical')) return byWord[word];
    const rank = /^(?:priority\s*[:/\-–]?\s*)?p([0-4])$/.exec(name)?.[1];
    if (rank !== undefined) return byRank[Number(rank)];
  }
  return undefined;
}

/** The first label that names a kind wins; otherwise the configured default. */
export function inferKind(labelNames: readonly string[], fallback: IssueKind): IssueKind {
  const rules: [RegExp, IssueKind][] = [
    [/\b(security|vulnerab|cve)\b/i, 'security'],
    [/\b(incident|outage|sev[0-9])\b/i, 'incident'],
    [/\b(bug|defect|regression|crash)\b/i, 'bug'],
    [/\b(tech[- ]?debt|chore|refactor|cleanup|maintenance)\b/i, 'tech_debt'],
    [/\b(feedback|customer[- ]request|support)\b/i, 'feedback'],
    [/\b(idea|proposal|rfc|discussion)\b/i, 'idea'],
    [/\b(feature|enhancement|improvement|story)\b/i, 'feature'],
  ];
  for (const [re, kind] of rules) if (labelNames.some((n) => re.test(n))) return kind;
  return fallback;
}

// ───────────────────────────── people and names ─────────────────────────────

export interface Member {
  id: string;
  name: string;
  email: string;
}

const norm = (s: string) => s.trim().toLowerCase();
const squash = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '');

/**
 * Matches a tracker user to a workspace member: same email first, then login against the email's local part,
 * then the display name. A weaker rule that matches several members matches none.
 */
export function suggestUser(user: ExternalUser, members: readonly Member[]): string | null {
  if (user.email) {
    const hit = members.find((m) => norm(m.email) === norm(user.email!));
    if (hit) return hit.id;
  }
  const keys = [user.login, user.name].filter((k): k is string => !!k).map(squash).filter(Boolean);
  const unique = (found: Member[]) => (found.length === 1 ? found[0].id : null);
  if (user.login) {
    const byLocal = unique(members.filter((m) => squash(m.email.split('@')[0] ?? '') === squash(user.login!)));
    if (byLocal) return byLocal;
  }
  for (const key of keys) {
    const byName = unique(members.filter((m) => squash(m.name) === key));
    if (byName) return byName;
  }
  return null;
}

/** Existing Trama entity with the same name (case-insensitive), or `null`. */
export function matchByName<T extends { id: string; name: string }>(name: string, existing: readonly T[]): T | null {
  const key = norm(name);
  return existing.find((e) => norm(e.name) === key) ?? null;
}

/** `ENG` from a Linear key, or letters from the name; always 2-8 uppercase letters/digits and not in `taken`. */
export function deriveTeamKey(hint: string | undefined, name: string, taken: ReadonlySet<string>): string {
  const clean = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  let base = clean(hint ?? '') || clean(name);
  base = base.replace(/^[0-9]+/, '');
  if (base.length < 2) base = `${base}TM`.slice(0, 8);
  base = base.slice(0, 6);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, 8 - String(n).length)}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new BadRequestException('Could not find a free team key');
}

// ───────────────────────────── preview and mapping ─────────────────────────────

export interface PreviewContext {
  members: readonly Member[];
  teams: readonly { id: string; name: string; key: string }[];
  projects: readonly { id: string; name: string }[];
  labels: readonly { id: string; name: string }[];
}

const map = (id: string): ImportTarget => ({ action: 'map', id });

/** Discovery plus suggested targets (existing entity with the same name, otherwise create / skip). */
export function buildPreview(discovery: Discovery, ctx: PreviewContext): ImportPreview {
  const teams = discovery.teams.map((t) => {
    const hit = ctx.teams.find((x) => (t.key && x.key.toLowerCase() === t.key.toLowerCase()) || norm(x.name) === norm(t.name));
    const suggested: ImportTarget = hit ? map(hit.id) : discovery.provider === 'linear' ? { action: 'create' } : { action: 'skip' };
    return { ...t, suggested };
  });
  const projects = discovery.projects.map((p) => {
    const hit = matchByName(p.name, ctx.projects);
    return { ...p, suggested: hit ? map(hit.id) : ({ action: 'create' } as ImportTarget) };
  });
  const labels = discovery.labels.map((l) => {
    const hit = matchByName(l.name, ctx.labels);
    return { ...l, suggested: hit ? map(hit.id) : ({ action: 'create' } as ImportTarget) };
  });
  const users = discovery.users.map((u) => ({
    id: u.id,
    name: u.name,
    login: u.login,
    email: u.email,
    suggestedUserId: suggestUser(u, ctx.members),
  }));
  const statuses = discovery.statuses.map((s) => ({ ...s, suggested: suggestStatus(discovery.provider, s) }));
  return {
    provider: discovery.provider,
    account: discovery.account,
    sourceLabel: discovery.sourceLabel,
    sourceUrl: discovery.sourceUrl,
    counts: {
      ...discovery.counts,
      projects: projects.length,
      milestones: discovery.milestones.length,
      labels: labels.length,
      users: users.length,
    },
    teams,
    projects,
    labels,
    milestones: discovery.milestones.map((m) => ({ id: m.id, name: m.name, projectId: m.projectId, dueOn: m.dueOn })),
    users,
    statuses,
    sample: discovery.sample,
    warnings: discovery.warnings,
  };
}

/** The mapping the preview suggests, for callers (agents, "run with defaults") that do not edit it. */
export function mappingFromPreview(preview: ImportPreview): ImportMapping {
  return {
    teams: Object.fromEntries(preview.teams.map((t) => [t.id, t.suggested])),
    projects: Object.fromEntries(preview.projects.map((p) => [p.id, p.suggested])),
    labels: Object.fromEntries(preview.labels.map((l) => [l.id, l.suggested])),
    users: Object.fromEntries(preview.users.map((u) => [u.id, u.suggestedUserId])),
    statuses: Object.fromEntries(preview.statuses.map((s) => [s.id, s.suggested])),
  };
}

function record(raw: unknown, label: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException(`mapping.${label} must be an object`);
  const entries = Object.keys(raw);
  if (entries.length > MAX_MAPPING_ENTRIES) throw new BadRequestException(`mapping.${label} has too many entries`);
  for (const key of entries)
    if (!key || key.length > 300) throw new BadRequestException(`mapping.${label} has an invalid key`);
  return raw as Record<string, unknown>;
}

function target(raw: unknown, where: string): ImportTarget {
  const t = raw as { action?: unknown; id?: unknown } | null;
  if (t && typeof t === 'object') {
    if (t.action === 'skip') return { action: 'skip' };
    if (t.action === 'create') return { action: 'create' };
    if (t.action === 'map' && typeof t.id === 'string' && t.id.length > 0 && t.id.length <= 100) return { action: 'map', id: t.id };
  }
  throw new BadRequestException(`${where} must be {action: "map", id} | {action: "create"} | {action: "skip"}`);
}

/** Strict parse of a user-supplied mapping: unknown shapes are a 400, never silently dropped. */
export function parseMapping(raw: unknown): ImportMapping {
  if (raw === undefined || raw === null) return { teams: {}, projects: {}, labels: {}, users: {}, statuses: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('mapping must be an object');
  const m = raw as Record<string, unknown>;
  const out: ImportMapping = { teams: {}, projects: {}, labels: {}, users: {}, statuses: {} };
  for (const kind of ['teams', 'projects', 'labels'] as const)
    for (const [k, v] of Object.entries(record(m[kind], kind))) out[kind][k] = target(v, `mapping.${kind}["${k}"]`);
  for (const [k, v] of Object.entries(record(m.users, 'users'))) {
    if (v !== null && (typeof v !== 'string' || !v || v.length > 100)) throw new BadRequestException(`mapping.users["${k}"] must be a user id or null`);
    out.users[k] = v as string | null;
  }
  for (const [k, v] of Object.entries(record(m.statuses, 'statuses'))) {
    if (typeof v !== 'string' || !ISSUE_STATUSES.includes(v as IssueStatus))
      throw new BadRequestException(`mapping.statuses["${k}"] must be one of ${ISSUE_STATUSES.join(', ')}`);
    out.statuses[k] = v as IssueStatus;
  }
  return out;
}

export function parseOptions(raw: unknown, defaults: ImportOptions): ImportOptions {
  const o = (raw ?? {}) as Partial<ImportOptions>;
  if (typeof o !== 'object' || Array.isArray(o)) throw new BadRequestException('options must be an object');
  const bool = (v: unknown, d: boolean, name: string) => {
    if (v === undefined) return d;
    if (typeof v !== 'boolean') throw new BadRequestException(`options.${name} must be a boolean`);
    return v;
  };
  const kind = o.defaultKind ?? defaults.defaultKind;
  if (!ISSUE_KINDS.includes(kind)) throw new BadRequestException(`options.defaultKind must be one of ${ISSUE_KINDS.join(', ')}`);
  return {
    includeComments: bool(o.includeComments, defaults.includeComments, 'includeComments'),
    includeClosed: bool(o.includeClosed, defaults.includeClosed, 'includeClosed'),
    defaultKind: kind,
  };
}

// ───────────────────────────── issue conversion ─────────────────────────────

/** Trama ids the mapping resolved to, per external id. `null` = skipped. */
export interface ResolvedPlan {
  teams: Record<string, string | null>;
  projects: Record<string, string | null>;
  labels: Record<string, string | null>;
  milestones: Record<string, string | null>;
  users: Record<string, string | null>;
  statuses: Record<string, IssueStatus>;
}

export interface NewIssue {
  externalRef: ExternalRef;
  kind: IssueKind;
  title: string;
  body: string | null;
  source: 'github' | 'linear';
  reporterName: string | null;
  assigneeId: string | null;
  teamId: string | null;
  projectId: string | null;
  milestoneIds: string[];
  priority: Priority;
  status: IssueStatus;
  estimate: number | null;
  labels: string[];
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

const date = (value: string | undefined, fallback: Date): Date => {
  const d = value ? new Date(value) : fallback;
  return Number.isNaN(d.getTime()) ? fallback : d;
};

export function externalRefOf(provider: ExternalProvider, ext: ExternalIssue, origin: 'import' | 'link', now = new Date()): ExternalRef {
  return {
    provider,
    id: ext.id,
    url: ext.url,
    key: ext.key,
    state: ext.state.name,
    stateType: stateTypeOf(ext.state),
    syncedAt: now.toISOString(),
    origin,
  };
}

/** Pure conversion of one external issue into the fields of a Trama issue, given the resolved plan. */
export function toNewIssue(provider: ExternalProvider, ext: ExternalIssue, plan: ResolvedPlan, options: ImportOptions, now = new Date()): NewIssue {
  const labelNames = ext.labels.map((l) => l.name);
  const status = plan.statuses[ext.state.id] ?? suggestStatus(provider, ext.state);
  const createdAt = date(ext.createdAt, now);
  const updatedAt = date(ext.updatedAt, createdAt);
  const labels = [...new Set(ext.labels.map((l) => plan.labels[l.id]).filter((x): x is string => !!x))].slice(0, 20);
  const milestoneId = ext.milestone ? plan.milestones[ext.milestone.id] : null;
  const priority = ext.priority ?? priorityFromLabels(labelNames) ?? 'none';
  const finished = status === 'done' || status === 'canceled';
  const started = status === 'in_progress' || status === 'in_review';
  const estimate = typeof ext.estimate === 'number' && Number.isFinite(ext.estimate) && ext.estimate >= 0 ? Math.min(ext.estimate, 1000) : null;
  const title = ext.title.trim().slice(0, MAX_TITLE) || ext.key;
  return {
    externalRef: externalRefOf(provider, ext, 'import', now),
    kind: inferKind(labelNames, options.defaultKind),
    title,
    body: ext.body ? ext.body.slice(0, MAX_BODY) : null,
    source: provider,
    reporterName: ext.creator ? (ext.creator.name ?? ext.creator.login ?? null) : null,
    assigneeId: ext.assignee ? (plan.users[ext.assignee.id] ?? null) : null,
    teamId: ext.teamId ? (plan.teams[ext.teamId] ?? null) : null,
    projectId: ext.projectId ? (plan.projects[ext.projectId] ?? null) : null,
    milestoneIds: milestoneId ? [milestoneId] : [],
    priority,
    status,
    estimate,
    labels,
    createdAt,
    updatedAt,
    startedAt: started || finished ? date(ext.startedAt, createdAt) : null,
    completedAt: finished ? date(ext.closedAt, updatedAt) : null,
  };
}

/** Colour for a created label: the tracker's when valid, otherwise none (the catalog picks one). */
export function labelColor(color: string | undefined): string | undefined {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : undefined;
}

export function labelName(name: string): string {
  return name.trim().slice(0, LABEL_NAME_MAX);
}

// ───────────────────────────── URLs ─────────────────────────────

/** Recognises an issue URL of GitHub (any host: the caller decides which hosts it trusts) or Linear. */
export function parseExternalUrl(raw: string): ParsedExternalUrl | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'linear.app') {
    const m = /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$)/.exec(url.pathname);
    if (!m) return null;
    const identifier = m[1].toUpperCase();
    return { provider: 'linear', host, identifier, url: `https://linear.app${url.pathname.split('/').slice(0, 4).join('/')}/${identifier}` };
  }
  const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\/?$/.exec(url.pathname);
  if (!m) return null;
  return {
    provider: 'github',
    host,
    repository: `${m[1]}/${m[2]}`,
    number: Number(m[3]),
    url: `${url.origin}/${m[1]}/${m[2]}/issues/${m[3]}`,
  };
}

/** GitHub external id: `owner/repo#12`, lower-cased so the same issue always has the same id. */
export function githubIssueId(repository: string, number: number): string {
  return `${repository.toLowerCase()}#${number}`;
}

// ───────────────────────────── secrets ─────────────────────────────

const TOKEN_SHAPES = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}\b/g,
  /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/** Removes the given secrets and anything shaped like a GitHub / Linear token or auth header from text that will be stored or logged. */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  for (const re of TOKEN_SHAPES) out = out.replace(re, (m, scheme?: string) => (scheme ? `${scheme} [redacted]` : '[redacted]'));
  return out;
}
