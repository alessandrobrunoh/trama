// Project numbers: progress, the projected end (the same forecast the Timeline page draws), milestones hit or
// missed, and scope added against work closed. Pure functions: nothing here reads a store or a clock.
import { endOfDay } from 'date-fns';
import type { Issue, Milestone, Project } from '../../core';
import { forecastProject, type ForecastTask, type ProjectForecast } from '../timeline/timeline-model';
import { isCompleted, stateAt } from './stats-flow';
import { DAY, bucketIndex, inRange, toMs, type Bucket, type Range } from './stats-range';

/** The tasks the forecast and the progress bar count: canceled ones are out of scope. */
export const inScope = (issues: readonly Issue[]): Issue[] => issues.filter((i) => i.status !== 'canceled');

export function forecastTasks(issues: readonly Issue[]): ForecastTask[] {
  return issues.map((i) =>
    i.status === 'done'
      ? { state: 'done', completedAt: i.completedAt ?? i.updatedAt }
      : i.status === 'canceled'
        ? { state: 'canceled' }
        : { state: 'open' },
  );
}

export interface MilestoneRow {
  milestone: Milestone;
  /** Tasks in scope in the milestone (canceled ones are left out). */
  total: number;
  done: number;
  state: 'hit' | 'hit_late' | 'missed' | 'upcoming' | 'no_date' | 'empty';
  /** Days between the target and the day the last task was done (hit) or today (missed, upcoming): positive = after it. */
  daysAfterTarget?: number;
  hitAt?: number;
}

export function milestoneRow(milestone: Milestone, issues: readonly Issue[], now: number): MilestoneRow {
  const tasks = inScope(issues);
  const done = tasks.filter((i) => i.status === 'done').length;
  const row: MilestoneRow = { milestone, total: tasks.length, done, state: 'empty' };
  const target = toMs(milestone.targetDate);
  const targetEnd = target === undefined ? undefined : endOfDay(target).getTime();
  const diff = (at: number): number | undefined =>
    targetEnd === undefined ? undefined : at > targetEnd ? Math.ceil((at - targetEnd) / DAY) : -Math.floor((targetEnd - at) / DAY);
  if (!tasks.length) return row;
  if (done === tasks.length) {
    const hitAt = Math.max(...tasks.map((i) => toMs(i.completedAt) ?? toMs(i.updatedAt) ?? 0));
    const late = targetEnd !== undefined && hitAt > targetEnd;
    return { ...row, hitAt, state: late ? 'hit_late' : 'hit', daysAfterTarget: diff(hitAt) };
  }
  if (targetEnd === undefined) return { ...row, state: 'no_date' };
  if (now > targetEnd) return { ...row, state: 'missed', daysAfterTarget: diff(now) };
  return { ...row, state: 'upcoming', daysAfterTarget: diff(now) };
}

export interface ProjectRow {
  project: Project;
  total: number;
  done: number;
  open: number;
  created: number;
  closed: number;
  /** Closed per week over the forecast window (the pace the projection uses). */
  perWeek: number;
  forecast: ProjectForecast;
  milestones: MilestoneRow[];
}

const ACTIVE_PROJECT_ORDER: Record<string, number> = { in_progress: 0, planned: 1, paused: 2, backlog: 3, completed: 4, canceled: 5 };

/** One row per project, running projects first, then by name. */
export function projectRows(
  projects: readonly Project[],
  issuesOf: (projectId: string) => readonly Issue[],
  milestonesOf: (projectId: string) => readonly Milestone[],
  now: number,
  range: Range,
): ProjectRow[] {
  return projects
    .map((project) => {
      const issues = issuesOf(project.id);
      const forecast = forecastProject({
        now: new Date(now),
        startDate: project.startDate,
        targetDate: project.targetDate,
        createdAt: project.createdAt,
        closed: project.status === 'completed' || project.status === 'canceled',
        tasks: forecastTasks(issues),
      });
      const issuesOfMilestone = (m: Milestone) => issues.filter((i) => i.milestoneIds.includes(m.id));
      return {
        project,
        total: forecast.total,
        done: forecast.done,
        open: forecast.open,
        created: issues.filter((i) => inRange(toMs(i.createdAt), range)).length,
        closed: issues.filter((i) => isCompleted(i) && inRange(toMs(i.completedAt), range)).length,
        perWeek: forecast.perWeek,
        forecast,
        milestones: milestonesOf(project.id)
          .map((m) => milestoneRow(m, issuesOfMilestone(m), now))
          .sort((a, b) => a.milestone.sortOrder - b.milestone.sortOrder),
      };
    })
    .sort(
      (a, b) =>
        (ACTIVE_PROJECT_ORDER[a.project.status] ?? 9) - (ACTIVE_PROJECT_ORDER[b.project.status] ?? 9) ||
        a.project.name.localeCompare(b.project.name),
    );
}

export interface MilestoneTotals {
  hit: number;
  hitLate: number;
  missed: number;
  upcoming: number;
  /** Milestones that have a date and tasks, i.e. the ones that can be hit or missed. */
  dated: number;
}

export function milestoneTotals(rows: readonly MilestoneRow[]): MilestoneTotals {
  const count = (s: MilestoneRow['state']) => rows.filter((r) => r.state === s).length;
  const hit = count('hit');
  const hitLate = count('hit_late');
  const missed = count('missed');
  const upcoming = count('upcoming');
  return { hit, hitLate, missed, upcoming, dated: hit + hitLate + missed + upcoming };
}

/** Tasks added to a scope (created) and tasks closed from it, per bucket. */
export function scopeVsClosed(issues: readonly Issue[], items: readonly Bucket[]): { added: number[]; closed: number[] } {
  const added = new Array<number>(items.length).fill(0);
  const closed = new Array<number>(items.length).fill(0);
  for (const i of issues) {
    if (i.status === 'canceled') continue;
    const a = bucketIndex(items, toMs(i.createdAt));
    if (a >= 0) added[a] += 1;
    if (isCompleted(i)) {
      const c = bucketIndex(items, toMs(i.completedAt));
      if (c >= 0) closed[c] += 1;
    }
  }
  return { added, closed };
}

/** Burn-up: all tasks in scope and all tasks done at each moment. */
export function burnup(issues: readonly Issue[], times: readonly number[], now: number): { scope: number[]; done: number[] } {
  const scope: number[] = [];
  const done: number[] = [];
  for (const t of times) {
    let s = 0;
    let d = 0;
    for (const i of issues) {
      const state = stateAt(i, t, now);
      if (state === 'none') continue;
      s += 1;
      if (state === 'done') d += 1;
    }
    scope.push(s);
    done.push(d);
  }
  return { scope, done };
}
