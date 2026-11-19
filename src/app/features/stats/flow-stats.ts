// The numbers behind the statistics page, the Inbox week summary and the task time card.
// Pure functions over tasks and time entries: nothing here reads a store.
//
// Definitions (the page repeats them in plain words):
//  - completed        = status Done with a `completedAt` date; canceled tasks never count.
//  - time spent       = tracked time: the sum of finished time entries (endedAt - startedAt) linked to the task.
//                       Wall-clock time spent in a status is never used as time spent: a task left in
//                       In progress for days says nothing about how long the work took.
//  - time to finish   = `startedAt` -> `completedAt` of COMPLETED tasks only, summarised with the median, so one
//                       forgotten task cannot move it. It includes waiting time and is shown as such.
//  - idle             = a task in In progress / In review with no activity for N days. Activity is the latest of the task's
//                       last update, its events, its linked pull requests and any tracked time. Idle tasks are
//                       listed on their own and are never averaged into anything.
//  - hours per point  = tracked time / estimate, for completed tasks that have both.
//  - pace             = median of those, needs REF_MIN tasks.
//  - consistent       = a completed task whose time per point is within 0.5x-2x of the pace.
import { format } from 'date-fns';
import type { Issue } from '../../core';
import type { TimeEntry } from '../../core/api/api.types';
import type { Period } from './insights';

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;
/** Fewest finished tasks before a "typical" value is shown. */
export const REF_MIN = 3;
/** A task is consistent when its time per point is within 1/PACE_BAND ... PACE_BAND times the pace. */
export const PACE_BAND = 2;
export const IDLE_CHOICES = [3, 7, 14, 30] as const;
export const DEFAULT_IDLE_DAYS = 7;

const ms = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

// ───────────────────────────── basics ─────────────────────────────

export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

export const isDone = (i: Issue): boolean => i.status === 'done' && ms(i.completedAt) !== undefined;
export const isRunning = (i: Issue): boolean => i.status === 'in_progress' || i.status === 'in_review';

export interface Range {
  from: number;
  to: number;
}

const within = (t: number | undefined, r: Range): boolean => t !== undefined && t >= r.from && t < r.to;

export const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90 };
const PERIOD_WEEKS: Record<Period, number> = { '7d': 4, '30d': 5, '90d': 13 };

/** The period ending now and the one before it, for "vs previous" deltas. */
export function periodRanges(period: Period, now: number): { cur: Range; prev: Range } {
  const len = PERIOD_DAYS[period] * DAY;
  const to = now + 1;
  return { cur: { from: to - len, to }, prev: { from: to - 2 * len, to: to - len } };
}

// ───────────────────────────── tracked time ─────────────────────────────

/** Length of a finished entry in ms; a running timer (no end) or a broken one has no length yet. */
export function entryMs(e: TimeEntry): number | undefined {
  const start = ms(e.startedAt);
  const end = ms(e.endedAt ?? undefined);
  if (start === undefined || end === undefined || end < start) return undefined;
  return end - start;
}

/** Finished tracked time per task id. Running timers are left out: a timer that was forgotten would inflate it. */
export function trackedByIssue(entries: readonly TimeEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entries) {
    const len = entryMs(e);
    if (!e.issueId || len === undefined) continue;
    out.set(e.issueId, (out.get(e.issueId) ?? 0) + len);
  }
  return out;
}

/** Finished tracked time inside a range (entries are cut at the range edges); optionally one person only. */
export function trackedIn(entries: readonly TimeEntry[], range: Range, userId: string | null = null): number {
  let total = 0;
  for (const e of entries) {
    if (userId && e.userId !== userId) continue;
    if (entryMs(e) === undefined) continue;
    const start = Math.max(ms(e.startedAt)!, range.from);
    const end = Math.min(ms(e.endedAt ?? undefined)!, range.to);
    if (end > start) total += end - start;
  }
  return total;
}

export const runningTimers = (entries: readonly TimeEntry[]): number => entries.filter((e) => !e.endedAt).length;

// ───────────────────────────── activity ─────────────────────────────

export interface ActivityInput {
  /** Events by `issue:<id>`. */
  events: ReadonlyMap<string, readonly { at: string }[]>;
  /** Artifacts (pull requests, builds) by task id. */
  artifacts: ReadonlyMap<string, readonly { updatedAt: string }[]>;
  entries: readonly TimeEntry[];
  now: number;
}

/** When something last happened on a task: its update, events, linked artifacts and tracked time. */
export function activityLookup(input: ActivityInput): (issue: Issue) => number {
  const timeAt = new Map<string, number>();
  for (const e of input.entries) {
    if (!e.issueId) continue;
    const at = e.endedAt ? ms(e.endedAt) : input.now;
    if (at !== undefined && at > (timeAt.get(e.issueId) ?? 0)) timeAt.set(e.issueId, at);
  }
  return (issue) => {
    let latest = ms(issue.updatedAt) ?? ms(issue.startedAt) ?? ms(issue.createdAt) ?? 0;
    for (const ev of input.events.get(`issue:${issue.id}`) ?? []) latest = Math.max(latest, ms(ev.at) ?? 0);
    for (const a of input.artifacts.get(issue.id) ?? []) latest = Math.max(latest, ms(a.updatedAt) ?? 0);
    return Math.max(latest, timeAt.get(issue.id) ?? 0);
  };
}

// ───────────────────────────── 1. how much gets finished ─────────────────────────────

export interface WeekBucket {
  start: number;
  end: number;
  label: string;
  title: string;
  done: number;
  /** Tasks created in the bucket (any status), for "created vs completed". */
  created: number;
  points: number;
}

/**
 * Created and completed tasks per trailing 7-day bucket ending now, so the newest bar is never a half-empty calendar
 * week. Canceled tasks never count as completed.
 */
export function weeklyThroughput(issues: readonly Issue[], now: number, period: Period): WeekBucket[] {
  const count = PERIOD_WEEKS[period];
  const top = now + 1;
  const buckets: WeekBucket[] = Array.from({ length: count }, (_, i) => {
    const start = top - (count - i) * WEEK;
    const end = start + WEEK;
    return {
      start,
      end,
      label: format(start, 'MMM d'),
      title: `${format(start, 'MMM d')} – ${format(end - 1, 'MMM d')}`,
      done: 0,
      created: 0,
      points: 0,
    };
  });
  for (const issue of issues) {
    const madeAt = ms(issue.createdAt);
    if (madeAt !== undefined) {
      const made = buckets.find((x) => madeAt >= x.start && madeAt < x.end);
      if (made) made.created += 1;
    }
    if (!isDone(issue)) continue;
    const at = ms(issue.completedAt)!;
    const b = buckets.find((x) => at >= x.start && at < x.end);
    if (!b) continue;
    b.done += 1;
    b.points += issue.estimate ?? 0;
  }
  return buckets;
}

export interface CompletedSummary {
  count: number;
  /** Sum of the estimates of the completed tasks that have one. */
  points: number;
  /** Completed tasks without an estimate, so the points are known to be a floor. */
  unestimated: number;
  /** Median days from start to done over completed tasks that have both dates; undefined without any. */
  medianDaysToFinish?: number;
  /** Tasks the median is based on. */
  finishSample: number;
}

export function completedSummary(issues: readonly Issue[], range: Range): CompletedSummary {
  const done = issues.filter((i) => isDone(i) && within(ms(i.completedAt), range));
  const days = done.flatMap((i) => {
    const s = ms(i.startedAt);
    const c = ms(i.completedAt)!;
    return s !== undefined && c >= s ? [(c - s) / DAY] : [];
  });
  return {
    count: done.length,
    points: done.reduce((n, i) => n + (i.estimate ?? 0), 0),
    unestimated: done.filter((i) => i.estimate === undefined).length,
    medianDaysToFinish: median(days),
    finishSample: days.length,
  };
}

// ───────────────────────────── 2. what is in progress ─────────────────────────────

export interface RunningRow {
  issue: Issue;
  /** Since it first started (or was last touched when it has no start date). Shown, never averaged. */
  sinceMs: number;
  /** Time since the last activity. */
  idleMs: number;
  idle: boolean;
  /** Finished tracked time on the task. */
  trackedMs: number;
}

/** Tasks in In progress / In review, idle ones first, longest idle first. */
export function runningRows(
  issues: readonly Issue[],
  now: number,
  idleDays: number,
  activityAt: (issue: Issue) => number,
  tracked: ReadonlyMap<string, number>,
): RunningRow[] {
  return issues
    .filter(isRunning)
    .map((issue) => {
      const idleMs = Math.max(0, now - activityAt(issue));
      return {
        issue,
        sinceMs: Math.max(0, now - (ms(issue.startedAt) ?? ms(issue.updatedAt) ?? now)),
        idleMs,
        idle: idleMs >= idleDays * DAY,
        trackedMs: tracked.get(issue.id) ?? 0,
      };
    })
    .sort((a, b) => Number(b.idle) - Number(a.idle) || b.idleMs - a.idleMs);
}

// ───────────────────────────── 3. estimates vs time spent ─────────────────────────────

export interface EstimateRow {
  estimate: number;
  n: number;
  medianMs: number;
  p25Ms: number;
  p75Ms: number;
  /** Fewer than REF_MIN finished tasks: shown, but flagged as thin. */
  thin: boolean;
}

export interface Outlier {
  issue: Issue;
  trackedMs: number;
  /** Estimate x pace. */
  expectedMs: number;
  /** trackedMs / expectedMs. */
  factor: number;
}

export interface Accuracy {
  /** Completed tasks with an estimate and tracked time: the only tasks compared. */
  sample: number;
  /** Median tracked ms per point; undefined below REF_MIN tasks. */
  paceMsPerPoint?: number;
  /** Share (0-100) of the sample within 0.5x-2x of the pace; undefined below REF_MIN tasks. */
  consistentPct?: number;
  rows: EstimateRow[];
  outliers: Outlier[];
  excluded: {
    /** Completed tasks with an estimate but no tracked time. */
    noTime: number;
    /** Completed tasks with tracked time but no (or a zero) estimate. */
    noEstimate: number;
  };
  /** Open tasks that already have tracked time: listed apart, never compared. */
  open: { count: number; ms: number };
}

const usable = (i: Issue, tracked: ReadonlyMap<string, number>): boolean =>
  isDone(i) && (i.estimate ?? 0) > 0 && (tracked.get(i.id) ?? 0) > 0;

export function estimateAccuracy(issues: readonly Issue[], tracked: ReadonlyMap<string, number>): Accuracy {
  const sample = issues.filter((i) => usable(i, tracked));
  const byEstimate = new Map<number, number[]>();
  for (const i of sample) byEstimate.set(i.estimate!, [...(byEstimate.get(i.estimate!) ?? []), tracked.get(i.id)!]);
  const rows: EstimateRow[] = [...byEstimate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([estimate, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        estimate,
        n: sorted.length,
        medianMs: quantile(sorted, 0.5),
        p25Ms: quantile(sorted, 0.25),
        p75Ms: quantile(sorted, 0.75),
        thin: sorted.length < REF_MIN,
      };
    });

  const perPoint = sample.map((i) => tracked.get(i.id)! / i.estimate!);
  const pace = sample.length >= REF_MIN ? median(perPoint) : undefined;
  let consistentPct: number | undefined;
  const outliers: Outlier[] = [];
  if (pace !== undefined && pace > 0) {
    let ok = 0;
    for (const i of sample) {
      const trackedMs = tracked.get(i.id)!;
      const expectedMs = pace * i.estimate!;
      const factor = trackedMs / expectedMs;
      if (factor >= 1 / PACE_BAND && factor <= PACE_BAND) ok += 1;
      else outliers.push({ issue: i, trackedMs, expectedMs, factor });
    }
    consistentPct = Math.round((ok / sample.length) * 100);
    outliers.sort((a, b) => Math.abs(Math.log(b.factor)) - Math.abs(Math.log(a.factor)));
  }

  const openWithTime = issues.filter((i) => !isDone(i) && i.status !== 'canceled' && (tracked.get(i.id) ?? 0) > 0);
  return {
    sample: sample.length,
    paceMsPerPoint: pace,
    consistentPct,
    rows,
    outliers: outliers.slice(0, 5),
    excluded: {
      noTime: issues.filter((i) => isDone(i) && (i.estimate ?? 0) > 0 && (tracked.get(i.id) ?? 0) <= 0).length,
      noEstimate: issues.filter((i) => isDone(i) && !((i.estimate ?? 0) > 0) && (tracked.get(i.id) ?? 0) > 0).length,
    },
    open: { count: openWithTime.length, ms: openWithTime.reduce((n, i) => n + (tracked.get(i.id) ?? 0), 0) },
  };
}

/** Median tracked time of completed tasks sharing `estimate` (not counting `exceptId`); undefined below REF_MIN. */
export function typicalTracked(
  issues: readonly Issue[],
  tracked: ReadonlyMap<string, number>,
  estimate: number,
  exceptId?: string,
): { n: number; medianMs?: number } {
  const values = issues
    .filter((i) => i.id !== exceptId && i.estimate === estimate && usable(i, tracked))
    .map((i) => tracked.get(i.id)!);
  return { n: values.length, medianMs: values.length >= REF_MIN ? median(values) : undefined };
}

/** How many tasks were created inside a range. */
export const createdIn = (issues: readonly Issue[], range: Range): number =>
  issues.filter((i) => within(ms(i.createdAt), range)).length;

/** What is missing before estimates can be compared with tracked time, for the empty state of that section. */
export interface EstimateCoverage {
  /** Completed tasks. */
  finished: number;
  withEstimate: number;
  withTime: number;
  /** Both: the tasks that can actually be compared (same as `Accuracy.sample`). */
  both: number;
}

export function estimateCoverage(issues: readonly Issue[], tracked: ReadonlyMap<string, number>): EstimateCoverage {
  const finished = issues.filter(isDone);
  return {
    finished: finished.length,
    withEstimate: finished.filter((i) => (i.estimate ?? 0) > 0).length,
    withTime: finished.filter((i) => (tracked.get(i.id) ?? 0) > 0).length,
    both: finished.filter((i) => usable(i, tracked)).length,
  };
}

// ───────────────────────────── 4. open work: by status, by project, by person ─────────────────────────────

/** The statuses that count as open work, in the order work flows through them. */
export const OPEN_STATUSES = ['backlog', 'todo', 'in_progress', 'in_review'] as const;

export interface OpenCount {
  key: string;
  label: string;
  count: number;
  /** Sum of the estimates of those tasks. */
  points: number;
}

/** Open tasks (backlog, todo, in progress, in review) per status; every open status is listed, even with zero. */
export function openByStatus(issues: readonly Issue[], labelOf: (status: string) => string): OpenCount[] {
  return OPEN_STATUSES.map((status) => {
    const list = issues.filter((i) => i.status === status);
    return { key: status, label: labelOf(status), count: list.length, points: list.reduce((n, i) => n + (i.estimate ?? 0), 0) };
  });
}

/** Open tasks per project, biggest first; tasks without a project are listed last as "No project". */
export function openByProject(
  issues: readonly Issue[],
  nameOf: (projectId: string) => string,
  noProjectLabel = 'No project',
): OpenCount[] {
  const rows = new Map<string, OpenCount>();
  for (const i of issues) {
    if (!(OPEN_STATUSES as readonly string[]).includes(i.status)) continue;
    const key = i.projectId ?? '';
    const row = rows.get(key) ?? { key: key || 'none', label: key ? nameOf(key) : noProjectLabel, count: 0, points: 0 };
    row.count += 1;
    row.points += i.estimate ?? 0;
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (a, b) => Number(a.key === 'none') - Number(b.key === 'none') || b.count - a.count || a.label.localeCompare(b.label),
  );
}

// ───────────────────────────── 5. who has what ─────────────────────────────

export interface LoadRow {
  key: string;
  label: string;
  todo: number;
  inProgress: number;
  inReview: number;
  total: number;
  /** Sum of the estimates of those tasks. */
  points: number;
  idle: number;
}

/** Open work per person: tasks in Todo, In progress and In review (the backlog is not anyone's load yet). */
export function workload(
  issues: readonly Issue[],
  nameOf: (assigneeId: string | undefined) => string,
  isIdle: (issue: Issue) => boolean,
): LoadRow[] {
  const rows = new Map<string, LoadRow>();
  for (const i of issues) {
    if (i.status !== 'todo' && !isRunning(i)) continue;
    const key = i.assigneeId ?? '';
    const row =
      rows.get(key) ??
      { key: key || 'unassigned', label: nameOf(i.assigneeId), todo: 0, inProgress: 0, inReview: 0, total: 0, points: 0, idle: 0 };
    if (i.status === 'todo') row.todo += 1;
    else if (i.status === 'in_progress') row.inProgress += 1;
    else row.inReview += 1;
    row.total += 1;
    row.points += i.estimate ?? 0;
    if (isRunning(i) && isIdle(i)) row.idle += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

// ───────────────────────────── inbox: one person, one week ─────────────────────────────

export interface WeekSummary {
  doneThis: number;
  doneLast: number;
  pointsThis: number;
  pointsLast: number;
  /** Median days from start to done of what was completed this week. */
  medianCycle?: number;
  /** Their tasks in progress that nobody has touched for `idleDays`. */
  idle: Issue[];
}

/** One person's last 7 days against the 7 before; `issues` are that person's tasks. */
export function weekSummary(
  issues: readonly Issue[],
  now: number,
  idleDays: number,
  activityAt: (issue: Issue) => number,
): WeekSummary {
  const thisWeek: Range = { from: now + 1 - WEEK, to: now + 1 };
  const lastWeek: Range = { from: now + 1 - 2 * WEEK, to: now + 1 - WEEK };
  const a = completedSummary(issues, thisWeek);
  const b = completedSummary(issues, lastWeek);
  return {
    doneThis: a.count,
    doneLast: b.count,
    pointsThis: a.points,
    pointsLast: b.points,
    medianCycle: a.medianDaysToFinish,
    idle: issues.filter((i) => isRunning(i) && now - activityAt(i) >= idleDays * DAY),
  };
}
