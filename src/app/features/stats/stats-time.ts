// Time numbers: the time the signed-in person tracked with the timer, and how it compares with estimates.
// Actual time comes only from finished timer entries, never from how long a task sat in a status. A timer that is
// still running has no length yet and is left out, so a forgotten timer cannot inflate anything.
import { addDays, format, startOfDay } from 'date-fns';
import type { Issue } from '../../core';
import type { TimeEntry } from '../../core/api/api.types';
import { PACE_BAND, REF_MIN, entryMs, median } from './flow-stats';
import { isCompleted } from './stats-flow';
import { bucketIndex, inRange, toMs, type Bucket, type Range } from './stats-range';

export interface Span {
  start: number;
  end: number;
  issueId: string | null;
  projectId: string | null;
}

/**
 * Finished entries of one person as spans. `userId` null keeps every entry the API returned (they are the signed-in
 * person's own already). `projectOf` resolves the project of an entry that has none of its own.
 */
export function mySpans(
  entries: readonly TimeEntry[],
  userId: string | null,
  projectOf: (e: TimeEntry) => string | null = (e) => e.projectId,
): Span[] {
  const out: Span[] = [];
  for (const e of entries) {
    if (userId && e.userId !== userId) continue;
    if (entryMs(e) === undefined) continue;
    out.push({ start: toMs(e.startedAt)!, end: toMs(e.endedAt)!, issueId: e.issueId, projectId: projectOf(e) });
  }
  return out;
}

const overlap = (s: Span, r: Range): number => Math.max(0, Math.min(s.end, r.to) - Math.max(s.start, r.from));

export const totalMs = (spans: readonly Span[], range: Range): number => spans.reduce((n, s) => n + overlap(s, range), 0);

/** Tracked ms in each bucket; a span crossing a bucket edge is split. */
export function msPerBucket(spans: readonly Span[], items: readonly Bucket[]): number[] {
  const out = new Array<number>(items.length).fill(0);
  for (const s of spans) {
    for (let k = 0; k < items.length; k++) out[k] += overlap(s, items[k]);
  }
  return out;
}

/** Tracked ms per key (project, label, task…) inside `range`, biggest first. A span with several keys counts under each. */
export function msByKey(spans: readonly Span[], range: Range, keysOf: (s: Span) => readonly string[]): { key: string; ms: number }[] {
  const out = new Map<string, number>();
  for (const s of spans) {
    const ms = overlap(s, range);
    if (!ms) continue;
    for (const key of keysOf(s)) out.set(key, (out.get(key) ?? 0) + ms);
  }
  return [...out.entries()].map(([key, ms]) => ({ key, ms })).sort((a, b) => b.ms - a.ms);
}

/** Calls `visit` for every piece of [start, end) that lies inside one local hour or one local day. */
function slices(start: number, end: number, unit: 'hour' | 'day', visit: (from: number, to: number) => void): void {
  let t = start;
  while (t < end) {
    const d = new Date(t);
    const next = unit === 'hour' ? d.setMinutes(60, 0, 0) : addDays(startOfDay(d), 1).getTime();
    const to = Math.min(end, next > t ? next : end);
    visit(t, to);
    t = to;
  }
}

export interface DaySummary {
  /** Local days that have tracked time. */
  activeDays: number;
  longestMs: number;
  /** Tracked ms per local day, keyed `yyyy-MM-dd`. */
  perDay: Map<string, number>;
}

export function daySummary(spans: readonly Span[], range: Range): DaySummary {
  const perDay = new Map<string, number>();
  for (const s of spans) {
    const from = Math.max(s.start, range.from);
    const to = Math.min(s.end, range.to);
    slices(from, to, 'day', (a, b) => {
      const key = format(a, 'yyyy-MM-dd');
      perDay.set(key, (perDay.get(key) ?? 0) + (b - a));
    });
  }
  return { activeDays: perDay.size, longestMs: Math.max(0, ...perDay.values()), perDay };
}

/**
 * Tracked ms for every weekday (row 0 is the first day of the week) and hour of the day (column 0 is midnight),
 * in local time. Each entry is spread over the hours it covers.
 */
export function weekdayHour(spans: readonly Span[], range: Range, weekStartsOn: 0 | 1 | 6 = 1): number[][] {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const s of spans) {
    const from = Math.max(s.start, range.from);
    const to = Math.min(s.end, range.to);
    slices(from, to, 'hour', (a, b) => {
      const d = new Date(a);
      grid[(d.getDay() - weekStartsOn + 7) % 7][d.getHours()] += b - a;
    });
  }
  return grid;
}

// ───────────────────────────── estimate against tracked time ─────────────────────────────

export interface PacedTask {
  issue: Issue;
  trackedMs: number;
  /** Estimate x the usual time per point. */
  expectedMs: number;
  /** trackedMs / expectedMs: 2 means twice as long as usual for that estimate. */
  factor: number;
}

export interface Paced {
  /** Completed tasks with an estimate and tracked time: the only ones compared. */
  sample: number;
  /** Median tracked ms per point; undefined below REF_MIN tasks. */
  paceMsPerPoint?: number;
  tasks: PacedTask[];
}

/** Completed tasks that have both an estimate and tracked time, each against the person's usual time per point. */
export function pacedTasks(issues: readonly Issue[], tracked: ReadonlyMap<string, number>): Paced {
  const sample = issues.filter((i) => isCompleted(i) && (i.estimate ?? 0) > 0 && (tracked.get(i.id) ?? 0) > 0);
  const pace = sample.length >= REF_MIN ? median(sample.map((i) => tracked.get(i.id)! / i.estimate!)) : undefined;
  if (pace === undefined || pace <= 0) return { sample: sample.length, tasks: [] };
  const tasks = sample.map((issue) => {
    const trackedMs = tracked.get(issue.id)!;
    const expectedMs = pace * issue.estimate!;
    return { issue, trackedMs, expectedMs, factor: trackedMs / expectedMs };
  });
  return { sample: sample.length, paceMsPerPoint: pace, tasks };
}

/** Share (0–100) of the tasks done in each bucket that took between half and PACE_BAND times the usual time; null without a task. */
export function accuracyPerBucket(tasks: readonly PacedTask[], items: readonly Bucket[]): (number | null)[] {
  const ok = new Array<number>(items.length).fill(0);
  const all = new Array<number>(items.length).fill(0);
  for (const t of tasks) {
    const k = bucketIndex(items, toMs(t.issue.completedAt));
    if (k < 0) continue;
    all[k] += 1;
    if (t.factor >= 1 / PACE_BAND && t.factor <= PACE_BAND) ok[k] += 1;
  }
  return all.map((n, k) => (n ? Math.round((ok[k] / n) * 100) : null));
}

/** The tasks that took longest compared with their estimate. */
export const biggestOverruns = (tasks: readonly PacedTask[], n = 5): PacedTask[] =>
  tasks.filter((t) => t.factor > 1).sort((a, b) => b.factor - a.factor).slice(0, n);

/** Tasks completed inside `range` only. */
export const pacedIn = (tasks: readonly PacedTask[], range: Range): PacedTask[] =>
  tasks.filter((t) => inRange(toMs(t.issue.completedAt), range));
