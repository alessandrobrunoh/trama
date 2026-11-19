// The "My tasks" tab of the Inbox: which of my tasks sit in which group. Pure functions, no store.
//
//   In progress   In progress or In review, with recent activity
//   Idle          In progress or In review, but nothing has happened for N days (see flow-stats)
//   Up next       Todo
//   Backlog       Backlog and drafts
//   Done / Canceled   only when "Show closed" is on
import type { Issue, IssueStatus } from '../../core';
import { DAY } from '../stats/flow-stats';

export type TaskGroupId = 'in-progress' | 'idle' | 'up-next' | 'backlog' | 'done' | 'canceled';

export interface TaskGroup {
  id: TaskGroupId;
  label: string;
  /** One plain sentence under the group name. */
  hint: string;
  /** Status glyph shown next to the name. */
  status: IssueStatus;
  items: Issue[];
}

const GROUPS: readonly Omit<TaskGroup, 'items'>[] = [
  { id: 'in-progress', label: 'In progress', hint: 'Being worked on or in review', status: 'in_progress' },
  { id: 'idle', label: 'Idle', hint: 'Started, but nothing has happened for a while', status: 'in_progress' },
  { id: 'up-next', label: 'Up next', hint: 'Todo, ready to pick up', status: 'todo' },
  { id: 'backlog', label: 'Backlog', hint: 'Not planned yet', status: 'backlog' },
  { id: 'done', label: 'Done', hint: 'Completed', status: 'done' },
  { id: 'canceled', label: 'Canceled', hint: 'Dropped', status: 'canceled' },
];

export interface GroupOptions {
  showClosed: boolean;
  now: number;
  idleDays: number;
  /** When something last happened on the task (see `activityLookup`). */
  activityAt: (issue: Issue) => number;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const rank = (p: string): number => PRIORITY_RANK[p] ?? 5;

export const isClosed = (i: Issue): boolean => i.status === 'done' || i.status === 'canceled';

/** The group a task belongs to. */
export function groupOf(issue: Issue, o: Pick<GroupOptions, 'now' | 'idleDays' | 'activityAt'>): TaskGroupId {
  switch (issue.status) {
    case 'in_progress':
    case 'in_review':
      return o.now - o.activityAt(issue) >= o.idleDays * DAY ? 'idle' : 'in-progress';
    case 'todo':
      return 'up-next';
    case 'done':
      return 'done';
    case 'canceled':
      return 'canceled';
    default:
      return 'backlog';
  }
}

/** Non-empty groups in display order. Within a group: highest priority first, then most recently updated. */
export function groupMyTasks(issues: readonly Issue[], o: GroupOptions): TaskGroup[] {
  const byGroup = new Map<TaskGroupId, Issue[]>();
  for (const issue of issues) {
    const id = groupOf(issue, o);
    if (!o.showClosed && (id === 'done' || id === 'canceled')) continue;
    byGroup.set(id, [...(byGroup.get(id) ?? []), issue]);
  }
  return GROUPS.flatMap((g) => {
    const items = byGroup.get(g.id);
    if (!items?.length) return [];
    // The idle group lists the longest-quiet task first; the others by priority.
    items.sort((a, b) =>
      g.id === 'idle'
        ? o.activityAt(a) - o.activityAt(b)
        : rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt),
    );
    return [{ ...g, items }];
  });
}

/** Open tasks (not done, not canceled) in a list. */
export const countOpen = (issues: readonly Issue[]): number => issues.filter((i) => !isClosed(i)).length;
