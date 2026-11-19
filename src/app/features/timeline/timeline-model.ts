// Timeline maths: the projected end of a project from its recent throughput, the on-track / at-risk /
// off-track signal that follows from it, and the time scale (date <-> pixel, axis bands) of the chart.
// Pure functions: callers pass `now` and already classified tasks, nothing here reads the store.
// The stored project `health` is deliberately ignored: the signal is always derived from dates.
import {
  addDays,
  differenceInCalendarDays,
  eachDayOfInterval,
  eachMonthOfInterval,
  eachQuarterOfInterval,
  eachWeekOfInterval,
  endOfMonth,
  endOfQuarter,
  format,
  max as maxDate,
  min as minDate,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfQuarter,
  startOfWeek,
  subDays,
} from 'date-fns';

// ───────────────────────────── Forecast ─────────────────────────────

/** Weeks of history the throughput is measured over (shorter for a younger project). */
export const THROUGHPUT_WEEKS = 6;
/** Fewer tasks closed in the window than this is too little to extrapolate from. */
export const MIN_CLOSED_FOR_PACE = 2;
/** A projection this many days past the target is "at risk" rather than "off track". */
export const AT_RISK_MIN_DAYS = 7;
/** ...or this share of the planned duration, whichever is larger. */
export const AT_RISK_RATIO = 0.1;

export type TaskState = 'open' | 'done' | 'canceled';

/** What the forecast needs to know about a task. */
export interface ForecastTask {
  state: TaskState;
  /** When a done task was finished. */
  completedAt?: string;
}

export type SignalKind =
  | 'on_track'
  | 'at_risk'
  | 'off_track'
  | 'not_enough_data'
  | 'no_target'
  | 'closed';

export interface ForecastInput {
  now: Date;
  /** ISO date of the project start (planned). */
  startDate?: string;
  /** ISO date of the project target. */
  targetDate?: string;
  /** Project creation, the fallback start of the measuring window. */
  createdAt?: string;
  /** The project itself is completed or canceled. */
  closed?: boolean;
  tasks: readonly ForecastTask[];
}

export interface ProjectForecast {
  signal: SignalKind;
  /** Done and in-scope task counts (canceled tasks are out of scope). */
  done: number;
  total: number;
  open: number;
  /** Tasks closed per week over the measuring window. */
  perWeek: number;
  /** Length of the measuring window in weeks (1 to 6). */
  windowWeeks: number;
  closedInWindow: number;
  /** When the remaining open tasks run out at the current pace. Undefined without a usable pace. */
  projectedEnd?: Date;
  /** Days from now until the projected end. */
  daysToFinish?: number;
  /** Projected end minus target in whole days (positive = after the target). */
  daysVsTarget?: number;
  /** A short phrase for the row ("On track", "9 days late"...). */
  label: string;
  /** The plain-words explanation shown in the tooltip. */
  explanation: string;
}

const parse = (iso: string | undefined): Date | undefined => {
  if (!iso) return undefined;
  const d = parseISO(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "12 Dec", with the year when it is not the current one. */
export function shortDate(date: Date, now: Date): string {
  return format(date, date.getFullYear() === now.getFullYear() ? 'd MMM' : 'd MMM yyyy');
}

/** "~3 days", "~3 weeks", "~5 months". */
export function approxDuration(days: number): string {
  if (days <= 10) return `~${plural(Math.max(1, days), 'day')}`;
  if (days < 75) return `~${plural(Math.round(days / 7), 'week')}`;
  return `~${plural(Math.round(days / 30), 'month')}`;
}

function daysPhrase(delta: number): string {
  if (delta === 0) return 'on the target date';
  const n = Math.abs(delta);
  return `${plural(n, 'day')} ${delta > 0 ? 'after' : 'before'} target`;
}

/** How many tasks were closed in the window and how wide the window is. */
function measureThroughput(input: ForecastInput): {
  closedInWindow: number;
  windowWeeks: number;
  perWeek: number;
} {
  const today = startOfDay(input.now);
  const anchor = parse(input.startDate) ?? parse(input.createdAt);
  const ageDays = anchor ? differenceInCalendarDays(today, anchor) : THROUGHPUT_WEEKS * 7;
  const windowWeeks = Math.min(THROUGHPUT_WEEKS, Math.max(1, ageDays / 7));
  const from = subDays(today, Math.round(windowWeeks * 7)).getTime();
  const until = addDays(today, 1).getTime();
  let closedInWindow = 0;
  for (const t of input.tasks) {
    if (t.state !== 'done') continue;
    const at = parse(t.completedAt)?.getTime();
    if (at !== undefined && at >= from && at < until) closedInWindow++;
  }
  return { closedInWindow, windowWeeks, perWeek: closedInWindow / windowWeeks };
}

/** Projected end date and on-track / at-risk / off-track signal of a project. */
export function forecastProject(input: ForecastInput): ProjectForecast {
  const today = startOfDay(input.now);
  const scoped = input.tasks.filter((t) => t.state !== 'canceled');
  const done = scoped.filter((t) => t.state === 'done').length;
  const open = scoped.length - done;
  const base = { done, total: scoped.length, open };
  const pace = measureThroughput(input);
  const target = parse(input.targetDate);
  const targetDay = target ? startOfDay(target) : undefined;
  const start = parse(input.startDate);

  const result = (
    signal: SignalKind,
    label: string,
    explanation: string,
    extra: Partial<ProjectForecast> = {},
  ): ProjectForecast => ({ ...base, ...pace, signal, label, explanation, ...extra });

  if (input.closed) return result('closed', 'Closed', 'This project is closed.');

  if (base.total > 0 && open === 0) {
    const late = targetDay ? differenceInCalendarDays(today, targetDay) : 0;
    return result(
      'on_track',
      'All tasks done',
      late > 0
        ? `Every task is closed (${base.done} of ${base.total}), ${plural(late, 'day')} after the target.`
        : `Every task is closed (${base.done} of ${base.total}). Ready to be completed.`,
      { projectedEnd: today, daysToFinish: 0, daysVsTarget: targetDay ? late : undefined },
    );
  }

  const lowData =
    base.total === 0
      ? 'No tasks yet, so there is nothing to project.'
      : `Only ${plural(pace.closedInWindow, 'task')} closed in the last ${approxWindow(pace.windowWeeks)}: at least ${MIN_CLOSED_FOR_PACE} are needed to estimate a pace.`;

  // Open work and a target that already passed: off track, with or without a projection.
  const overdueDays = targetDay ? differenceInCalendarDays(today, targetDay) : 0;
  const hasPace = base.total > 0 && pace.closedInWindow >= MIN_CLOSED_FOR_PACE;

  let projectedEnd: Date | undefined;
  let daysToFinish: number | undefined;
  if (hasPace && pace.perWeek > 0) {
    daysToFinish = Math.max(1, Math.ceil(open / (pace.perWeek / 7)));
    projectedEnd = addDays(today, daysToFinish);
  }
  const daysVsTarget =
    projectedEnd && targetDay ? differenceInCalendarDays(projectedEnd, targetDay) : undefined;
  const atPace = projectedEnd
    ? `At this pace (${perWeekText(pace.perWeek)}): ${approxDuration(daysToFinish ?? 0)} for ${plural(open, 'open task')}, ends ${shortDate(projectedEnd, input.now)}`
    : undefined;
  const extra = { projectedEnd, daysToFinish, daysVsTarget };

  if (targetDay && overdueDays > 0) {
    return result(
      'off_track',
      `${plural(overdueDays, 'day')} past target`,
      `The target passed ${plural(overdueDays, 'day')} ago and ${plural(open, 'task')} ${open === 1 ? 'is' : 'are'} still open.${atPace ? ` ${atPace}.` : ''}`,
      extra,
    );
  }

  if (!projectedEnd) return result('not_enough_data', 'Not enough data', lowData);

  if (!targetDay) {
    return result(
      'no_target',
      `Ends ~${shortDate(projectedEnd, input.now)}`,
      `${atPace}. No target date is set, so there is nothing to compare it with.`,
      extra,
    );
  }

  const delta = differenceInCalendarDays(projectedEnd, targetDay);
  const span = Math.max(0, differenceInCalendarDays(targetDay, start ?? today));
  const tolerance = Math.max(AT_RISK_MIN_DAYS, Math.round(span * AT_RISK_RATIO));
  const verdict = `${atPace}, ${daysPhrase(delta)} (${shortDate(targetDay, input.now)}).`;

  if (delta <= 0) {
    return result('on_track', 'On track', verdict, extra);
  }
  if (delta <= tolerance) {
    return result('at_risk', `At risk · ${plural(delta, 'day')} late`, verdict, extra);
  }
  return result('off_track', `Off track · ${plural(delta, 'day')} late`, verdict, extra);
}

function approxWindow(weeks: number): string {
  return weeks >= THROUGHPUT_WEEKS ? `${THROUGHPUT_WEEKS} weeks` : approxDuration(Math.round(weeks * 7)).slice(1);
}

function perWeekText(perWeek: number): string {
  const rounded = Math.round(perWeek * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} per week`;
}

// ───────────────────────────── Scale ─────────────────────────────

export type Zoom = 'week' | 'month' | 'quarter';

export const ZOOMS: readonly { value: Zoom; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
];

export const PX_PER_DAY: Record<Zoom, number> = { week: 36, month: 10, quarter: 3.2 };
/** Empty time kept around the data, in days. */
const PADDING_DAYS: Record<Zoom, number> = { week: 14, month: 30, quarter: 60 };
/** The axis is never shorter than this, in days. */
const MIN_DAYS: Record<Zoom, number> = { week: 70, month: 180, quarter: 450 };

export interface TimeScale {
  zoom: Zoom;
  /** First day on the axis. */
  origin: Date;
  /** Last day on the axis (inclusive). */
  end: Date;
  pxPerDay: number;
  /** Number of days on the axis. */
  days: number;
  /** Axis width in px. */
  width: number;
}

/** A time axis wide enough for every date, today and a margin, snapped to week / month / quarter edges. */
export function buildScale(
  zoom: Zoom,
  dates: readonly (Date | undefined)[],
  now: Date,
  weekStartsOn: 0 | 1 | 6 = 1,
): TimeScale {
  const known = [startOfDay(now), ...dates.filter((d): d is Date => !!d)];
  const pad = PADDING_DAYS[zoom];
  let origin = subDays(minDate(known), pad);
  let end = addDays(maxDate(known), pad);
  if (differenceInCalendarDays(end, origin) + 1 < MIN_DAYS[zoom]) {
    // Centre the data when it is shorter than the minimum axis.
    const missing = MIN_DAYS[zoom] - (differenceInCalendarDays(end, origin) + 1);
    origin = subDays(origin, Math.floor(missing / 2));
    end = addDays(end, Math.ceil(missing / 2));
  }
  if (zoom === 'quarter') {
    origin = startOfQuarter(origin);
    end = endOfQuarter(end);
  } else {
    origin = zoom === 'month' ? startOfMonth(origin) : startOfWeek(origin, { weekStartsOn });
    end = endOfMonth(end);
  }
  origin = startOfDay(origin);
  end = startOfDay(end);
  const days = differenceInCalendarDays(end, origin) + 1;
  const pxPerDay = PX_PER_DAY[zoom];
  return { zoom, origin, end, pxPerDay, days, width: days * pxPerDay };
}

/** Left edge in px of a day on the axis. */
export function dateX(scale: TimeScale, date: Date): number {
  return differenceInCalendarDays(date, scale.origin) * scale.pxPerDay;
}

/** Right edge in px of a day on the axis: the end of that day. */
export function dateEndX(scale: TimeScale, date: Date): number {
  return dateX(scale, date) + scale.pxPerDay;
}

export interface AxisBand {
  start: Date;
  x: number;
  width: number;
  label: string;
  /** A weekend day or the like, drawn quieter. */
  quiet?: boolean;
}

export interface AxisBands {
  upper: AxisBand[];
  lower: AxisBand[];
}

function bandsOf(
  scale: TimeScale,
  starts: readonly Date[],
  label: (d: Date) => string,
  quiet?: (d: Date) => boolean,
): AxisBand[] {
  return starts.map((start, i) => {
    const from = maxDate([start, scale.origin]);
    const next = starts[i + 1] ?? addDays(scale.end, 1);
    const x = dateX(scale, from);
    return {
      start,
      x,
      width: dateX(scale, next) - x,
      label: label(start),
      quiet: quiet?.(start),
    };
  });
}

/** Two header rows: months over days (week zoom), months over weeks (month zoom), quarters over months. */
export function axisBands(scale: TimeScale, weekStartsOn: 0 | 1 | 6 = 1): AxisBands {
  const interval = { start: scale.origin, end: scale.end };
  const months = eachMonthOfInterval(interval);
  if (scale.zoom === 'quarter') {
    return {
      upper: bandsOf(scale, eachQuarterOfInterval(interval), (d) => format(d, 'QQQ yyyy')),
      lower: bandsOf(scale, months, (d) => format(d, 'MMM')),
    };
  }
  const upper = bandsOf(scale, months, (d) => format(d, 'MMMM yyyy'));
  if (scale.zoom === 'week') {
    return {
      upper,
      lower: bandsOf(
        scale,
        eachDayOfInterval(interval),
        (d) => format(d, 'EEEEE d'),
        (d) => d.getDay() === 0 || d.getDay() === 6,
      ),
    };
  }
  return {
    upper,
    lower: bandsOf(scale, eachWeekOfInterval(interval, { weekStartsOn }), (d) => format(d, 'd')),
  };
}

// ───────────────────────────── Rows ─────────────────────────────

/** The dated span of a project, or undefined while it has neither a start nor a target. */
export interface ProjectSpan {
  start: Date;
  end: Date;
}

export function projectSpan(
  p: { startDate?: string; targetDate?: string; createdAt?: string },
  now: Date,
): ProjectSpan | undefined {
  const target = parse(p.targetDate);
  const start = parse(p.startDate) ?? (target ? parse(p.createdAt) : undefined);
  if (!start && !target) return undefined;
  const a = startOfDay(start ?? target!);
  const b = startOfDay(target ?? maxDate([startOfDay(now), a]));
  // A start after the target is a data slip: draw it as a one-sided span rather than a negative bar.
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** Earliest start first; projects without dates last. */
export function compareSpans(a: ProjectSpan | undefined, b: ProjectSpan | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime();
}

export const parseDate = parse;
