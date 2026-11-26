// Pure helpers of the task's Time tab: what was tracked on a task today and in total (a running timer counts up
// to now), and the clock text. No Angular, so they are cheap to test.
import type { TimeEntry } from '../../core/api/api.types';

export interface TaskTracked {
  /** Tracked since the start of the local day, running timer included. */
  todayMs: number;
  /** Everything tracked on the task, running timer included. */
  totalMs: number;
  /** Elapsed time of a timer running on this task, 0 when none. */
  runningMs: number;
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `01:02:03`. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Time tracked on `issueId`. An entry without an end is a running timer and counts up to `now`. */
export function trackedOn(entries: readonly TimeEntry[], issueId: string, now: number): TaskTracked {
  const day = startOfDay(now);
  const out: TaskTracked = { todayMs: 0, totalMs: 0, runningMs: 0 };
  for (const e of entries) {
    if (e.issueId !== issueId || e.source === 'suggested') continue;
    const start = Date.parse(e.startedAt);
    const end = e.endedAt ? Date.parse(e.endedAt) : now;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    out.totalMs += end - start;
    out.todayMs += Math.max(0, end - Math.max(start, day));
    if (!e.endedAt) out.runningMs = end - start;
  }
  return out;
}

/** Entries of a task, newest first. */
export function entriesOf(entries: readonly TimeEntry[], issueId: string): TimeEntry[] {
  return entries
    .filter((e) => e.issueId === issueId && e.source !== 'suggested')
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/** The running timer, whatever task it is on. */
export function runningEntry(entries: readonly TimeEntry[]): TimeEntry | null {
  return entries.find((e) => !e.endedAt) ?? null;
}

/** `date` at `HH:MM` in the local time zone. */
export function atTime(date: Date, time: string): Date {
  const [h, m] = time.split(':').map(Number);
  const out = new Date(date);
  out.setHours(h || 0, m || 0, 0, 0);
  return out;
}

/** `HH:MM` of an ISO instant in the local time zone, for a time input. */
export function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Why a manual entry cannot be saved, or null. */
export function entryProblem(day: Date, from: string, to: string, now: number): string | null {
  if (!from || !to) return 'Set a start and an end time.';
  const start = atTime(day, from).getTime();
  const end = atTime(day, to).getTime();
  if (end <= start) return 'The end time must be after the start time.';
  if (start > now) return 'The start time is in the future.';
  return null;
}
