// Pure helpers of the Time pages (Timesheet, Reports, Estimates): weeks and days, the timesheet grid, the daily
// series of the report, and the learned hours per estimate value. No Angular, so they are cheap to test.
// Only the signed-in person's own time entries exist in the API, so everything here is "your" time.
import { addDays, format, getISOWeek, startOfDay } from 'date-fns';
import type { Issue } from '../../core';
import type { TimeEntry } from '../../core/api/api.types';
import { median, quantile } from '../stats/flow-stats';

export const HOUR = 3_600_000;
export const MINUTE = 60_000;

// ───────────────────────────── formatting ─────────────────────────────

/** `3:10` (hours:minutes, rounded to the minute). */
export function hm(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** `12h 22m`, `5h`, `42m`. */
export function hoursMinutes(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** `6.3h`, `13h`, `2.5h`: hours with at most one decimal, none from 10h up. */
export function hoursShort(ms: number): string {
  const h = ms / HOUR;
  if (h >= 10) return `${Math.round(h)}h`;
  return `${Number(h.toFixed(1))}h`;
}

/** `00:42:13`. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

// ───────────────────────────── weeks ─────────────────────────────

export interface WeekDay {
  /** Start of the local day. */
  from: number;
  /** Start of the next local day. */
  to: number;
  /** `MON 23`. */
  label: string;
  /** `Mon, Nov 23`. */
  title: string;
  weekend: boolean;
  today: boolean;
  future: boolean;
}

/** First day of the week as a `Date#getDay` number: the workspace setting (Monday by default). */
export type WeekStartDay = 0 | 1 | 6;

export const WEEK_START_DAY: Record<'monday' | 'sunday' | 'saturday', WeekStartDay> = {
  monday: 1,
  sunday: 0,
  saturday: 6,
};

/** 00:00 (local) of the first day of the week that holds `t`. */
export function mondayOf(t: number, startsOn: WeekStartDay = 1): number {
  const d = startOfDay(t);
  return addDays(d, -((d.getDay() - startsOn + 7) % 7)).getTime();
}

export function dayOf(from: number, now: number): WeekDay {
  const d = new Date(from);
  const to = addDays(d, 1).getTime();
  const wd = d.getDay();
  return {
    from,
    to,
    label: format(d, 'EEE d').toUpperCase(),
    title: format(d, 'EEE, MMM d'),
    weekend: wd === 0 || wd === 6,
    today: now >= from && now < to,
    future: from > now,
  };
}

/** The seven days of the week that starts on `monday`. */
export function weekDays(monday: number, now: number): WeekDay[] {
  return Array.from({ length: 7 }, (_, i) => dayOf(addDays(monday, i).getTime(), now));
}

/** `Week 48 · Nov 23 – 29`, or `Nov 30 – Dec 6` when the week crosses a month. */
export function weekTitle(monday: number): string {
  const a = new Date(monday);
  const b = addDays(a, 6);
  const span = a.getMonth() === b.getMonth() ? `${format(a, 'MMM d')} – ${format(b, 'd')}` : `${format(a, 'MMM d')} – ${format(b, 'MMM d')}`;
  return `Week ${getISOWeek(a)} · ${span}`;
}

// ───────────────────────────── segments ─────────────────────────────

/** One time entry as a span; a running timer ends now. */
export interface Seg {
  id: string;
  start: number;
  end: number;
  issueId: string | null;
  projectId: string | null;
  description: string;
  running: boolean;
}

export function segments(entries: readonly TimeEntry[], now: number): Seg[] {
  const out: Seg[] = [];
  for (const e of entries) {
    if (e.source === 'suggested') continue; // counts only once a person accepts it
    const start = Date.parse(e.startedAt);
    const end = e.endedAt ? Date.parse(e.endedAt) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push({
      id: e.id,
      start,
      end,
      issueId: e.issueId,
      projectId: e.projectId,
      description: e.description,
      running: !e.endedAt,
    });
  }
  return out;
}

/** Milliseconds of `seg` inside [from, to). */
export const overlap = (seg: Seg, from: number, to: number): number =>
  Math.max(0, Math.min(seg.end, to) - Math.max(seg.start, from));

// ───────────────────────────── the timesheet grid ─────────────────────────────

export interface GridRow {
  /** Task id, or `other` for time without a task. */
  id: string;
  issue: Issue | null;
  /** 1 when the task is a subtask of another row. */
  depth: 0 | 1;
  /** Tracked ms for each day of the week. */
  cells: number[];
  total: number;
  /** A timer running on this row counts in today's cell. */
  running: boolean;
}

export interface Grid {
  rows: GridRow[];
  dayTotals: number[];
  total: number;
}

const OTHER = 'other';

/** Tasks worked on during the week (subtasks right under their parent) and the time of each day. */
export function buildGrid(segs: readonly Seg[], days: readonly WeekDay[], issues: ReadonlyMap<string, Issue>): Grid {
  const byRow = new Map<string, GridRow>();
  const dayTotals = days.map(() => 0);
  for (const s of segs) {
    days.forEach((d, i) => {
      const ms = overlap(s, d.from, d.to);
      if (!ms) return;
      const issue = s.issueId ? (issues.get(s.issueId) ?? null) : null;
      const id = issue ? issue.id : OTHER;
      let row = byRow.get(id);
      if (!row) {
        row = { id, issue, depth: 0, cells: days.map(() => 0), total: 0, running: false };
        byRow.set(id, row);
      }
      row.cells[i] += ms;
      row.total += ms;
      dayTotals[i] += ms;
      if (s.running && d.today) row.running = true;
    });
  }
  const real = [...byRow.values()].filter((r) => r.issue).sort((a, b) => b.total - a.total);
  const present = new Set(real.map((r) => r.id));
  const roots = real.filter((r) => !r.issue!.parentId || !present.has(r.issue!.parentId));
  const rows: GridRow[] = [];
  const place = (row: GridRow, depth: 0 | 1): void => {
    row.depth = depth;
    rows.push(row);
    for (const child of real) if (child.issue!.parentId === row.id) place(child, 1);
  };
  for (const r of roots) place(r, 0);
  const other = byRow.get(OTHER);
  if (other) rows.push(other);
  return { rows, dayTotals, total: dayTotals.reduce((n, v) => n + v, 0) };
}

/** What happened on one day, oldest first: the spans clipped to the day. */
export interface DayEntry {
  seg: Seg;
  from: number;
  to: number;
  ms: number;
}

export function entriesOnDay(segs: readonly Seg[], day: WeekDay): DayEntry[] {
  const out: DayEntry[] = [];
  for (const seg of segs) {
    const ms = overlap(seg, day.from, day.to);
    if (!ms) continue;
    out.push({ seg, from: Math.max(seg.start, day.from), to: Math.min(seg.end, day.to), ms });
  }
  return out.sort((a, b) => a.from - b.from);
}

// ───────────────────────────── suggested time ─────────────────────────────

/** A time entry `trama sync` suggested from a thread's active time, as the mobile Time card words it. */
export interface SuggestionCard {
  id: string;
  issueId: string | null;
  /** `25m`. */
  amount: string;
  /** `Tue 07:30 – 07:55 · thread was active`. */
  when: string;
}

/** The suggested entries as cards, newest first. Entries that are not suggestions or have no end are skipped. */
export function suggestionCards(entries: readonly TimeEntry[]): SuggestionCard[] {
  const out: { card: SuggestionCard; end: number }[] = [];
  for (const e of entries) {
    if (e.source !== 'suggested' || !e.endedAt) continue;
    const start = Date.parse(e.startedAt);
    const end = Date.parse(e.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.push({
      end,
      card: {
        id: e.id,
        issueId: e.issueId,
        amount: hoursMinutes(end - start),
        when: `${format(start, 'EEE HH:mm')} – ${format(end, 'HH:mm')} · thread was active`,
      },
    });
  }
  return out.sort((a, b) => b.end - a.end).map((x) => x.card);
}

// ───────────────────────────── the report ─────────────────────────────

export interface ReportDay {
  day: WeekDay;
  /** Tracked ms per series key. */
  parts: Map<string, number>;
  total: number;
  /** First day of a week: the axis label `W48`. */
  weekLabel: string | null;
}

export interface Series {
  key: string;
  label: string;
  color: string;
  ms: number;
}

/**
 * The days of the last `weeks` weeks, ending with the current one. Weekends are left out of the chart unless
 * time was tracked on one of them.
 */
export function reportDays(
  segs: readonly Seg[],
  weeks: number,
  now: number,
  keyOf: (s: Seg) => string,
  startsOn: WeekStartDay = 1,
): ReportDay[] {
  const firstMonday = addDays(mondayOf(now, startsOn), -7 * (weeks - 1)).getTime();
  const all: ReportDay[] = [];
  for (let w = 0; w < weeks; w++) {
    for (const day of weekDays(addDays(firstMonday, 7 * w).getTime(), now)) {
      const parts = new Map<string, number>();
      let total = 0;
      for (const s of segs) {
        const ms = overlap(s, day.from, day.to);
        if (!ms) continue;
        const key = keyOf(s);
        parts.set(key, (parts.get(key) ?? 0) + ms);
        total += ms;
      }
      all.push({ day, parts, total, weekLabel: null });
    }
  }
  const weekend = all.some((d) => d.day.weekend && d.total > 0);
  const kept = weekend ? all : all.filter((d) => !d.day.weekend);
  const seen = new Set<number>();
  for (const d of kept) {
    const monday = mondayOf(d.day.from, startsOn);
    if (seen.has(monday)) continue;
    seen.add(monday);
    const n = getISOWeek(monday);
    d.weekLabel = monday === mondayOf(now, startsOn) ? `W${n} · this week` : `W${n}`;
  }
  return kept;
}

/** A y-axis step and top that fit `maxMs`: 0, 2h, 4h … (steps of 1h, 2h, 4h or 8h as the maximum grows). */
export function axisFor(maxMs: number): { step: number; top: number; ticks: number[] } {
  const maxH = Math.max(1, maxMs / HOUR);
  const stepH = maxH <= 6 ? 1 : maxH <= 12 ? 2 : maxH <= 24 ? 4 : 8;
  const topH = Math.ceil(maxH / stepH) * stepH;
  const ticks: number[] = [];
  for (let h = 0; h <= topH; h += stepH) ticks.push(h);
  return { step: stepH * HOUR, top: topH * HOUR, ticks };
}

// ───────────────────────────── estimates against hours ─────────────────────────────

export interface DoneSample {
  issue: Issue;
  ms: number;
}

/** Tracked ms per task, finished entries only (a running timer has no length yet). */
export function trackedByTask(segs: readonly Seg[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of segs) {
    if (!s.issueId || s.running) continue;
    out.set(s.issueId, (out.get(s.issueId) ?? 0) + (s.end - s.start));
  }
  return out;
}

/**
 * Done tasks with an estimate and tracked time, optionally only those completed inside [from, to), and only
 * those of `projectId` when given.
 */
export function doneSamples(
  issues: readonly Issue[],
  tracked: ReadonlyMap<string, number>,
  within?: { from: number; to: number },
  projectId = '',
): DoneSample[] {
  const out: DoneSample[] = [];
  for (const issue of issues) {
    if (issue.status !== 'done' || (issue.estimate ?? 0) <= 0) continue;
    const ms = tracked.get(issue.id) ?? 0;
    if (ms <= 0) continue;
    if (projectId && issue.projectId !== projectId) continue;
    if (within) {
      const at = Date.parse(issue.completedAt ?? '');
      if (!Number.isFinite(at) || at < within.from || at >= within.to) continue;
    }
    out.push({ issue, ms });
  }
  return out;
}

export interface ValueRow {
  points: number;
  samples: DoneSample[];
  median: number;
  /** The learned range: the middle 80% of the hours (the full span below five tasks); null below three tasks. */
  band: { lo: number; hi: number } | null;
}

const BAND_MIN = 3;

/** Done tasks with an estimate and tracked time, grouped by estimate value, ascending. */
export function valueRows(done: readonly DoneSample[]): ValueRow[] {
  const by = new Map<number, DoneSample[]>();
  for (const s of done) {
    const points = s.issue.estimate ?? 0;
    if (points <= 0 || s.ms <= 0) continue;
    by.set(points, [...(by.get(points) ?? []), s]);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([points, samples]) => {
      const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
      const band =
        sorted.length < BAND_MIN
          ? null
          : sorted.length < 5
            ? { lo: sorted[0], hi: sorted[sorted.length - 1] }
            : { lo: quantile(sorted, 0.1), hi: quantile(sorted, 0.9) };
      return { points, samples, median: median(sorted)!, band };
    });
}

export const inBand = (row: ValueRow, ms: number): boolean => !row.band || (ms >= row.band.lo && ms <= row.band.hi);

export interface EstimateSummary {
  /** Share (0–100) of the done tasks inside their learned range; null without a range to compare with. */
  within: number | null;
  /** Mean of tracked / median for the same value, minus 1 (0.12 = 12% above); null below three tasks. */
  drift: number | null;
  points: number;
  tasks: number;
}

export function summarize(rows: readonly ValueRow[]): EstimateSummary {
  let tasks = 0;
  let points = 0;
  let judged = 0;
  let inside = 0;
  let driftSum = 0;
  let driftN = 0;
  for (const r of rows) {
    for (const s of r.samples) {
      tasks += 1;
      points += r.points;
      if (r.band) {
        judged += 1;
        if (inBand(r, s.ms)) inside += 1;
      }
      if (r.median > 0 && r.samples.length >= BAND_MIN) {
        driftSum += s.ms / r.median - 1;
        driftN += 1;
      }
    }
  }
  return {
    within: judged ? Math.round((inside / judged) * 100) : null,
    drift: driftN ? driftSum / driftN : null,
    points,
    tasks,
  };
}

/** A tick step and top (in hours) that fit the longest task, for the x axis of the dot plot. */
export function hoursAxis(maxMs: number): { top: number; ticks: number[] } {
  const maxH = Math.max(1, maxMs / HOUR);
  const step = maxH <= 8 ? 1 : maxH <= 16 ? 2 : maxH <= 40 ? 5 : maxH <= 80 ? 10 : maxH <= 160 ? 20 : 50;
  const top = Math.ceil(maxH / step) * step;
  const ticks: number[] = [];
  for (let h = 0; h <= top; h += step) ticks.push(h);
  return { top, ticks };
}

/** Stable pseudo-random value in [0, 1) for a string, to spread dots that share a spot. */
export function jitter(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

// ───────────────────────────── csv ─────────────────────────────

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

/** Save `text` as a file named `name`. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
