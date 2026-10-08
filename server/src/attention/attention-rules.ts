import type {
  ActorRef,
  ArtifactKind,
  ArtifactState,
  AttentionKind,
  AttentionSeverity,
  CiState,
  DecisionStatus,
  InputRequestState,
  IssueStatus,
  ReviewState,
  WorkstreamStatus,
} from '../contracts/domain.js';

// ───── input shapes (entities satisfy these structurally)

export interface AWorkstream {
  id: string;
  key: string;
  title: string;
  ownerTeamId: string;
  participatingTeamIds: string[];
  accountableUserId?: string | null;
  acceptanceCriteria: { state: string }[];
  status: WorkstreamStatus;
  derivedStatus: WorkstreamStatus;
  statusOverride?: WorkstreamStatus | null;
  targetDate?: Date | null;
  updatedAt: Date;
}
export interface AInputRequest {
  id: string;
  workstreamId: string;
  question: string;
  requestedBy: ActorRef;
  assigneeUserId?: string | null;
  state: InputRequestState;
  createdAt: Date;
}
export interface AArtifact {
  id: string;
  workstreamId: string;
  kind: ArtifactKind;
  title: string;
  externalId?: string | null;
  state: ArtifactState;
  ci?: CiState | null;
  review?: ReviewState | null;
  hasConflicts?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface ADecision {
  id: string;
  key: string;
  title: string;
  status: DecisionStatus;
  originWorkstreamId?: string | null;
  relatedWorkstreamIds: string[];
  proposedBy: ActorRef;
  createdAt: Date;
}
export interface ADependency {
  id: string;
  fromType: 'workstream';
  fromId: string;
  toType: 'workstream';
  toId: string;
  createdAt: Date;
}
export interface AIssue {
  id: string;
  key: string;
  title: string;
  teamId?: string | null;
  status: IssueStatus;
  createdAt: Date;
}
export interface ATeam {
  id: string;
  name: string;
  memberIds: string[];
}

export interface AttentionData {
  now: Date;
  teams: ATeam[];
  /** id → display name (users and agents). */
  names: Map<string, string>;
  /** user ids with an admin or owner role (they see backlog issues without a team). */
  adminIds: string[];
  workstreams: AWorkstream[];
  inputRequests: AInputRequest[];
  artifacts: AArtifact[];
  decisions: ADecision[];
  dependencies: ADependency[];
  issues: AIssue[];
  /** Better `since` timestamps keyed by item id (from the event log); fall back to entity timestamps. */
  since?: Map<string, Date>;
}

/** An item before per-user state is merged. `audience` = users who see it in scope `mine`. */
export interface RawAttentionItem {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  workstreamId?: string;
  artifactId?: string;
  decisionId?: string;
  inputRequestId?: string;
  issueId?: string;
  since: Date;
  audience: Set<string>;
}

export const DEADLINE_WINDOW_DAYS = 3;
const DAY = 86_400_000;
const isPr = (a: AArtifact) => a.kind === 'pull_request' || a.kind === 'merge_request';
const isOpenPr = (a: AArtifact) => isPr(a) && a.state === 'open';
const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Pure implementation of the PLAN.md §3 table. */
export function computeAttention(d: AttentionData): RawAttentionItem[] {
  const teams = new Map(d.teams.map((t) => [t.id, t]));
  const wsById = new Map(d.workstreams.map((w) => [w.id, w]));
  const sinceOf = (id: string, fallback: Date) => d.since?.get(id) ?? fallback;
  const nameOf = (a: ActorRef) => (a.id ? (d.names.get(a.id) ?? a.id) : 'system');

  /** accountable user + members of owner and participating teams */
  const relevant = (w: AWorkstream): Set<string> => {
    const s = new Set<string>();
    if (w.accountableUserId) s.add(w.accountableUserId);
    for (const t of [w.ownerTeamId, ...w.participatingTeamIds]) for (const u of teams.get(t)?.memberIds ?? []) s.add(u);
    return s;
  };
  /** accountable user + owner team */
  const ownerSide = (w: AWorkstream): Set<string> => {
    const s = new Set<string>();
    if (w.accountableUserId) s.add(w.accountableUserId);
    for (const u of teams.get(w.ownerTeamId)?.memberIds ?? []) s.add(u);
    return s;
  };

  const items: RawAttentionItem[] = [];
  const active = d.workstreams.filter((w) => !w.statusOverride);
  const live = active.filter((w) => w.derivedStatus !== 'shipped');
  const liveIds = new Set(live.map((w) => w.id));
  const activeIds = new Set(active.map((w) => w.id));

  // input_requested
  for (const r of d.inputRequests) {
    const w = wsById.get(r.workstreamId);
    if (r.state !== 'open' || !w || !activeIds.has(w.id)) continue;
    const audience = r.assigneeUserId
      ? new Set([r.assigneeUserId])
      : w.accountableUserId
        ? new Set([w.accountableUserId])
        : ownerSide(w);
    items.push({
      id: `input_requested:${r.id}`,
      kind: 'input_requested',
      severity: 'high',
      title: short(r.question),
      detail: `${w.key} · ${w.title} — asked by ${nameOf(r.requestedBy)}`,
      workstreamId: w.id,
      inputRequestId: r.id,
      since: r.createdAt,
      audience,
    });
  }

  // needs_decision
  for (const dec of d.decisions) {
    if (dec.status !== 'proposed') continue;
    const wss = [dec.originWorkstreamId, ...dec.relatedWorkstreamIds]
      .map((id) => (id ? wsById.get(id) : undefined))
      .filter((w): w is AWorkstream => !!w && activeIds.has(w.id));
    if (!wss.length) continue;
    const audience = new Set<string>();
    for (const w of wss) for (const u of relevant(w)) audience.add(u);
    items.push({
      id: `needs_decision:${dec.id}`,
      kind: 'needs_decision',
      severity: 'high',
      title: `Decide: ${short(dec.title, 120)}`,
      detail: `${dec.key} proposed by ${nameOf(dec.proposedBy)} · ${wss.map((w) => w.key).join(', ')}`,
      workstreamId: wss[0].id,
      decisionId: dec.id,
      since: dec.createdAt,
      audience,
    });
  }

  // artifact based kinds
  for (const a of d.artifacts) {
    const w = wsById.get(a.workstreamId);
    if (!w || !liveIds.has(w.id) || !isOpenPr(a)) continue;
    const label = a.externalId ? `${a.title} (${a.externalId})` : a.title;
    const base = { workstreamId: w.id, artifactId: a.id };
    if (a.review === 'requested')
      items.push({
        ...base,
        id: `review_requested:${a.id}`,
        kind: 'review_requested',
        severity: 'medium',
        title: `Review requested: ${short(a.title, 120)}`,
        detail: `${w.key} · ${label}`,
        since: sinceOf(`review_requested:${a.id}`, a.updatedAt),
        audience: ownerSide(w),
      });
    if (a.ci === 'failing')
      items.push({
        ...base,
        id: `ci_failed:${a.id}`,
        kind: 'ci_failed',
        severity: 'high',
        title: `CI failing: ${short(a.title, 120)}`,
        detail: `${w.key} · ${label}`,
        since: sinceOf(`ci_failed:${a.id}`, a.updatedAt),
        audience: relevant(w),
      });
    if (a.hasConflicts)
      items.push({
        ...base,
        id: `conflict:${a.id}`,
        kind: 'conflict',
        severity: 'medium',
        title: `Merge conflicts: ${short(a.title, 120)}`,
        detail: `${w.key} · ${label}`,
        since: sinceOf(`conflict:${a.id}`, a.updatedAt),
        audience: relevant(w),
      });
    if (a.review === 'approved' && a.ci === 'passing' && !a.hasConflicts)
      items.push({
        ...base,
        id: `ready_to_land:${a.id}`,
        kind: 'ready_to_land',
        severity: 'medium',
        title: `Ready to land: ${short(a.title, 120)}`,
        detail: `${w.key} · ${label} is approved and passing`,
        since: sinceOf(`ready_to_land:${a.id}`, a.updatedAt),
        audience: relevant(w),
      });
  }

  // dependency: waiting on another team's unshipped workstream
  for (const dep of d.dependencies) {
    if (dep.fromType !== 'workstream' || dep.toType !== 'workstream') continue;
    const target = wsById.get(dep.toId);
    const source = wsById.get(dep.fromId);
    if (!target || !source || target.id === source.id || !liveIds.has(target.id)) continue;
    if (source.status === 'shipped' || source.ownerTeamId === target.ownerTeamId) continue;
    items.push({
      id: `dependency:${dep.id}`,
      kind: 'dependency',
      severity: 'low',
      title: `${target.key} is waiting on ${source.key}`,
      detail: `${source.title} is ${source.status.replace('_', ' ')}`,
      workstreamId: target.id,
      since: dep.createdAt,
      audience: relevant(target),
    });
  }

  // deadline
  for (const w of live) {
    if (!w.targetDate) continue;
    const delta = w.targetDate.getTime() - d.now.getTime();
    if (delta > DEADLINE_WINDOW_DAYS * DAY) continue;
    const overdue = delta < 0;
    const days = Math.ceil(Math.abs(delta) / DAY);
    items.push({
      id: `deadline:${w.id}`,
      kind: 'deadline',
      severity: overdue ? 'high' : 'medium',
      title: overdue ? `${w.key} is overdue` : `${w.key} is due ${days <= 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}`,
      detail: overdue ? `${w.title} — ${days} day${days === 1 ? '' : 's'} past the target date` : w.title,
      workstreamId: w.id,
      since: w.targetDate,
      audience: relevant(w),
    });
  }

  // ready_to_ship: every criterion met, nothing open to merge, nothing deployed
  for (const w of live) {
    if (!w.acceptanceCriteria.length || w.acceptanceCriteria.some((c) => c.state !== 'met')) continue;
    const arts = d.artifacts.filter((a) => a.workstreamId === w.id);
    if (arts.some((a) => isPr(a) && (a.state === 'open' || a.state === 'draft'))) continue;
    if (arts.some((a) => a.kind === 'deployment' || a.kind === 'release')) continue;
    items.push({
      id: `ready_to_ship:${w.id}`,
      kind: 'ready_to_ship',
      severity: 'low',
      title: `${w.key} is ready to ship`,
      detail: `${w.title} — all acceptance criteria are met and nothing is deployed yet`,
      workstreamId: w.id,
      since: sinceOf(`ready_to_ship:${w.id}`, w.updatedAt),
      audience: relevant(w),
    });
  }

  // triage: backlog issues, one item per team (plus one for issues without a team, for admins)
  const backlog = d.issues.filter((i) => i.status === 'backlog');
  const groups = new Map<string, AIssue[]>();
  for (const i of backlog) groups.set(i.teamId ?? '', [...(groups.get(i.teamId ?? '') ?? []), i]);
  for (const [teamId, list] of groups) {
    const t = teamId ? teams.get(teamId) : undefined;
    if (teamId && !t) continue;
    const since = new Date(Math.max(...list.map((i) => i.createdAt.getTime())));
    const keys = list.slice(0, 3).map((i) => i.key).join(', ');
    items.push({
      id: `triage:${teamId || 'workspace'}`,
      kind: 'triage',
      severity: 'low',
      title: `${list.length} backlog issue${list.length === 1 ? '' : 's'} for ${t?.name ?? 'the workspace'}`,
      detail: list.length > 3 ? `${keys} and ${list.length - 3} more` : keys,
      issueId: list[0].id,
      since,
      audience: new Set(t ? t.memberIds : d.adminIds),
    });
  }

  return items;
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { high: 0, medium: 1, low: 2 };

/** high → low severity, then the longest-waiting first. */
export function sortItems<T extends { severity: AttentionSeverity; since: Date; id: string }>(items: T[]): T[] {
  return items.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.since.getTime() - b.since.getTime() ||
      a.id.localeCompare(b.id),
  );
}

export interface AttentionStateRow {
  state: 'dismissed' | 'snoozed';
  snoozedUntil?: Date | null;
  since: Date;
}

/** Merge per-user dismiss/snooze: a changed `since` re-opens; an expired snooze re-opens. */
export function itemState(
  item: { since: Date },
  row: AttentionStateRow | undefined,
  now: Date,
): { state: 'open' | 'snoozed' | 'dismissed'; snoozedUntil?: Date } {
  if (!row || row.since.getTime() !== item.since.getTime()) return { state: 'open' };
  if (row.state === 'dismissed') return { state: 'dismissed' };
  if (row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime()) return { state: 'snoozed', snoozedUntil: row.snoozedUntil };
  return { state: 'open' };
}
