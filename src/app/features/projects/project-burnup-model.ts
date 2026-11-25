// Pure helpers behind the project page's progress views: the burn-up with its projection to the
// day the work lands at the current pace, the health labels and the "a month early" wording.
// The series themselves come from `buildBurnup` (milestones/milestone-model.ts).
import type { Issue, Milestone, Project } from '../../core';
import { buildBurnup, dayOf, type BurnModel } from '../milestones/milestone-model';

/** The day a project is meant to land: its target date, else the last milestone's. */
export function projectTargetDay(
  project: Pick<Project, 'targetDate'>,
  milestones: readonly Pick<Milestone, 'targetDate'>[],
): number | null {
  if (project.targetDate) return dayOf(project.targetDate);
  let last: number | null = null;
  for (const m of milestones) if (m.targetDate) last = Math.max(last ?? 0, dayOf(m.targetDate));
  return last;
}

export interface BurnView {
  model: BurnModel;
  /** Right edge of the chart. */
  endDay: number;
  /** From today's completed to `toValue` on `toDay`; reaches the scope when the work lands inside the chart. */
  proj: { toDay: number; toValue: number; reachesScope: boolean } | null;
  /** Day the remaining work lands at the current pace. */
  etaDay: number | null;
  /** Days between that day and the target: negative = early. */
  slackDays: number | null;
}

export interface BurnViewInput {
  issues: readonly Issue[];
  points: boolean;
  startDay: number;
  targetDay: number | null;
  today: number;
  /** The chart ends at least here (milestone dates, project target). */
  endHint: number | null;
  /** Days of room after today when nothing else reaches further. */
  pad: number;
}

export function buildBurnView(inp: BurnViewInput): BurnView {
  const model = buildBurnup({
    issues: inp.issues,
    points: inp.points,
    startDay: inp.startDay,
    targetDay: inp.targetDay,
    today: inp.today,
    linkedDay: new Map<string, number>(),
  });
  const endDay = Math.max(inp.today + inp.pad, inp.endHint ?? 0, inp.targetDay ?? 0, model.startDay + 1);
  const last = model.series[model.series.length - 1];
  const remaining = last.scope - last.completed;
  let proj: BurnView['proj'] = null;
  if (model.velocity > 0 && remaining > 0 && last.scope > 0) {
    const eta = model.etaDay ?? inp.today + Math.ceil(remaining / model.velocity);
    proj =
      eta <= endDay
        ? { toDay: eta, toValue: last.scope, reachesScope: true }
        : {
            toDay: endDay,
            toValue: Math.min(last.scope, last.completed + model.velocity * (endDay - inp.today)),
            reachesScope: false,
          };
  }
  const etaDay = model.etaDay;
  const slackDays = etaDay !== null && inp.targetDay !== null ? etaDay - inp.targetDay : null;
  return { model, endDay, proj, etaDay, slackDays };
}

export type BurnTone = 'ok' | 'warn' | 'late' | 'idle';

export interface BurnBadge {
  label: string;
  tone: BurnTone;
}

/** "On track", "At risk", "Past target", "Shipped" / "Completed" and "Not started", from the burn-up model. */
export function burnBadge(model: BurnModel, done = 'Completed', idle = 'Not started'): BurnBadge {
  switch (model.health) {
    case 'done':
      return { label: done, tone: 'ok' };
    case 'on-track':
      return { label: 'On track', tone: 'ok' };
    case 'at-risk':
      return { label: 'At risk', tone: 'warn' };
    case 'late':
      return { label: 'Past target', tone: 'late' };
    default:
      return { label: idle, tone: 'idle' };
  }
}

/** "a month early", "3 days late", "on the date". */
export function slackText(days: number): string {
  const n = Math.abs(days);
  if (n === 0) return 'on the date';
  const span = n < 14 ? `${n} ${n === 1 ? 'day' : 'days'}` : n < 45 ? 'a month' : `${Math.round(n / 30)} months`;
  return `${span} ${days < 0 ? 'early' : 'late'}`;
}

/** "in 18 days", "today", "3 days overdue". */
export function dueText(daysLeft: number): string {
  if (daysLeft === 0) return 'today';
  const n = Math.abs(daysLeft);
  const span = `${n} ${n === 1 ? 'day' : 'days'}`;
  return daysLeft > 0 ? `in ${span}` : `${span} overdue`;
}
