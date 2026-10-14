// Plain issue records used by the statistics charts.
import { type Issue, type IssueKind, type IssueStatus, type TramaStore, type Priority } from '../../core';

export interface Change {
  at: number;
  from?: string;
  to: string;
}

export interface IssueRec {
  id: string;
  key: string;
  created: number;
  status: IssueStatus;
  priority: Priority;
  kind: IssueKind;
  team: string;
  teamId?: string;
  assignee: string;
  assigneeId?: string;
  changes: Change[];
}

export interface Timeline {
  now: number;
  /** Status history is only reliable from this instant on when loaded events are truncated. */
  coverageStart: number;
  issues: IssueRec[];
}

export const EMPTY_TIMELINE: Timeline = { now: 0, coverageStart: -Infinity, issues: [] };

function changesOf(store: TramaStore, key: string): Change[] {
  const events = store.eventsBySubject().get(key) ?? [];
  return events
    .filter((e) => e.type === 'issue.status_changed')
    .flatMap((e) => {
      const at = Date.parse(e.at);
      const to = e.data['to'];
      const from = e.data['from'];
      return Number.isNaN(at) || typeof to !== 'string' ? [] : [{ at, to, from: typeof from === 'string' ? from : undefined }];
    })
    .sort((a, b) => a.at - b.at);
}

function coverage(store: TramaStore): number {
  const times = store.events().map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
  if (!times.length) return Infinity;
  const oldest = Math.min(...times);
  return store.issues().some((i) => Date.parse(i.createdAt) < oldest - 1000) ? oldest : -Infinity;
}

export function buildTimeline(store: TramaStore, issues: readonly Issue[], now: Date): Timeline {
  const timestamp = (iso: string): number => Date.parse(iso);
  return {
    now: now.getTime(),
    coverageStart: coverage(store),
    issues: issues
      .filter((i) => !Number.isNaN(timestamp(i.createdAt)))
      .map((i) => ({
        id: i.id,
        key: i.key,
        created: timestamp(i.createdAt),
        status: i.status,
        priority: i.priority,
        kind: i.kind,
        team: i.teamId ? (store.getTeam(i.teamId)?.name ?? 'Unknown team') : 'No team',
        teamId: i.teamId,
        assignee: i.assigneeId ? (store.getUser(i.assigneeId)?.name ?? 'Unknown') : 'Unassigned',
        assigneeId: i.assigneeId,
        changes: changesOf(store, `issue:${i.id}`),
      })),
  };
}
