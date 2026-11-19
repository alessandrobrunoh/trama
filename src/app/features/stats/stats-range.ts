// The period every statistic is measured over, and the time buckets (days or weeks) the charts are drawn in.
// Pure: callers pass `now`, nothing here reads a clock or a store.
import { addDays, endOfDay, format, isValid, parse, startOfDay } from 'date-fns';

export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

export interface Range {
  from: number;
  /** Exclusive. */
  to: number;
}

export type PeriodId = '7d' | '30d' | '90d' | 'custom';

export const PERIOD_CHOICES: readonly { id: PeriodId; label: string; long: string }[] = [
  { id: '7d', label: '7 days', long: 'Last 7 days' },
  { id: '30d', label: '30 days', long: 'Last 30 days' },
  { id: '90d', label: '90 days', long: 'Last 90 days' },
  { id: 'custom', label: 'Custom', long: 'Custom range' },
];

const FIXED_DAYS: Record<Exclude<PeriodId, 'custom'>, number> = { '7d': 7, '30d': 30, '90d': 90 };
/** A custom range longer than this is cut to its most recent year. */
export const MAX_CUSTOM_DAYS = 366;
export const DEFAULT_PERIOD: PeriodId = '30d';

export interface ResolvedRange extends Range {
  days: number;
  custom: boolean;
  /** "Last 30 days" or "Mar 3 – Apr 2". */
  label: string;
}

export const DATE_KEY = 'yyyy-MM-dd';

/** Milliseconds of an ISO string, or undefined when it is missing or invalid. */
export function toMs(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

export const inRange = (t: number | undefined, r: Range): boolean => t !== undefined && t >= r.from && t < r.to;

function parseDay(key: string | null | undefined): Date | undefined {
  if (!key) return undefined;
  const d = parse(key, DATE_KEY, new Date(0));
  return isValid(d) ? d : undefined;
}

function rangeLabel(from: number, to: number, now: number): string {
  const sameYear = new Date(from).getFullYear() === new Date(now).getFullYear() && new Date(to - 1).getFullYear() === new Date(now).getFullYear();
  const f = sameYear ? 'MMM d' : 'MMM d, yyyy';
  return `${format(from, f)} – ${format(to - 1, f)}`;
}

/**
 * The range for a period choice. Fixed periods end now. A custom range is whole local days, `from` to `to`
 * inclusive, never later than now; swapped dates are put right and a range over a year is cut to its last year.
 * An unreadable custom range falls back to the default period.
 */
export function resolveRange(period: PeriodId, now: number, fromKey?: string | null, toKey?: string | null): ResolvedRange {
  if (period === 'custom') {
    const a = parseDay(fromKey);
    const b = parseDay(toKey);
    if (a && b) {
      const [first, last] = a <= b ? [a, b] : [b, a];
      const to = Math.min(endOfDay(last).getTime() + 1, now + 1);
      let from = startOfDay(first).getTime();
      if (from < to) {
        if (to - from > MAX_CUSTOM_DAYS * DAY) from = startOfDay(addDays(to - 1, -(MAX_CUSTOM_DAYS - 1))).getTime();
        return { from, to, days: Math.max(1, Math.round((to - from) / DAY)), custom: true, label: rangeLabel(from, to, now) };
      }
    }
    return resolveRange(DEFAULT_PERIOD, now);
  }
  const days = FIXED_DAYS[period];
  const to = now + 1;
  return { from: to - days * DAY, to, days, custom: false, label: PERIOD_CHOICES.find((p) => p.id === period)!.long };
}

/** The range of the same length right before `range`, for "vs previous" comparisons. */
export function previousRange(range: Range): Range {
  const len = range.to - range.from;
  return { from: range.from - len, to: range.from };
}

export type BucketUnit = 'day' | 'week';

export interface Bucket extends Range {
  label: string;
  title: string;
}

export interface BucketSet {
  unit: BucketUnit;
  items: Bucket[];
}

/** At most this many weekly bars, whatever the range. */
const MAX_WEEKS = 54;

/**
 * The buckets a chart is drawn in. Ranges of up to `dailyUpTo` days get one bucket per calendar day, the last
 * being today. Longer ranges get trailing 7-day buckets ending at the end of the range, so the newest bar is never
 * a half-empty calendar week; there are enough of them to cover the range.
 */
export function buckets(range: Range, dailyUpTo = 14): BucketSet {
  const days = Math.max(1, Math.round((range.to - range.from) / DAY));
  if (days <= dailyUpTo) {
    const last = startOfDay(range.to - 1);
    const items = Array.from({ length: days }, (_, i) => {
      const start = addDays(last, -(days - 1 - i));
      const end = addDays(start, 1);
      return { from: start.getTime(), to: end.getTime(), label: format(start, 'MMM d'), title: format(start, 'EEE, MMM d') };
    });
    return { unit: 'day', items };
  }
  const count = Math.min(MAX_WEEKS, Math.ceil(days / 7));
  const items = Array.from({ length: count }, (_, i) => {
    const from = range.to - (count - i) * WEEK;
    const to = from + WEEK;
    return { from, to, label: format(from, 'MMM d'), title: `${format(from, 'MMM d')} – ${format(to - 1, 'MMM d')}` };
  });
  return { unit: 'week', items };
}

/** Index of the bucket holding `t`, or -1. */
export function bucketIndex(items: readonly Bucket[], t: number | undefined): number {
  if (t === undefined) return -1;
  return items.findIndex((b) => t >= b.from && t < b.to);
}

/** End-of-day sample times covering `range`, thinned to about `max` points, always ending at `now`. */
export function sampleTimes(range: Range, now: number, max = 90): number[] {
  const days = Math.max(1, Math.round((range.to - range.from) / DAY));
  const step = Math.max(1, Math.ceil(days / max));
  const times: number[] = [];
  const lastDay = startOfDay(Math.min(range.to - 1, now));
  const firstDay = startOfDay(range.from);
  for (let d = lastDay; d >= firstDay; d = addDays(d, -step)) {
    const end = Math.min(endOfDay(d).getTime(), now);
    times.unshift(end);
  }
  if (!times.length || times[times.length - 1] < now) times.push(Math.min(range.to - 1, now));
  return [...new Set(times)];
}
