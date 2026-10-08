// Insights of one project, computed from the issues / milestones / workstreams already in the store.
// Pure functions: the tab passes the records and `now`, nothing here reads the store.
import { addDays, differenceInCalendarDays, format, startOfDay, startOfWeek } from 'date-fns';
import type {
  Issue,
  IssueStatus,
  Milestone,
  Priority,
  Project,
  Workstream,
} from '../../core/contracts/domain';

const DAY = 86_400_000;

const isCanceled = (i: Issue): boolean => i.status === 'canceled';
const isDone = (i: Issue): boolean => i.status === 'done';
/** In the scope of the project: canceled issues do not count. */
const inScope = (i: Issue): boolean => !isCanceled(i);
const isOpen = (i: Issue): boolean => i.status !== 'done' && i.status !== 'canceled';

const ms = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** When an issue was finished; falls back to its last update when the server has no completion stamp. */
const finishedAt = (i: Issue): number | undefined => ms(i.completedAt) ?? ms(i.updatedAt);

export interface ProjectKpis {
  /** Issues in scope (canceled excluded). */
  total: number;
  canceled: number;
  done: number;
  /** done / total, 0-100. */
  percent: number;
  open: number;
  /** In progress + in review. */
  active: number;
  /** Open issues nobody is assigned to. */
  unassigned: number;
  /** Workstreams of the project that are blocked. */
  blockedWorkstreams: number;
  /** Whole days until the target date (negative = overdue); undefined without a target. */
  daysLeft?: number;
}

export interface BurnUp {
  labels: string[];
  titles: string[];
  scope: number[];
  started: number[];
  completed: number[];
}

export interface VelocityWeek {
  label: string;
  title: string;
  done: number;
  /** Mean of this week and the two before it. */
  average: number;
}

export interface Forecast {
  /** Issues closed per week over the last four weeks. */
  perWeek: number;
  remaining: number;
  /** Estimated completion; undefined when nothing was closed recently or nothing is left. */
  etaAt?: number;
  /** Days between the estimate and the target date (positive = after it). */
  daysVsTarget?: number;
  kind: 'done' | 'no_pace' | 'estimate';
}

export interface MilestoneProgress {
  id: string;
  name: string;
  targetDate?: string;
  total: number;
  done: number;
  percent: number;
  late: boolean;
}

export interface CountRow {
  key: string;
  label: string;
  value: number;
  /** Extra tooltip text. */
  detail: string;
}

export interface ProjectStats {
  kpis: ProjectKpis;
  burnUp: BurnUp | null;
  velocity: VelocityWeek[];
  forecast: Forecast;
  statusCounts: { status: IssueStatus; count: number }[];
  priorityCounts: { priority: Priority; count: number }[];
  assignees: CountRow[];
  milestones: MilestoneProgress[];
  /** Cumulative completed count, one entry per burn-up point (for the KPI sparkline). */
  completedTrend: number[];
}

export interface ProjectStatsInput {
  project: Project;
  issues: readonly Issue[];
  workstreams: readonly Workstream[];
  milestones: readonly Milestone[];
  /** Resolves an assignee id to a display name. */
  userName: (id: string) => string | undefined;
  weekStartsOn: 0 | 1 | 6;
  now: number;
}

export function projectStats(input: ProjectStatsInput): ProjectStats {
  const { project, issues, now } = input;
  const scoped = issues.filter(inScope);
  const done = scoped.filter(isDone).length;
  const total = scoped.length;
  const target = ms(project.targetDate);

  const kpis: ProjectKpis = {
    total,
    canceled: issues.length - total,
    done,
    percent: total ? Math.round((done / total) * 100) : 0,
    open: scoped.filter(isOpen).length,
    active: scoped.filter((i) => i.status === 'in_progress' || i.status === 'in_review').length,
    unassigned: scoped.filter((i) => isOpen(i) && !i.assigneeId).length,
    blockedWorkstreams: input.workstreams.filter((w) => w.status === 'blocked').length,
    daysLeft:
      target === undefined ? undefined : differenceInCalendarDays(new Date(target), new Date(now)),
  };

  const burn = burnUp(project, issues, now);
  return {
    kpis,
    burnUp: burn?.series ?? null,
    completedTrend: burn?.series.completed ?? [],
    velocity: velocity(issues, now, input.weekStartsOn),
    forecast: forecast(issues, kpis, target, now),
    statusCounts: countBy(issues, (i) => i.status).map(([status, count]) => ({ status, count })),
    priorityCounts: countBy(scoped, (i) => i.priority).map(([priority, count]) => ({
      priority,
      count,
    })),
    assignees: assigneeRows(scoped, input.userName),
    milestones: milestoneRows(input.milestones, issues, now),
  };
}

function countBy<K extends string>(items: readonly Issue[], key: (i: Issue) => K): [K, number][] {
  const map = new Map<K, number>();
  for (const i of items) map.set(key(i), (map.get(key(i)) ?? 0) + 1);
  return [...map.entries()];
}

/** Scope vs started vs completed over time, from `createdAt`, `startedAt` and `completedAt`. */
function burnUp(
  project: Project,
  issues: readonly Issue[],
  now: number,
): { series: BurnUp } | null {
  const created = issues.map((i) => ms(i.createdAt)).filter((t): t is number => t !== undefined);
  if (!created.length) return null;
  const closedAt =
    project.status === 'completed' || project.status === 'canceled'
      ? ms(project.completedAt)
      : undefined;
  const end = Math.max(
    startOfDay(closedAt ?? now).getTime(),
    startOfDay(Math.min(...created)).getTime(),
  );
  const start = startOfDay(Math.min(...created)).getTime();
  const days = Math.max(1, Math.round((end - start) / DAY));
  const step = [1, 2, 7, 14, 30].find((s) => days / s <= 45) ?? 30;

  const points: number[] = [];
  for (let t = start; t < end; t = addDays(t, step).getTime()) points.push(t);
  points.push(end);

  const finish = issues.map((i) => (isDone(i) || isCanceled(i) ? finishedAt(i) : undefined));
  const labels: string[] = [];
  const titles: string[] = [];
  const scope: number[] = [];
  const started: number[] = [];
  const completed: number[] = [];
  for (const point of points) {
    // The whole day counts, so a point is the end of its day (the last one is "now" itself).
    const upTo = point === end && closedAt === undefined ? now : point + DAY - 1;
    let s = 0;
    let st = 0;
    let c = 0;
    issues.forEach((i, idx) => {
      const createdAt = ms(i.createdAt);
      if (createdAt === undefined || createdAt > upTo) return;
      const f = finish[idx];
      if (isCanceled(i) && f !== undefined && f <= upTo) return;
      s++;
      if (isDone(i) && f !== undefined && f <= upTo) {
        c++;
        st++;
        return;
      }
      const startedAt = ms(i.startedAt);
      if (startedAt !== undefined && startedAt <= upTo) st++;
    });
    scope.push(s);
    started.push(st);
    completed.push(c);
    labels.push(format(point, 'MMM d'));
    titles.push(format(point, 'MMM d, yyyy'));
  }
  return { series: { labels, titles, scope, started, completed } };
}

/** Issues closed per week, the latest eight weeks (the current one is partial). */
function velocity(issues: readonly Issue[], now: number, weekStartsOn: 0 | 1 | 6): VelocityWeek[] {
  const finished = issues
    .filter(isDone)
    .map(finishedAt)
    .filter((t): t is number => t !== undefined);
  if (!finished.length) return [];
  const thisWeek = startOfWeek(now, { weekStartsOn }).getTime();
  const first = startOfWeek(Math.min(...finished), { weekStartsOn }).getTime();
  const weeks = Math.min(8, Math.round((thisWeek - first) / (7 * DAY)) + 1);
  // Two extra weeks in front only feed the rolling average.
  const buckets: { at: number; done: number }[] = [];
  for (let k = weeks + 1; k >= 0; k--)
    buckets.push({ at: addDays(thisWeek, -7 * k).getTime(), done: 0 });
  for (const t of finished) {
    const idx = Math.floor((t - buckets[0].at) / (7 * DAY));
    if (idx >= 0 && idx < buckets.length) buckets[idx].done++;
  }
  return buckets.slice(2).map((b, i) => {
    const window = buckets.slice(i, i + 3);
    return {
      label: format(b.at, 'MMM d'),
      title: `Week of ${format(b.at, 'MMM d, yyyy')}`,
      done: b.done,
      average: +(window.reduce((n, w) => n + w.done, 0) / 3).toFixed(1),
    };
  });
}

/** Naive straight-line estimate: remaining issues at the pace of the last four weeks. */
function forecast(
  issues: readonly Issue[],
  kpis: ProjectKpis,
  target: number | undefined,
  now: number,
): Forecast {
  const remaining = kpis.open;
  const recent = issues.filter((i) => {
    const f = isDone(i) ? finishedAt(i) : undefined;
    return f !== undefined && f > now - 28 * DAY && f <= now;
  }).length;
  const perWeek = +(recent / 4).toFixed(1);
  if (remaining === 0) return { perWeek, remaining, kind: 'done' };
  if (recent === 0) return { perWeek, remaining, kind: 'no_pace' };
  const etaAt = now + (remaining / (recent / 28)) * DAY;
  return {
    perWeek,
    remaining,
    etaAt,
    daysVsTarget:
      target === undefined
        ? undefined
        : differenceInCalendarDays(new Date(etaAt), new Date(target)),
    kind: 'estimate',
  };
}

function assigneeRows(
  scoped: readonly Issue[],
  userName: (id: string) => string | undefined,
): CountRow[] {
  const groups = new Map<string, { label: string; open: number; done: number }>();
  for (const i of scoped) {
    const key = i.assigneeId ?? '';
    const g = groups.get(key) ?? {
      label: i.assigneeId ? (userName(i.assigneeId) ?? 'Unknown') : 'Unassigned',
      open: 0,
      done: 0,
    };
    if (isDone(i)) g.done++;
    else g.open++;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      key: key || 'unassigned',
      label: g.label,
      value: g.open,
      detail: `${g.label}: ${g.open} open, ${g.done} done`,
      sort: g.open + g.done,
    }))
    .sort((a, b) => b.value - a.value || b.sort - a.sort || a.label.localeCompare(b.label))
    .map(({ sort: _sort, ...row }) => row)
    .filter((r) => r.value > 0)
    .slice(0, 8);
}

function milestoneRows(
  milestones: readonly Milestone[],
  issues: readonly Issue[],
  now: number,
): MilestoneProgress[] {
  return [...milestones]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((m) => {
      const inMilestone = issues.filter((i) => inScope(i) && i.milestoneIds.includes(m.id));
      const done = inMilestone.filter(isDone).length;
      const percent = inMilestone.length ? Math.round((done / inMilestone.length) * 100) : 0;
      const target = ms(m.targetDate);
      return {
        id: m.id,
        name: m.name,
        targetDate: m.targetDate,
        total: inMilestone.length,
        done,
        percent,
        late: target !== undefined && percent < 100 && target < now,
      };
    });
}
