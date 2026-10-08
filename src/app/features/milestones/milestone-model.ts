// Pure helpers behind milestones and the progress (burn-up) chart: day arithmetic, progress in
// points or issues, and the reconstruction of Scope / Started / Completed over time from the
// issues' timestamps (createdAt, link time, startedAt, completedAt).
import type { EstimateScale, Issue, Milestone } from '../../core';

const MS_DAY = 86_400_000;

// ───────────────────────── days ─────────────────────────

/** Whole local calendar day number (days since 1970-01-01 in the viewer's calendar). */
export function dayOf(d: string | number | Date): number {
  const x = d instanceof Date ? d : new Date(d);
  return Math.floor(Date.UTC(x.getFullYear(), x.getMonth(), x.getDate()) / MS_DAY);
}

/** Local midnight of a day number. */
export function dateOfDay(n: number): Date {
  const u = new Date(n * MS_DAY);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

/** ISO string stored for a day: local noon, so every time zone shows the same calendar day. */
export function isoOfDay(n: number): string {
  const d = dateOfDay(n);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString();
}

export const todayDay = (): number => dayOf(new Date());

// ───────────────────────── progress ─────────────────────────

/** Points are used when the workspace scale is on and at least one issue of the set has an estimate. */
export function usesPoints(issues: readonly Issue[], scale: EstimateScale): boolean {
  return scale !== 'none' && issues.some((i) => i.status !== 'canceled' && i.estimate !== undefined && i.estimate !== null);
}

/** Size of an issue: its estimate (1 point when it has none) or 1 issue. */
export const unitsOf = (i: Issue, points: boolean): number => (points ? (i.estimate ?? 1) : 1);

export const isActiveIssue = (i: Issue): boolean => i.status !== 'canceled';

export interface Totals {
  /** All non-canceled issues. */
  scope: number;
  /** Issues that have been started (in progress, in review or done). */
  started: number;
  /** Done. */
  completed: number;
  issues: number;
  doneIssues: number;
  points: boolean;
  /** Issues counted as 1 point because they have no estimate. */
  defaulted: number;
}

export function totalsOf(issues: readonly Issue[], points: boolean): Totals {
  const t: Totals = { scope: 0, started: 0, completed: 0, issues: 0, doneIssues: 0, points, defaulted: 0 };
  for (const i of issues) {
    if (!isActiveIssue(i)) continue;
    const u = unitsOf(i, points);
    t.issues++;
    t.scope += u;
    if (points && (i.estimate === undefined || i.estimate === null)) t.defaulted++;
    if (i.status === 'done') {
      t.completed += u;
      t.doneIssues++;
      t.started += u;
    } else if (i.status === 'in_progress' || i.status === 'in_review') t.started += u;
  }
  return t;
}

export interface MilestoneStats extends Totals {
  /** 0-100, completed / scope. */
  percent: number;
  /** 0-1. */
  fraction: number;
  complete: boolean;
}

export function milestoneStats(issues: readonly Issue[], points: boolean): MilestoneStats {
  const t = totalsOf(issues, points);
  const fraction = t.scope > 0 ? Math.min(1, t.completed / t.scope) : 0;
  return { ...t, percent: Math.round(fraction * 100), fraction, complete: t.scope > 0 && t.completed >= t.scope };
}

export type MilestoneState = 'empty' | 'idle' | 'active' | 'done' | 'overdue';

export function milestoneState(ms: Pick<Milestone, 'targetDate'>, s: MilestoneStats, today = todayDay()): MilestoneState {
  if (s.complete) return 'done';
  if (ms.targetDate && dayOf(ms.targetDate) < today) return 'overdue';
  if (s.issues === 0) return 'empty';
  return s.completed > 0 || s.started > 0 ? 'active' : 'idle';
}

/** "61% of ◬ 7" / "61% of 7 issues". */
export function progressLabel(s: MilestoneStats): string {
  if (s.issues === 0) return 'No issues';
  return s.points ? `${s.percent}% of ◬ ${fmtNum(s.scope)}` : `${s.percent}% of ${s.issues} ${s.issues === 1 ? 'issue' : 'issues'}`;
}

export const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));

/** "◬ 7" or "7 issues". */
export function unitLabel(n: number, points: boolean): string {
  return points ? `◬ ${fmtNum(n)}` : `${fmtNum(n)} ${n === 1 ? 'issue' : 'issues'}`;
}

// ───────────────────────── burn-up ─────────────────────────

export interface BurnPoint {
  day: number;
  scope: number;
  started: number;
  completed: number;
}

export interface BurnBar {
  from: number;
  /** Exclusive. */
  to: number;
  value: number;
}

export interface BurnProjection {
  targetDay: number;
  /** Where completed lands at the current velocity (capped at scope). */
  projectedAtTarget: number;
  /** Completed needed at the target date (= scope). */
  required: number;
  /** Units per day, recent pace. */
  velocity: number;
}

export type BurnHealth = 'done' | 'on-track' | 'at-risk' | 'late' | 'idle';

export interface BurnModel {
  points: boolean;
  startDay: number;
  today: number;
  targetDay: number | null;
  xMax: number;
  series: BurnPoint[];
  bars: BurnBar[];
  totals: Totals;
  projection: BurnProjection | null;
  velocity: number;
  /** Day the remaining work would be done at the current pace (null: no pace / already done). */
  etaDay: number | null;
  overdue: boolean;
  health: BurnHealth;
  yMax: number;
}

export interface BurnInput {
  issues: readonly Issue[];
  points: boolean;
  startDay: number;
  targetDay: number | null;
  today: number;
  /** Day an issue joined the workstream (from `issue.linked` events); falls back to `createdAt`. */
  linkedDay: ReadonlyMap<string, number>;
}

export function buildBurnup(inp: BurnInput): BurnModel {
  const { points, today, targetDay } = inp;
  const startDay = Math.min(inp.startDay, today - 6);
  const n = today - startDay + 1;
  const dScope = new Array<number>(n + 1).fill(0);
  const dStart = new Array<number>(n + 1).fill(0);
  const dComp = new Array<number>(n + 1).fill(0);
  const at = (d: number): number => Math.max(0, Math.min(n - 1, d - startDay));

  for (const i of inp.issues) {
    if (!isActiveIssue(i)) continue;
    const u = unitsOf(i, points);
    const done = i.status === 'done';
    const started = done || i.status === 'in_progress' || i.status === 'in_review';
    const doneDay = done ? dayOf(i.completedAt ?? i.updatedAt) : undefined;
    const startedDay = started ? dayOf(i.startedAt ?? (done ? (i.completedAt ?? i.updatedAt) : i.updatedAt)) : undefined;
    let added = inp.linkedDay.get(i.id) ?? dayOf(i.createdAt);
    if (startedDay !== undefined) added = Math.min(added, startedDay);
    if (doneDay !== undefined) added = Math.min(added, doneDay);
    dScope[at(added)] += u;
    if (startedDay !== undefined) dStart[at(Math.min(startedDay, doneDay ?? startedDay))] += u;
    if (doneDay !== undefined) dComp[at(doneDay)] += u;
  }

  const series: BurnPoint[] = [];
  let s = 0;
  let st = 0;
  let c = 0;
  for (let k = 0; k < n; k++) {
    s += dScope[k];
    st += dStart[k];
    c += dComp[k];
    series.push({ day: startDay + k, scope: s, started: Math.max(st, c), completed: c });
  }
  const last = series[n - 1];

  // completions per period
  const bucket = n <= 70 ? 7 : n <= 200 ? 14 : 30;
  const bars: BurnBar[] = [];
  for (let from = startDay; from <= today; from += bucket) {
    const to = Math.min(from + bucket, today + 1);
    let v = 0;
    for (let d = from; d < to; d++) v += dComp[d - startDay];
    bars.push({ from, to, value: v });
  }

  // pace over the last 4 weeks (or since the start)
  const window = Math.min(28, Math.max(1, n - 1));
  const before = series[Math.max(0, n - 1 - window)].completed;
  const recent = (last.completed - before) / window;
  const overall = last.completed / Math.max(1, n - 1);
  const velocity = recent > 0 ? recent : overall;
  const remaining = last.scope - last.completed;
  const done = last.scope > 0 && remaining <= 0;
  const etaDay = !done && velocity > 0 ? today + Math.ceil(remaining / velocity) : null;

  let projection: BurnProjection | null = null;
  if (targetDay !== null && targetDay > today && !done && last.scope > 0) {
    const projectedAtTarget = Math.min(last.scope, last.completed + velocity * (targetDay - today));
    projection = { targetDay, projectedAtTarget, required: last.scope, velocity };
  }
  const overdue = targetDay !== null && today > targetDay && !done && last.scope > 0;
  let health: BurnHealth = 'idle';
  if (done) health = 'done';
  else if (overdue) health = 'late';
  else if (last.scope === 0 || (last.completed === 0 && velocity === 0 && last.started === 0)) health = 'idle';
  else if (projection) health = projection.projectedAtTarget >= projection.required * 0.97 ? 'on-track' : 'at-risk';
  else health = 'on-track';

  const xMax = Math.max(today, targetDay ?? today, startDay + 1);
  const yMax = Math.max(last.scope, projection?.projectedAtTarget ?? 0, 1);
  return { points, startDay, today, targetDay, xMax, series, bars, totals: totalsOf(inp.issues, points), projection, velocity, etaDay, overdue, health, yMax };
}

/** Collapse flat runs so long daily series stay a short path. */
export function simplify<T extends { day: number }>(list: readonly T[], value: (p: T) => number): T[] {
  return list.filter((p, i) => i === 0 || i === list.length - 1 || value(p) !== value(list[i - 1]) || value(p) !== value(list[i + 1]));
}
