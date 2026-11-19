// People numbers: who has how much open work, who closed what, and the recent activity that is on record.
// Durations are medians of completed tasks only.
import type { DomainEvent, Issue } from '../../core';
import { isRunning, median } from './flow-stats';
import { completedInRange, cycleDays, isCompleted } from './stats-flow';
import { bucketIndex, inRange, toMs, type Bucket, type Range } from './stats-range';

export const UNASSIGNED = 'unassigned';

export interface PersonRow {
  key: string;
  label: string;
  /** Todo, in progress and in review: the backlog is nobody's load yet. */
  load: number;
  todo: number;
  inProgress: number;
  inReview: number;
  points: number;
  stale: number;
  closed: number;
  /** Median days from start to done of what this person closed in the range. */
  medianCycle?: number;
}

/** One row per assignee (and "Unassigned" when it has open work), most open work first. */
export function personRows(
  issues: readonly Issue[],
  range: Range,
  nameOf: (assigneeId: string | undefined) => string,
  isStale: (i: Issue) => boolean,
): PersonRow[] {
  const rows = new Map<string, PersonRow>();
  const row = (id: string | undefined): PersonRow => {
    const key = id ?? UNASSIGNED;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { key, label: nameOf(id), load: 0, todo: 0, inProgress: 0, inReview: 0, points: 0, stale: 0, closed: 0 }));
    return r;
  };
  for (const i of issues) {
    if (i.status === 'todo' || isRunning(i)) {
      const r = row(i.assigneeId);
      r.load += 1;
      r.points += i.estimate ?? 0;
      if (i.status === 'todo') r.todo += 1;
      else if (i.status === 'in_progress') r.inProgress += 1;
      else r.inReview += 1;
      if (isRunning(i) && isStale(i)) r.stale += 1;
    }
  }
  const byPerson = new Map<string, number[]>();
  for (const i of completedInRange(issues, range)) {
    const r = row(i.assigneeId);
    r.closed += 1;
    const d = cycleDays(i);
    if (d !== undefined) byPerson.set(r.key, [...(byPerson.get(r.key) ?? []), d]);
  }
  for (const [key, days] of byPerson) rows.get(key)!.medianCycle = median(days);
  return [...rows.values()].sort(
    (a, b) => Number(a.key === UNASSIGNED) - Number(b.key === UNASSIGNED) || b.load - a.load || b.closed - a.closed || a.label.localeCompare(b.label),
  );
}

export interface PersonSeries {
  key: string;
  label: string;
  values: number[];
}

/**
 * Tasks closed per bucket for the `top` people who closed most in the range, everybody else folded into "Others".
 * Never more than top + 1 series: a stacked chart cannot tell apart a dozen colours.
 */
export function closedByPersonPerBucket(
  issues: readonly Issue[],
  items: readonly Bucket[],
  range: Range,
  nameOf: (assigneeId: string | undefined) => string,
  top = 3,
): PersonSeries[] {
  const totals = new Map<string, number>();
  for (const i of completedInRange(issues, range)) totals.set(i.assigneeId ?? UNASSIGNED, (totals.get(i.assigneeId ?? UNASSIGNED) ?? 0) + 1);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
  const shown = ranked.slice(0, top);
  const series: PersonSeries[] = shown.map((key) => ({
    key,
    label: key === UNASSIGNED ? 'Unassigned' : nameOf(key),
    values: new Array<number>(items.length).fill(0),
  }));
  const others: PersonSeries = { key: 'others', label: 'Others', values: new Array<number>(items.length).fill(0) };
  for (const i of issues) {
    if (!isCompleted(i)) continue;
    const k = bucketIndex(items, toMs(i.completedAt));
    if (k < 0) continue;
    const key = i.assigneeId ?? UNASSIGNED;
    const target = series.find((s) => s.key === key) ?? others;
    target.values[k] += 1;
  }
  return others.values.some((v) => v) ? [...series, others] : series;
}

export interface ActivityRow {
  key: string;
  label: string;
  comments: number;
  statusChanges: number;
  created: number;
  reviews: number;
  total: number;
}

/** What each person (or agent) did according to the events on record in the range. */
export function activityRows(events: readonly DomainEvent[], range: Range, nameOf: (e: DomainEvent) => string): ActivityRow[] {
  const rows = new Map<string, ActivityRow>();
  for (const e of events) {
    if (!inRange(toMs(e.at), range)) continue;
    const field =
      e.type === 'comment.created' ? 'comments'
      : e.type === 'issue.status_changed' ? 'statusChanges'
      : e.type === 'issue.created' ? 'created'
      : e.type === 'review.requested' ? 'reviews'
      : null;
    if (!field) continue;
    const key = `${e.actor.type}:${e.actor.id ?? 'system'}`;
    const row = rows.get(key) ?? { key, label: nameOf(e), comments: 0, statusChanges: 0, created: 0, reviews: 0, total: 0 };
    row[field] += 1;
    row.total += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}
