// Flow numbers: how many tasks are created and closed, how long they take, how much is in progress at once.
// Pure functions over tasks. Everything that is averaged is averaged over COMPLETED tasks with the median or a
// percentile; open and stale tasks never enter a duration.
import type { Issue } from '../../core';
import { quantile } from './flow-stats';
import { DAY, bucketIndex, inRange, toMs, type Bucket, type Range } from './stats-range';

/** Fewest completed tasks before the 75th and 90th percentile are shown: with fewer they are just the largest values. */
export const MIN_FOR_TAIL = 5;

/** Done with a completion date. Canceled tasks never count as completed. */
export const isCompleted = (i: Issue): boolean => i.status === 'done' && toMs(i.completedAt) !== undefined;

export const completedInRange = (issues: readonly Issue[], range: Range): Issue[] =>
  issues.filter((i) => isCompleted(i) && inRange(toMs(i.completedAt), range));

export const createdInRange = (issues: readonly Issue[], range: Range): Issue[] =>
  issues.filter((i) => inRange(toMs(i.createdAt), range));

/** Days from the first start to completion; undefined for a task that never started or has no sane dates. */
export function cycleDays(i: Issue): number | undefined {
  const s = toMs(i.startedAt);
  const c = toMs(i.completedAt);
  return s !== undefined && c !== undefined && c >= s ? (c - s) / DAY : undefined;
}

/** Days from creation to completion; undefined without sane dates. */
export function leadDays(i: Issue): number | undefined {
  const s = toMs(i.createdAt);
  const c = toMs(i.completedAt);
  return s !== undefined && c !== undefined && c >= s ? (c - s) / DAY : undefined;
}

export interface Percentiles {
  n: number;
  median?: number;
  /** Undefined below MIN_FOR_TAIL values. */
  p75?: number;
  p90?: number;
}

export function percentiles(values: readonly number[]): Percentiles {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return { n };
  return {
    n,
    median: quantile(sorted, 0.5),
    p75: n >= MIN_FOR_TAIL ? quantile(sorted, 0.75) : undefined,
    p90: n >= MIN_FOR_TAIL ? quantile(sorted, 0.9) : undefined,
  };
}

export const durations = (done: readonly Issue[], pick: (i: Issue) => number | undefined): number[] =>
  done.flatMap((i) => {
    const d = pick(i);
    return d === undefined ? [] : [d];
  });

/** Duration classes of the histograms, in days. A value belongs to the first class whose `max` is above it. */
export const DURATION_BINS: readonly { label: string; max: number }[] = [
  { label: '<1d', max: 1 },
  { label: '1–2d', max: 2 },
  { label: '2–4d', max: 4 },
  { label: '4–7d', max: 7 },
  { label: '1–2w', max: 14 },
  { label: '2–4w', max: 28 },
  { label: '4w+', max: Infinity },
];

export function histogram(values: readonly number[], bins: readonly { max: number }[] = DURATION_BINS): number[] {
  const out = new Array<number>(bins.length).fill(0);
  for (const v of values) {
    const k = bins.findIndex((b) => v < b.max);
    out[k < 0 ? bins.length - 1 : k] += 1;
  }
  return out;
}

// ───────────────────────────── per bucket ─────────────────────────────

export function createdPerBucket(issues: readonly Issue[], items: readonly Bucket[]): number[] {
  const out = new Array<number>(items.length).fill(0);
  for (const i of issues) {
    const k = bucketIndex(items, toMs(i.createdAt));
    if (k >= 0) out[k] += 1;
  }
  return out;
}

export function closedPerBucket(issues: readonly Issue[], items: readonly Bucket[]): number[] {
  const out = new Array<number>(items.length).fill(0);
  for (const i of issues) {
    if (!isCompleted(i)) continue;
    const k = bucketIndex(items, toMs(i.completedAt));
    if (k >= 0) out[k] += 1;
  }
  return out;
}

/** Mean of the last `window` values; null until a full window exists. */
export function rollingMean(values: readonly number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    let sum = 0;
    for (let k = i - window + 1; k <= i; k++) sum += values[k];
    return sum / window;
  });
}

/** Median of a duration per bucket, by the bucket the task was completed in; null for a bucket without a task. */
export function medianPerBucket(
  issues: readonly Issue[],
  items: readonly Bucket[],
  pick: (i: Issue) => number | undefined,
): (number | null)[] {
  const lists = items.map(() => [] as number[]);
  for (const i of issues) {
    if (!isCompleted(i)) continue;
    const k = bucketIndex(items, toMs(i.completedAt));
    const d = pick(i);
    if (k >= 0 && d !== undefined) lists[k].push(d);
  }
  return lists.map((l) => {
    if (!l.length) return null;
    return quantile(l.sort((a, b) => a - b), 0.5);
  });
}

// ───────────────────────────── state over time ─────────────────────────────

/**
 * What a task was at a moment, rebuilt from its dates: not there yet, waiting (backlog or todo), being worked on
 * (it had started and was not finished) or done. The dates are all the history there is, so a task that was moved
 * back to Todo after it started is shown as worked on until now, where its real status is used. Canceled tasks are
 * left out altogether.
 */
export type FlowState = 'none' | 'waiting' | 'active' | 'done';

export function stateAt(i: Issue, t: number, now: number): FlowState {
  if (i.status === 'canceled') return 'none';
  const created = toMs(i.createdAt) ?? 0;
  if (created > t) return 'none';
  if (t >= now) {
    if (i.status === 'done') return 'done';
    return i.status === 'in_progress' || i.status === 'in_review' ? 'active' : 'waiting';
  }
  if (i.status === 'done') {
    const finished = toMs(i.completedAt) ?? toMs(i.updatedAt) ?? created;
    if (finished <= t) return 'done';
  }
  const started = toMs(i.startedAt);
  return started !== undefined && started <= t ? 'active' : 'waiting';
}

export interface FlowCounts {
  waiting: number[];
  active: number[];
  done: number[];
}

/** Tasks per state at each moment in `times` (the cumulative flow). */
export function cumulativeFlow(issues: readonly Issue[], times: readonly number[], now: number): FlowCounts {
  const out: FlowCounts = { waiting: [], active: [], done: [] };
  for (const t of times) {
    let waiting = 0;
    let active = 0;
    let done = 0;
    for (const i of issues) {
      const s = stateAt(i, t, now);
      if (s === 'waiting') waiting += 1;
      else if (s === 'active') active += 1;
      else if (s === 'done') done += 1;
    }
    out.waiting.push(waiting);
    out.active.push(active);
    out.done.push(done);
  }
  return out;
}

/** Tasks being worked on at each moment, not counting `exclude` (the tasks that have gone stale). */
export function wipOverTime(issues: readonly Issue[], times: readonly number[], now: number, exclude: ReadonlySet<string> = new Set()): number[] {
  return times.map((t) => issues.reduce((n, i) => n + (!exclude.has(i.id) && stateAt(i, t, now) === 'active' ? 1 : 0), 0));
}

export const mean = (values: readonly number[]): number | undefined =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined;
