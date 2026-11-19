// Issue- and delivery-level counts derived from the loaded workspace.
import {
  ISSUE_KIND_META,
  ISSUE_KINDS,
  ISSUE_STATUS_META,
  ISSUE_STATUSES,
  PRIORITIES,
  PRIORITY_META,
  type Artifact,
  type DomainEvent,
  type Issue,
  type IssueStatus,
  type TramaStore,
  type Priority,
} from '../../core';
import { ARTIFACT_COLOR, ISSUE_COLOR, KIND_FALLBACK, PRIORITY_COLOR } from './stats-colors';
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
  /** Raw issue records used by the time-based charts. */
  timeline?: Timeline;
  /** Issues with estimates and start/finish dates. */
  work?: WorkData;
}

export interface StatFact {
  label: string;
  value: string;
}

const isOpenIssue = (i: Issue): boolean => i.status !== 'done' && i.status !== 'canceled';
const isPr = (a: Artifact): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';
const isOpenPr = (a: Artifact): boolean => isPr(a) && (a.state === 'open' || a.state === 'draft');

export function workspaceStats(store: TramaStore, now = new Date()): StatsModel {
  const issues = store.issues();
  const artifacts = store.artifacts();
  return assemble(store, issues, artifacts, [
    { label: 'Open tasks', value: String(issues.filter(isOpenIssue).length), hint: ageHint(issues.filter(isOpenIssue), now) },
    { label: 'Done tasks', value: String(issues.filter((i) => i.status === 'done').length) },
    { label: 'Backlog', value: String(issues.filter((i) => i.status === 'backlog').length) },
    { label: 'Open PRs', value: String(artifacts.filter(isOpenPr).length) },
  ], now);
}

/** Compact counts for the issues list. The full breakdown lives on the statistics page. */
export function issuesStrip(store: TramaStore, now = new Date()): StatsModel {
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
    timeline: buildTimeline(store, issues, now),
  };
}

export function issueFacts(store: TramaStore, issueId: string, now = new Date()): StatFact[] {
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
    { label: 'Comments', value: String(comments) },
    { label: 'Status changes', value: String(statusChanges.length) },
  ];
  if (doneAt && age != null) {
    const span = daysSince(issue.createdAt, Date.parse(doneAt));
    if (span != null) facts.push({ label: 'Time to done', value: formatDays(span) });
  }
  return facts;
}

function assemble(
  store: TramaStore,
  issues: readonly Issue[],
  artifacts: readonly Artifact[],
  cards: StatCard[],
  now: Date,
): StatsModel {
  return {
    cards,
    distributions: [
      issueStatusDist(issues),
      issueKindDist(issues),
      priorityDist(issues.map((i) => i.priority), 'Task priority'),
      artifactDist(artifacts),
    ].filter((d): d is Distribution => !!d),
    timeline: buildTimeline(store, issues, now),
    work: buildWork(store, issues),
  };
}

function issueStatusDist(issues: readonly Issue[]): Distribution | undefined {
  return dist('Task status', countBy(issues.map((i) => i.status)), ISSUE_STATUSES, (s) => ISSUE_STATUS_META[s].label, (s) => ISSUE_COLOR[s]);
}

function issueKindDist(issues: readonly Issue[]): Distribution | undefined {
  return dist('Task type', countBy(issues.map((i) => i.kind)), ISSUE_KINDS, (s) => ISSUE_KIND_META[s].label, (s) => KIND_FALLBACK[s]);
}

function priorityDist(values: readonly Priority[], title: string): Distribution | undefined {
  return dist(title, countBy(values), PRIORITIES, (s) => PRIORITY_META[s].label, (s) => PRIORITY_COLOR[s]);
}

function artifactDist(artifacts: readonly Artifact[]): Distribution | undefined {
  const order = [...new Set(artifacts.map((a) => a.state))];
  return dist('Artifacts', countBy(artifacts.map((a) => a.state)), order, (s) => s.replace(/_/g, ' '), (s) => ARTIFACT_COLOR[s] ?? 'var(--status-draft)');
}

function dist<T extends string>(
  title: string,
  counts: Map<string, number>,
  order: readonly T[],
  label: (key: T) => string,
  color: (key: T) => string,
): Distribution | undefined {
  const rows = order.map((key) => ({ label: label(key), count: counts.get(key) ?? 0, color: color(key) })).filter((row) => row.count > 0);
  const total = rows.reduce((n, row) => n + row.count, 0);
  return total ? { title, total, rows } : undefined;
}

function countBy(values: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
  return map;
}

function daysSince(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.round((now - t) / 86_400_000));
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
  if (!ages.length) return undefined;
  const sorted = [...ages].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  return `median age ${formatDays(median)}`;
}

function eventTo(event: DomainEvent): string | undefined {
  const to = event.data['to'];
  return typeof to === 'string' ? to : undefined;
}
