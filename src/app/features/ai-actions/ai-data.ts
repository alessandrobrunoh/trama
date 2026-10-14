// Turns store records into the bounded, plain-data inputs the prompt builders accept.
// Read-only: nothing here writes to the store or talks to the server. Names appear (people use
// them in comments), emails never do (`clip` scrubs them), and every list is capped.
import {
  ISSUE_KINDS,
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  TramaStore,
  PRIORITIES,
  PRIORITY_META,
  estimateOptions,
  type DomainEvent,
  type Issue,
} from '../../core';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { todayDay } from '../milestones/milestone-model';
import {
  boundedLines,
  clip,
  oneLine,
  type EstimateChoice,
  type PromptDigest,
  type PromptIssue,
  type PromptSimilar,
} from './prompts';
import { rankByOverlap } from './similar';

const DAY = 86_400_000;
const dayStr = (iso: string): string => iso.slice(0, 10);
const daysBetween = (a: string, b: string | number): number => Math.round((new Date(b).getTime() - new Date(a).getTime()) / DAY);

/** Workspace estimate scale as prompt choices, or `null` when estimates are off. */
export function estimateChoices(store: TramaStore): EstimateChoice[] | null {
  const scale = store.estimateScale();
  if (scale === 'none') return null;
  const list = estimateOptions(scale).map((o) => ({ value: o.value, label: o.label }));
  return list.length ? list : null;
}

export const KIND_LIST: readonly string[] = ISSUE_KINDS;
export const PRIORITY_LIST: readonly string[] = PRIORITIES;

// ───────────────────────────── issues ─────────────────────────────

/** Recent comments and status changes of one issue, oldest first, at most ~3500 characters. */
export function issueDigest(store: TramaStore, issue: Issue): string {
  const rows: { at: string; line: string }[] = [];
  for (const c of store.commentsFor({ type: 'issue', id: issue.id })) {
    rows.push({ at: c.createdAt, line: `${dayStr(c.createdAt)} ${store.actorName(c.author)} commented: ${oneLine(c.body, 380)}` });
  }
  const events = store.eventsBySubject().get(`issue:${issue.id}`) ?? [];
  for (const e of events) {
    if (e.type !== 'issue.status_changed') continue;
    const to = String(e.data['to'] ?? '');
    const from = String(e.data['from'] ?? '');
    const label = (s: string) => ISSUE_STATUS_META[s as Issue['status']]?.label ?? s;
    rows.push({ at: e.at, line: `${dayStr(e.at)} ${store.actorName(e.actor)} moved status ${from ? `${label(from)} → ` : 'to '}${label(to)}` });
  }
  rows.sort((a, b) => (a.at < b.at ? -1 : 1));
  return boundedLines(rows.map((r) => r.line));
}

export function issuePromptData(store: TramaStore, issue: Issue): PromptIssue {
  return {
    key: issue.key,
    title: issue.title,
    body: issue.body,
    kind: ISSUE_KIND_META[issue.kind]?.label ?? issue.kind,
    status: ISSUE_STATUS_META[issue.status]?.label ?? issue.status,
    priority: PRIORITY_META[issue.priority]?.label ?? issue.priority,
    estimate: issue.estimate ?? null,
    assignee: issue.assigneeId ? store.getUser(issue.assigneeId)?.name : undefined,
    createdAt: dayStr(issue.createdAt),
    digest: issueDigest(store, issue),
  };
}

export interface TriageInputs {
  estimates: EstimateChoice[] | null;
  similar: PromptSimilar[];
}

/** Up to four finished issues ranked by word overlap with `issue`. */
export function triageInputs(store: TramaStore, issue: Issue): TriageInputs {
  const query = `${issue.title}\n${issue.body ?? ''}`;

  const finished = store
    .issues()
    .filter((i) => i.id !== issue.id && i.status === 'done' && !i.duplicateOfId)
    .sort((a, b) => ((a.completedAt ?? '') < (b.completedAt ?? '') ? 1 : -1));
  const similar = rankByOverlap(query, finished, (i) => `${i.title} ${i.title} ${i.body ?? ''}`, 4).map(
    ({ item: i }): PromptSimilar => ({
      key: i.key,
      title: oneLine(i.title, 120),
      kind: ISSUE_KIND_META[i.kind]?.label ?? i.kind,
      priority: PRIORITY_META[i.priority]?.label ?? i.priority,
      estimate: i.estimate ?? null,
      cycleDays: i.startedAt && i.completedAt ? Math.max(0, Math.round((daysBetween(i.startedAt, i.completedAt) + Number.EPSILON) * 10) / 10) : null,
    }),
  );
  return { estimates: estimateChoices(store), similar };
}

// ───────────────────────────── standup digest ─────────────────────────────

/** Workspace-wide facts for the standup digest: windows 24h / 7d, at-risk, overdue, waiting longest. */
export function digestData(store: TramaStore, info: MilestoneInfo): PromptDigest {
  const now = Date.now();
  const ageDays = (iso: string) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY));
  const within = (iso: string | undefined, days: number) => !!iso && now - new Date(iso).getTime() <= days * DAY;
  const issues = store.issues().filter((i) => !i.duplicateOfId);

  const last24h: string[] = [];
  const last7d: string[] = [];
  const push = (iso: string, line: string) => (within(iso, 1) ? last24h : last7d).push(line);
  for (const i of issues) {
    if (within(i.completedAt, 7) && i.status === 'done') push(i.completedAt!, `Done: ${i.key} ${oneLine(i.title, 90)}`);
    if (within(i.createdAt, 7)) push(i.createdAt, `New: ${i.key} ${oneLine(i.title, 90)}`);
  }
  for (const e of store.events()) {
    if (e.type !== 'issue.status_changed' || !within(e.at, 7)) continue;
    const issue = e.subject.type === 'issue' ? store.getIssue(e.subject.id) : undefined;
    if (issue) push(e.at, `${issue.key} moved to ${ISSUE_STATUS_META[issue.status]?.label ?? issue.status}`);
  }

  const atRisk: { rank: number; line: string }[] = [];
  for (const issue of issues) {
    if (issue.status !== 'in_progress' && issue.status !== 'in_review') continue;
    const age = ageDays(issue.updatedAt);
    if (age >= 10) atRisk.push({ rank: age, line: `${issue.key} ${oneLine(issue.title, 80)}: no update for ${age}d` });
  }
  atRisk.sort((a, b) => a.rank - b.rank);

  const overdue: string[] = [];
  for (const m of store.milestones()) {
    if (info.states().get(m.id) !== 'overdue') continue;
    const p = store.getProject(m.projectId);
    if (!p || p.status === 'completed' || p.status === 'canceled') continue;
    overdue.push(`${oneLine(p.name, 40)} › ${oneLine(m.name, 60)}: ${info.stats().get(m.id)?.percent ?? 0}% done, due ${m.targetDate ? dayStr(m.targetDate) : '?'}`);
  }

  const waiting = issues
    .filter((i) => i.status === 'todo' || i.status === 'in_progress' || i.status === 'in_review')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
    .slice(0, 5)
    .map((i) => `${i.key} ${oneLine(i.title, 80)}: ${ISSUE_STATUS_META[i.status].label.toLowerCase()}, untouched ${ageDays(i.updatedAt)}d`);
  for (const q of store.openInputRequests().slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)).slice(0, 3)) {
    const issue = q.issueId ? store.getIssue(q.issueId) : undefined;
    waiting.push(`Question${issue ? ` on ${issue.key}` : ''}: "${oneLine(q.question, 100)}" open ${ageDays(q.createdAt)}d`);
  }

  const cap = (xs: string[], n: number) => xs.slice(0, n).map((x) => clip(x, 220));
  return {
    today: dayStr(new Date().toISOString()),
    window: { last24h: cap(last24h, 12), last7d: cap(last7d, 12) },
    atRisk: cap(atRisk.map((x) => x.line), 8),
    overdueMilestones: cap(overdue, 8),
    waitingLongest: cap(waiting, 8),
    counts: {
      issuesOpen: issues.filter((i) => i.status !== 'done' && i.status !== 'canceled').length,
    },
  };
}
