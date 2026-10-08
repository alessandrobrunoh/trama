// Plain records the charts are computed from. Built once per model from the store; the board
// re-buckets them when the period changes, so nothing here depends on the selected range.
import {
  type Issue,
  type IssueKind,
  type IssueStatus,
  type NablaStore,
  type Priority,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';

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
  /** Status changes, oldest first. */
  changes: Change[];
}

export interface WsRec {
  id: string;
  key: string;
  title: string;
  created: number;
  shipped?: number;
  status: WorkstreamStatus;
  priority: Priority;
  team: string;
  teamId: string;
  accountableId?: string;
  projects: string[];
  criteria: { met: number; inProgress: number; total: number };
  changes: Change[];
}

export interface Timeline {
  now: number;
  /**
   * Status history is only reliable from this instant on: the store holds a window of the newest
   * events. `-Infinity` when nothing indicates events are missing. `Infinity` when there are none.
   */
  coverageStart: number;
  issues: IssueRec[];
  workstreams: WsRec[];
}

export const EMPTY_TIMELINE: Timeline = { now: 0, coverageStart: -Infinity, issues: [], workstreams: [] };

function changesOf(store: NablaStore, key: string, type: string): Change[] {
  const events = store.eventsBySubject().get(key) ?? [];
  return events
    .filter((e) => e.type === type)
    .flatMap((e) => {
      const at = Date.parse(e.at);
      const to = e.data['to'];
      const from = e.data['from'];
      if (Number.isNaN(at) || typeof to !== 'string') return [];
      return [{ at, to, from: typeof from === 'string' ? from : undefined }];
    })
    .sort((a, b) => a.at - b.at);
}

function coverage(store: NablaStore): number {
  const times = store.events().map((e) => Date.parse(e.at)).filter((t) => !Number.isNaN(t));
  if (!times.length) return Infinity;
  const oldest = Math.min(...times);
  const created = [
    ...store.issues().map((i) => Date.parse(i.createdAt)),
    ...store.workstreams().map((w) => Date.parse(w.createdAt)),
  ];
  // A record older than the oldest loaded event means its early history was cut off.
  return created.some((t) => t < oldest - 1000) ? oldest : -Infinity;
}

export function buildTimeline(
  store: NablaStore,
  workstreams: readonly Workstream[],
  issues: readonly Issue[],
  now: Date,
): Timeline {
  const ts = (iso: string | undefined): number => (iso ? Date.parse(iso) : NaN);
  return {
    now: now.getTime(),
    coverageStart: coverage(store),
    issues: issues
      .filter((i) => !Number.isNaN(ts(i.createdAt)))
      .map((i) => ({
        id: i.id,
        key: i.key,
        created: ts(i.createdAt),
        status: i.status,
        priority: i.priority,
        kind: i.kind,
        team: i.teamId ? (store.getTeam(i.teamId)?.name ?? 'Unknown team') : 'No team',
        teamId: i.teamId,
        assignee: i.assigneeId ? (store.getUser(i.assigneeId)?.name ?? 'Unknown') : 'Unassigned',
        assigneeId: i.assigneeId,
        changes: changesOf(store, `issue:${i.id}`, 'issue.status_changed'),
      })),
    workstreams: workstreams
      .filter((w) => !Number.isNaN(ts(w.createdAt)))
      .map((w) => {
        const shipped = ts(w.shippedAt);
        return {
          id: w.id,
          key: w.key,
          title: w.title,
          created: ts(w.createdAt),
          shipped: Number.isNaN(shipped) ? undefined : shipped,
          status: w.status,
          priority: w.priority,
          team: store.getTeam(w.ownerTeamId)?.name ?? 'Unknown team',
          teamId: w.ownerTeamId,
          accountableId: w.accountableUserId ?? undefined,
          projects: w.repositoryIds.map((id) => store.getRepository(id)?.fullName ?? 'Unknown project'),
          criteria: {
            met: w.acceptanceCriteria.filter((c) => c.state === 'met').length,
            inProgress: w.acceptanceCriteria.filter((c) => c.state === 'in_progress').length,
            total: w.acceptanceCriteria.length,
          },
          changes: changesOf(store, `workstream:${w.id}`, 'workstream.status_changed'),
        };
      }),
  };
}
