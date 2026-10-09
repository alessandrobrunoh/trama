// Counts derived from the loaded workspace. Shares are real ratios of those counts,
// never an estimated progress percentage.
import {
  ISSUE_KIND_META,
  ISSUE_KINDS,
  ISSUE_STATUS_META,
  ISSUE_STATUSES,
  PRIORITIES,
  PRIORITY_META,
  WORKSTREAM_STATUS_FLOW,
  WORKSTREAM_STATUS_META,
  isOverdue,
  type Artifact,
  type CriterionState,
  type Decision,
  type DomainEvent,
  type Issue,
  type IssueKind,
  type IssueStatus,
  type NablaStore,
  type Priority,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';
import {
  ARTIFACT_COLOR,
  CRITERION_COLOR,
  DECISION_COLOR,
  ISSUE_COLOR,
  KIND_FALLBACK,
  PRIORITY_COLOR,
  WS_COLOR,
} from './stats-colors';
import { buildTimeline, type Timeline } from './timeline';
import { buildWork, type WorkData } from './work';

export interface StatCard {
  label: string;
  value: string;
  hint?: string;
}

export interface DistRow {
  label: string;
  count: number;
  /** CSS colour, a design-token variable. */
  color: string;
}

export interface Distribution {
  title: string;
  total: number;
  rows: DistRow[];
}

export interface StatsModel {
  cards: StatCard[];
  distributions: Distribution[];
  /** Raw records the time-based charts are built from (re-bucketed per period by the board). */
  timeline?: Timeline;
  /** Issues with estimates and start/finish dates, plus milestones (Estimates & time, milestone table). */
  work?: WorkData;
}

export interface StatFact {
  label: string;
  value: string;
}

const isOpenWs = (w: Workstream): boolean => w.status !== 'shipped' && w.status !== 'canceled';
const isOpenIssue = (i: Issue): boolean => i.status !== 'done' && i.status !== 'canceled';
const isPr = (a: Artifact): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';
const isOpenPr = (a: Artifact): boolean => isPr(a) && (a.state === 'open' || a.state === 'draft');

export function workspaceStats(store: NablaStore, now = new Date()): StatsModel {
  const workstreams = store.workstreams();
  const issues = store.issues();
  const artifacts = store.artifacts();
  return assemble(store, {
    workstreams,
    issues,
    artifacts,
    decisions: store.decisions(),
    cards: scopeCards(store, workstreams, issues, artifacts, now),
    now,
  });
}

export function workstreamStats(store: NablaStore, workstreamId: string, now = new Date()): StatsModel {
  const ws = store.workstreams().find((w) => w.id === workstreamId);
  const workstreams = ws ? [ws] : [];
  const issues = store.issuesByWorkstream().get(workstreamId) ?? [];
  const artifacts = store.artifactsByWorkstream().get(workstreamId) ?? [];
  const decisions = store.decisionsByWorkstream().get(workstreamId) ?? [];
  const criteria = ws?.acceptanceCriteria ?? [];
  const met = criteria.filter((c) => c.state === 'met').length;
  const openInputs = (store.inputRequestsByWorkstream().get(workstreamId) ?? []).filter((r) => r.state === 'open').length;
  const age = ws ? daysSince(ws.createdAt, now.getTime()) : undefined;
  return assemble(store, {
    workstreams,
    issues,
    artifacts,
    decisions,
    cards: [
      { label: 'Open issues', value: String(issues.filter(isOpenIssue).length), hint: ageHint(issues.filter(isOpenIssue), now) },
      { label: 'Done issues', value: String(issues.filter((i) => i.status === 'done').length) },
      { label: 'Criteria met', value: `${met}/${criteria.length}` },
      { label: 'Open PRs', value: String(artifacts.filter(isOpenPr).length) },
      { label: 'Merged PRs', value: String(artifacts.filter((a) => isPr(a) && a.state === 'merged').length) },
      { label: 'Proposed decisions', value: String(decisions.filter((d) => d.status === 'proposed').length) },
      { label: 'Open questions', value: String(openInputs) },
      {
        label: 'Age',
        value: age == null ? '—' : formatDays(age),
        hint: ws?.targetDate ? (isOverdue(ws.targetDate) && isOpenWs(ws) ? `Target ${ws.targetDate.slice(0, 10)} is overdue` : `Target ${ws.targetDate.slice(0, 10)}`) : undefined,
      },
    ],
    now,
  });
}

export function repositoryStats(store: NablaStore, repositoryId: string, now = new Date()): StatsModel {
  const workstreams = store.workstreamsByRepository().get(repositoryId) ?? [];
  const wsIds = new Set(workstreams.map((w) => w.id));
  const issues = store.issues().filter((i) => i.workstreamIds.some((id) => wsIds.has(id)));
  const artifacts = store.artifactsByRepository().get(repositoryId) ?? [];
  const decisions = store.decisions().filter(
    (d) =>
      (d.originWorkstreamId != null && wsIds.has(d.originWorkstreamId)) ||
      d.relatedWorkstreamIds.some((id) => wsIds.has(id)),
  );
  return assemble(store, {
    workstreams,
    issues,
    artifacts,
    decisions,
    cards: scopeCards(store, workstreams, issues, artifacts, now),
    now,
  });
}

/** Compact counts for the issues list. The full breakdown lives on the statistics page. */
export function issuesStrip(store: NablaStore, now = new Date()): StatsModel {
  const issues = store.issues();
  const count = (s: IssueStatus) => issues.filter((i) => i.status === s).length;
  return {
    cards: [
      { label: 'open', value: String(issues.filter(isOpenIssue).length) },
      { label: 'in progress', value: String(count('in_progress')) },
      { label: 'in review', value: String(count('in_review')) },
      { label: 'done', value: String(count('done')) },
      { label: 'unassigned', value: String(issues.filter((i) => isOpenIssue(i) && !i.assigneeId).length) },
    ],
    distributions: [issueStatusDist(issues)].filter((d): d is Distribution => !!d),
    timeline: buildTimeline(store, [], issues, now),
  };
}

export function issueFacts(store: NablaStore, issueId: string, now = new Date()): StatFact[] {
  const issue = store.issues().find((i) => i.id === issueId);
  if (!issue) return [];
  const comments = store.commentCountFor({ type: 'issue', id: issue.id });
  const events = store.eventsBySubject().get(`issue:${issue.id}`) ?? [];
  const statusChanges = events.filter((e) => e.type === 'issue.status_changed');
  const doneAt = [...statusChanges].reverse().find((e) => eventTo(e) === 'done')?.at;
  const age = daysSince(issue.createdAt, now.getTime());
  const idle = daysSince(issue.updatedAt, now.getTime());
  const facts: StatFact[] = [
    { label: 'Age', value: age == null ? '—' : formatDays(age) },
    { label: 'Last update', value: idle == null ? '—' : idle === 0 ? 'today' : `${formatDays(idle)} ago` },
    { label: 'Workstreams', value: String(issue.workstreamIds.length) },
    { label: 'Comments', value: String(comments) },
    { label: 'Status changes', value: String(statusChanges.length) },
  ];
  if (doneAt && age != null) {
    const span = daysSince(issue.createdAt, Date.parse(doneAt));
    if (span != null) facts.push({ label: 'Time to done', value: formatDays(span) });
  }
  return facts;
}

function scopeCards(
  store: NablaStore,
  workstreams: readonly Workstream[],
  issues: readonly Issue[],
  artifacts: readonly Artifact[],
  now: Date,
): StatCard[] {
  const criteria = workstreams.flatMap((w) => w.acceptanceCriteria);
  const met = criteria.filter((c) => c.state === 'met').length;
  const openIssues = issues.filter(isOpenIssue);
  const openInputs = workstreams.reduce(
    (n, w) => n + (store.inputRequestsByWorkstream().get(w.id) ?? []).filter((r) => r.state === 'open').length,
    0,
  );
  return [
    { label: 'Open workstreams', value: String(workstreams.filter(isOpenWs).length) },
    { label: 'Blocked', value: String(workstreams.filter((w) => w.status === 'blocked').length) },
    { label: 'Needs input', value: String(workstreams.filter((w) => w.status === 'needs_input').length), hint: openInputs ? `${openInputs} open questions` : undefined },
    { label: 'Shipped', value: String(workstreams.filter((w) => w.status === 'shipped').length) },
    { label: 'Open issues', value: String(openIssues.length), hint: ageHint(openIssues, now) },
    { label: 'Done issues', value: String(issues.filter((i) => i.status === 'done').length) },
    { label: 'Open PRs', value: String(artifacts.filter(isOpenPr).length) },
    { label: 'Criteria met', value: `${met}/${criteria.length}` },
  ];
}

function assemble(
  store: NablaStore,
  input: {
    workstreams: readonly Workstream[];
    issues: readonly Issue[];
    artifacts: readonly Artifact[];
    decisions: readonly Decision[];
    cards: StatCard[];
    now: Date;
  },
): StatsModel {
  const distributions = [
    wsStatusDist(input.workstreams),
    issueStatusDist(input.issues),
    issueKindDist(input.issues),
    priorityDist(input.issues.map((i) => i.priority), 'Issue priority'),
    priorityDist(input.workstreams.map((w) => w.priority), 'Workstream priority'),
    criteriaDist(input.workstreams),
    artifactDist(input.artifacts),
    decisionDist(input.decisions),
  ].filter((d): d is Distribution => !!d);

  return {
    cards: input.cards,
    distributions,
    timeline: buildTimeline(store, input.workstreams, input.issues, input.now),
    work: buildWork(store, input.issues, input.workstreams),
  };
}

function wsStatusDist(workstreams: readonly Workstream[]): Distribution | undefined {
  return dist(
    'Workstream status',
    countBy(workstreams.map((w) => w.status)),
    WORKSTREAM_STATUS_FLOW,
    (s) => WORKSTREAM_STATUS_META[s].label,
    (s) => WS_COLOR[s],
  );
}

function issueStatusDist(issues: readonly Issue[]): Distribution | undefined {
  return dist('Issue status', countBy(issues.map((i) => i.status)), ISSUE_STATUSES, (s) => ISSUE_STATUS_META[s].label, (s) => ISSUE_COLOR[s]);
}

function issueKindDist(issues: readonly Issue[]): Distribution | undefined {
  return dist('Issue type', countBy(issues.map((i) => i.kind)), ISSUE_KINDS, (s) => ISSUE_KIND_META[s].label, (s) => KIND_FALLBACK[s]);
}

function priorityDist(values: readonly Priority[], title: string): Distribution | undefined {
  return dist(title, countBy(values), PRIORITIES, (s) => PRIORITY_META[s].label, (s) => PRIORITY_COLOR[s]);
}

function criteriaDist(workstreams: readonly Workstream[]): Distribution | undefined {
  const order: CriterionState[] = ['pending', 'in_progress', 'met'];
  const labels: Record<CriterionState, string> = { pending: 'Pending', in_progress: 'In progress', met: 'Met' };
  return dist(
    'Acceptance criteria',
    countBy(workstreams.flatMap((w) => w.acceptanceCriteria.map((c) => c.state))),
    order,
    (s) => labels[s],
    (s) => CRITERION_COLOR[s],
  );
}

function artifactDist(artifacts: readonly Artifact[]): Distribution | undefined {
  const order = [...new Set(artifacts.map((a) => a.state))];
  return dist(
    'Artifacts',
    countBy(artifacts.map((a) => a.state)),
    order,
    (s) => s.replace(/_/g, ' '),
    (s) => ARTIFACT_COLOR[s] ?? 'var(--status-draft)',
  );
}

function decisionDist(decisions: readonly Decision[]): Distribution | undefined {
  const order = ['proposed', 'accepted', 'superseded', 'rejected'] as const;
  const labels: Record<(typeof order)[number], string> = {
    proposed: 'Proposed',
    accepted: 'Accepted',
    superseded: 'Superseded',
    rejected: 'Rejected',
  };
  return dist('Decisions', countBy(decisions.map((d) => d.status)), order, (s) => labels[s], (s) => DECISION_COLOR[s]);
}

function dist<T extends string>(
  title: string,
  counts: Map<string, number>,
  order: readonly T[],
  label: (key: T) => string,
  color: (key: T) => string,
): Distribution | undefined {
  const rows = order
    .map((key) => ({ label: label(key), count: counts.get(key) ?? 0, color: color(key) }))
    .filter((row) => row.count > 0);
  const total = rows.reduce((n, row) => n + row.count, 0);
  if (!total) return undefined;
  return { title, total, rows };
}

function countBy(values: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return map;
}

function daysSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((now - t) / 86_400_000));
}

function formatDays(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function ageHint(open: readonly Issue[], now: Date): string | undefined {
  const ages = open.flatMap((i) => {
    const d = daysSince(i.createdAt, now.getTime());
    return d == null ? [] : [d];
  });
  const mid = median(ages);
  return mid == null ? undefined : `median age ${formatDays(mid)}`;
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function eventTo(event: DomainEvent): string | undefined {
  const to = event.data['to'];
  return typeof to === 'string' ? to : undefined;
}
