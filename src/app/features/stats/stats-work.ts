// Work numbers: what is open right now, how old it is, what has gone stale, how far subtasks are.
// A snapshot of today, so none of it depends on the period. Stale tasks never enter an average.
import type { Issue } from '../../core';
import { OPEN_STATUSES, isRunning, median } from './flow-stats';
import { DAY, toMs } from './stats-range';

export const isOpen = (i: Issue): boolean => (OPEN_STATUSES as readonly string[]).includes(i.status);

export interface Slice {
  key: string;
  label: string;
  count: number;
  /** Sum of the estimates of those tasks. */
  points: number;
}

/**
 * Open tasks grouped by one or more keys each (a task with two labels counts under both). Biggest group first;
 * tasks without any key are listed last under `emptyLabel`.
 */
export function openBreakdown(
  issues: readonly Issue[],
  keysOf: (i: Issue) => readonly string[],
  labelOf: (key: string) => string,
  emptyLabel: string,
): Slice[] {
  const rows = new Map<string, Slice>();
  for (const i of issues) {
    if (!isOpen(i)) continue;
    const keys = keysOf(i);
    for (const key of keys.length ? keys : ['']) {
      const row = rows.get(key) ?? { key: key || 'none', label: key ? labelOf(key) : emptyLabel, count: 0, points: 0 };
      row.count += 1;
      row.points += i.estimate ?? 0;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(
    (a, b) => Number(a.key === 'none') - Number(b.key === 'none') || b.count - a.count || a.label.localeCompare(b.label),
  );
}

// ───────────────────────────── age and stale ─────────────────────────────

export interface Stale {
  issue: Issue;
  /** Time since the last activity, in ms. */
  idleMs: number;
}

/**
 * Tasks in In progress or In review that nothing has touched for `idleDays`, longest idle first. Todo and backlog
 * tasks are waiting by design and are never called stale.
 */
export function staleTasks(
  issues: readonly Issue[],
  now: number,
  idleDays: number,
  activityAt: (issue: Issue) => number,
): Stale[] {
  return issues
    .filter(isRunning)
    .map((issue) => ({ issue, idleMs: Math.max(0, now - activityAt(issue)) }))
    .filter((s) => s.idleMs >= idleDays * DAY)
    .sort((a, b) => b.idleMs - a.idleMs);
}

/** Days since a task was created. */
export function ageDays(i: Issue, now: number): number {
  return Math.max(0, (now - (toMs(i.createdAt) ?? now)) / DAY);
}

export const AGE_BINS: readonly { label: string; max: number }[] = [
  { label: '<1w', max: 7 },
  { label: '1–2w', max: 14 },
  { label: '2–4w', max: 28 },
  { label: '1–2mo', max: 60 },
  { label: '2–3mo', max: 90 },
  { label: '3mo+', max: Infinity },
];

export interface AgeBucket {
  label: string;
  /** Open tasks of this age that are not stale. */
  fresh: number;
  /** Stale tasks of this age. */
  stale: number;
}

/** Open tasks by how long ago they were created, stale ones counted apart. */
export function agingBuckets(open: readonly Issue[], now: number, staleIds: ReadonlySet<string>): AgeBucket[] {
  const out: AgeBucket[] = AGE_BINS.map((b) => ({ label: b.label, fresh: 0, stale: 0 }));
  for (const i of open) {
    const age = ageDays(i, now);
    const k = Math.max(0, AGE_BINS.findIndex((b) => age < b.max));
    if (staleIds.has(i.id)) out[k].stale += 1;
    else out[k].fresh += 1;
  }
  return out;
}

/** Median age in days of the open tasks that are not stale; undefined without any. */
export function medianOpenAge(open: readonly Issue[], now: number, staleIds: ReadonlySet<string>): number | undefined {
  return median(open.filter((i) => !staleIds.has(i.id)).map((i) => ageDays(i, now)));
}

// ───────────────────────────── subtasks ─────────────────────────────

export interface SubtaskProgress {
  parent: Issue;
  /** Subtasks at every depth, canceled ones left out. */
  total: number;
  done: number;
}

/** Parents with subtasks and how many of those (at any depth) are done, the ones with most work left first. */
export function subtaskProgress(issues: readonly Issue[]): SubtaskProgress[] {
  const children = new Map<string, Issue[]>();
  for (const i of issues) {
    if (!i.parentId || i.status === 'canceled') continue;
    children.set(i.parentId, [...(children.get(i.parentId) ?? []), i]);
  }
  const byId = new Map(issues.map((i) => [i.id, i] as const));
  const count = (id: string, seen: Set<string>): { total: number; done: number } => {
    if (seen.has(id)) return { total: 0, done: 0 };
    seen.add(id);
    let total = 0;
    let done = 0;
    for (const c of children.get(id) ?? []) {
      total += 1;
      if (c.status === 'done') done += 1;
      const inner = count(c.id, seen);
      total += inner.total;
      done += inner.done;
    }
    return { total, done };
  };
  const rows: SubtaskProgress[] = [];
  for (const [parentId] of children) {
    const parent = byId.get(parentId);
    if (!parent || parent.status === 'canceled') continue;
    const c = count(parentId, new Set());
    if (c.total) rows.push({ parent, ...c });
  }
  return rows.sort((a, b) => b.total - b.done - (a.total - a.done) || b.total - a.total);
}

/** Share (0–100) of all subtasks that are done; undefined when nothing has a parent. */
export function subtaskDonePct(issues: readonly Issue[]): { pct: number; done: number; total: number } | undefined {
  const subs = issues.filter((i) => i.parentId && i.status !== 'canceled');
  if (!subs.length) return undefined;
  const done = subs.filter((i) => i.status === 'done').length;
  return { pct: Math.round((done / subs.length) * 100), done, total: subs.length };
}
