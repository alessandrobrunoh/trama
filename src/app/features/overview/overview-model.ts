// The Overview, as data: a briefing about the workspace. Everything here is a pure function over plain inputs
// (`now` and the status classifiers are passed in), so the rules are testable without the store.
//
//   headline      one sentence generated from the numbers ("12 tasks moving, 3 stuck. Atlas is 9 days behind.")
//   lanes         who is working on what right now
//   dailyFlow     the last 4 weeks, one column per day: tasks closed against tasks opened, with events pinned on it
//   projectRows   each open project: progress, momentum and the projected end against its target
//   watchlist     the few things most worth looking at, each with a plain reason
//
// The project forecast is the Timeline's (`forecastProject`), so both pages always agree on "at risk".
import { addDays, differenceInCalendarDays, format, startOfDay, subDays } from 'date-fns';
import type { AttentionItem, Issue, Milestone, Project } from '../../core/contracts/domain';
import type { RightPaneContent } from '../../core/stores/right-pane.store';
import {
  forecastProject,
  type ForecastTask,
  type ProjectForecast,
  type SignalKind,
} from '../timeline/timeline-model';

export const DAY_MS = 86_400_000;
/** Days the river covers: four weeks. */
export const FLOW_DAYS = 28;
/** How many things the watchlist shows. */
export const WATCH_LIMIT = 5;

export type Phase = 'open' | 'active' | 'done' | 'canceled';

/** `in_progress` / `in_review` are work in flight, `done` / `canceled` are closed, the rest is waiting. */
export function phaseOf(type: string | undefined): Phase {
  if (type === 'in_progress' || type === 'in_review') return 'active';
  if (type === 'done') return 'done';
  if (type === 'canceled') return 'canceled';
  return 'open';
}

export interface RunningTimer {
  issueId: string;
  userId: string;
  startedAt: string;
}

export interface OverviewContext {
  now: Date;
  issues: readonly Issue[];
  projects: readonly Project[];
  milestones: readonly Milestone[];
  /** Semantic status type of a stored issue / project status (workspace statuses can be renamed). */
  issueType: (status: string) => string | undefined;
  projectType: (status: string) => string | undefined;
  /** Display name of a status, for reasons ("In review, untouched for 9 days"). */
  issueLabel: (status: string) => string;
  /** When something last happened on a task (ms), as `activityLookup` computes it. */
  activityAt: (issue: Issue) => number;
  idleDays: number;
  /** Open attention items for the current user (the server's queue). */
  attention: readonly AttentionItem[];
  timers: readonly RunningTimer[];
}

const ms = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const phaseOfIssue = (ctx: OverviewContext, i: Issue): Phase => phaseOf(ctx.issueType(i.status));

/** When a task was closed: its completion, else its last update (the Timeline's rule). */
const closedAtOf = (i: Issue): number | undefined => ms(i.completedAt) ?? ms(i.updatedAt);

const taskTarget = (i: Issue): RightPaneContent => ({ kind: 'task', idOrKey: i.key });
const projectTarget = (id: string): RightPaneContent => ({ kind: 'project', id });

const idleDaysOf = (ctx: OverviewContext, i: Issue): number =>
  Math.max(0, Math.floor((ctx.now.getTime() - ctx.activityAt(i)) / DAY_MS));

// ───────────────────────────── the river: 4 weeks, one column per day ─────────────────────────────

export type FlowEventKind = 'milestone_hit' | 'milestone_missed' | 'project_done';

export interface FlowEvent {
  kind: FlowEventKind;
  label: string;
  target: RightPaneContent;
}

export interface FlowDay {
  date: Date;
  /** `yyyy-MM-dd` (local). */
  key: string;
  created: number;
  closed: number;
  today: boolean;
  weekend: boolean;
  events: FlowEvent[];
}

const dayKey = (d: Date): string => format(d, 'yyyy-MM-dd');

/** Per day of the last `days` days (oldest first, ending today): tasks opened, tasks closed and what was pinned there. */
export function dailyFlow(ctx: OverviewContext, days = FLOW_DAYS): FlowDay[] {
  const today = startOfDay(ctx.now);
  const first = subDays(today, days - 1);
  const out: FlowDay[] = Array.from({ length: days }, (_, n) => {
    const date = addDays(first, n);
    const dow = date.getDay();
    return {
      date,
      key: dayKey(date),
      created: 0,
      closed: 0,
      today: n === days - 1,
      weekend: dow === 0 || dow === 6,
      events: [],
    };
  });
  const slot = (t: number | undefined): FlowDay | undefined => {
    if (t === undefined) return undefined;
    const n = differenceInCalendarDays(new Date(t), first);
    return n >= 0 && n < days ? out[n] : undefined;
  };

  for (const i of ctx.issues) {
    const created = slot(ms(i.createdAt));
    if (created) created.created++;
    if (phaseOfIssue(ctx, i) === 'done') {
      const closed = slot(closedAtOf(i));
      if (closed) closed.closed++;
    }
  }

  const issuesOf = new Map<string, Issue[]>();
  for (const i of ctx.issues) {
    for (const id of i.milestoneIds) {
      const list = issuesOf.get(id);
      if (list) list.push(i);
      else issuesOf.set(id, [i]);
    }
  }
  for (const m of ctx.milestones) {
    const scoped = (issuesOf.get(m.id) ?? []).filter((i) => phaseOfIssue(ctx, i) !== 'canceled');
    const complete = scoped.length > 0 && scoped.every((i) => phaseOfIssue(ctx, i) === 'done');
    if (complete) {
      const at = Math.max(...scoped.map((i) => closedAtOf(i) ?? 0));
      slot(at)?.events.push({ kind: 'milestone_hit', label: `${m.name} reached`, target: projectTarget(m.projectId) });
      continue;
    }
    const due = ms(m.targetDate);
    if (due !== undefined && due < ctx.now.getTime()) {
      slot(due)?.events.push({ kind: 'milestone_missed', label: `${m.name} was due`, target: projectTarget(m.projectId) });
    }
  }
  for (const p of ctx.projects) {
    if (ctx.projectType(p.status) !== 'completed') continue;
    slot(ms(p.completedAt))?.events.push({ kind: 'project_done', label: `${p.name} completed`, target: projectTarget(p.id) });
  }
  return out;
}

export interface WeekTotal {
  /** First day of the 7-day block. */
  start: Date;
  created: number;
  closed: number;
  current: boolean;
}

/** The river cut into 7-day blocks, oldest first; the last one ends today. */
export function weekTotals(flow: readonly FlowDay[]): WeekTotal[] {
  const out: WeekTotal[] = [];
  for (let at = 0; at + 7 <= flow.length; at += 7) {
    const block = flow.slice(at, at + 7);
    out.push({
      start: block[0].date,
      created: block.reduce((n, d) => n + d.created, 0),
      closed: block.reduce((n, d) => n + d.closed, 0),
      current: at + 7 === flow.length,
    });
  }
  return out;
}

// ───────────────────────────── now: who is on what ─────────────────────────────

export interface LaneTask {
  issue: Issue;
  /** Days since anything happened on it. */
  idleDays: number;
  idle: boolean;
  /** The current user's running timer on it. */
  timer?: RunningTimer;
}

export interface Lane {
  /** Assignee user id; `null` for work nobody owns. */
  userId: string | null;
  tasks: LaneTask[];
  /** How many of the tasks are idle. */
  idle: number;
  running: boolean;
}

/** One lane per assignee with the tasks they have in flight; people with a running timer first, unowned work last. */
export function lanes(ctx: OverviewContext): Lane[] {
  const timers = new Map(ctx.timers.map((t) => [t.issueId, t]));
  const by = new Map<string | null, LaneTask[]>();
  for (const issue of ctx.issues) {
    if (phaseOfIssue(ctx, issue) !== 'active') continue;
    const idleDays = idleDaysOf(ctx, issue);
    const task: LaneTask = { issue, idleDays, idle: idleDays >= ctx.idleDays, timer: timers.get(issue.id) };
    const key = issue.assigneeId ?? null;
    const list = by.get(key);
    if (list) list.push(task);
    else by.set(key, [task]);
  }
  return [...by.entries()]
    .map(([userId, tasks]) => ({
      userId,
      tasks: tasks.sort(
        (a, b) => Number(!!b.timer) - Number(!!a.timer) || a.idleDays - b.idleDays || a.issue.key.localeCompare(b.issue.key),
      ),
      idle: tasks.filter((t) => t.idle).length,
      running: tasks.some((t) => t.timer),
    }))
    .sort(
      (a, b) =>
        Number(a.userId === null) - Number(b.userId === null) ||
        Number(b.running) - Number(a.running) ||
        b.tasks.length - a.tasks.length,
    );
}

// ───────────────────────────── projects ─────────────────────────────

export type Momentum = 'up' | 'down' | 'flat' | 'none';

export interface ProjectRow {
  project: Project;
  forecast: ProjectForecast;
  signal: SignalKind;
  done: number;
  active: number;
  open: number;
  total: number;
  /** 0-100, done of in-scope tasks. */
  percent: number;
  /** Tasks closed in the last 7 days against the 7 before. */
  closedThisWeek: number;
  closedLastWeek: number;
  momentum: Momentum;
  target?: Date;
  projectedEnd?: Date;
  /** Days behind the target: the projected overshoot, or how long ago an unfinished target passed. Positive = late. */
  behindDays?: number;
}

const SIGNAL_RANK: Record<SignalKind, number> = {
  off_track: 0,
  at_risk: 1,
  not_enough_data: 2,
  no_target: 3,
  on_track: 4,
  closed: 5,
};

/** Open projects (completed and canceled ones are left out), most worrying first. */
export function projectRows(ctx: OverviewContext): ProjectRow[] {
  const today = startOfDay(ctx.now);
  const now = ctx.now.getTime();
  const byProject = new Map<string, Issue[]>();
  for (const i of ctx.issues) {
    if (!i.projectId) continue;
    const list = byProject.get(i.projectId);
    if (list) list.push(i);
    else byProject.set(i.projectId, [i]);
  }
  const rows: ProjectRow[] = [];
  for (const project of ctx.projects) {
    const type = ctx.projectType(project.status);
    if (type === 'completed' || type === 'canceled') continue;
    const issues = byProject.get(project.id) ?? [];
    const tasks: ForecastTask[] = issues.map((i) => {
      const phase = phaseOfIssue(ctx, i);
      return phase === 'done'
        ? { state: 'done', completedAt: i.completedAt ?? i.updatedAt }
        : phase === 'canceled'
          ? { state: 'canceled' }
          : { state: 'open' };
    });
    const forecast = forecastProject({
      now: ctx.now,
      startDate: project.startDate,
      targetDate: project.targetDate,
      createdAt: project.createdAt,
      tasks,
    });
    let active = 0;
    let closedThisWeek = 0;
    let closedLastWeek = 0;
    for (const i of issues) {
      const phase = phaseOfIssue(ctx, i);
      if (phase === 'active') active++;
      if (phase !== 'done') continue;
      const at = closedAtOf(i);
      if (at === undefined) continue;
      if (at > now - 7 * DAY_MS && at <= now + DAY_MS) closedThisWeek++;
      else if (at > now - 14 * DAY_MS && at <= now - 7 * DAY_MS) closedLastWeek++;
    }
    const target = project.targetDate ? startOfDay(new Date(project.targetDate)) : undefined;
    const overdue = target && forecast.open > 0 ? differenceInCalendarDays(today, target) : undefined;
    const late = Math.max(forecast.daysVsTarget ?? Number.NEGATIVE_INFINITY, overdue ?? Number.NEGATIVE_INFINITY);
    rows.push({
      project,
      forecast,
      signal: forecast.signal,
      done: forecast.done,
      active,
      open: Math.max(0, forecast.open - active),
      total: forecast.total,
      percent: forecast.total ? Math.round((forecast.done / forecast.total) * 100) : 0,
      closedThisWeek,
      closedLastWeek,
      momentum:
        closedThisWeek === 0 && closedLastWeek === 0
          ? 'none'
          : closedThisWeek > closedLastWeek
            ? 'up'
            : closedThisWeek < closedLastWeek
              ? 'down'
              : 'flat',
      target,
      projectedEnd: forecast.projectedEnd,
      behindDays: Number.isFinite(late) ? late : undefined,
    });
  }
  return rows.sort(
    (a, b) =>
      SIGNAL_RANK[a.signal] - SIGNAL_RANK[b.signal] ||
      (b.behindDays ?? Number.NEGATIVE_INFINITY) - (a.behindDays ?? Number.NEGATIVE_INFINITY) ||
      a.project.name.localeCompare(b.project.name),
  );
}

export interface TrackScale {
  from: Date;
  to: Date;
  todayPos: number;
  /** 0 to 1 along the track; dates outside the window sit on its edge. */
  pos: (date: Date) => number;
  /** Month marks that fit under the track. */
  ticks: { pos: number; label: string }[];
}

/** One shared time axis for every project's "target against projected end" track: today, plus what the rows need. */
export function trackScale(rows: readonly ProjectRow[], now: Date): TrackScale {
  const today = startOfDay(now);
  let lo = today.getTime();
  let hi = addDays(today, 42).getTime();
  const floor = subDays(today, 45).getTime();
  const ceil = addDays(today, 400).getTime();
  for (const r of rows) {
    for (const d of [r.target, r.projectedEnd]) {
      if (!d) continue;
      lo = Math.min(lo, Math.max(floor, d.getTime()));
      hi = Math.max(hi, Math.min(ceil, d.getTime()));
    }
  }
  const pad = Math.max(DAY_MS * 3, (hi - lo) * 0.05);
  const from = new Date(lo - pad);
  const to = new Date(hi + pad);
  const span = to.getTime() - from.getTime();
  const pos = (date: Date): number => Math.min(1, Math.max(0, (date.getTime() - from.getTime()) / span));

  // First of each month inside the window, thinned to at most 5 marks.
  const months: Date[] = [];
  for (let d = new Date(from.getFullYear(), from.getMonth() + 1, 1); d < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    months.push(d);
  }
  const step = Math.max(1, Math.ceil(months.length / 5));
  const ticks = months.filter((_, n) => n % step === 0).map((d) => ({ pos: pos(d), label: format(d, 'MMM') }));
  return { from, to, todayPos: pos(today), pos, ticks };
}

// ───────────────────────────── the pulse and the headline ─────────────────────────────

export interface Pulse {
  /** In progress or in review and touched within the idle window. */
  moving: number;
  /** In progress or in review and untouched for the idle window or longer. */
  stuck: number;
  waiting: number;
  closedThisWeek: number;
  closedLastWeek: number;
  openedThisWeek: number;
  openedLastWeek: number;
}

export function pulse(ctx: OverviewContext, flow: readonly FlowDay[] = dailyFlow(ctx)): Pulse {
  let moving = 0;
  let stuck = 0;
  let waiting = 0;
  for (const i of ctx.issues) {
    const phase = phaseOfIssue(ctx, i);
    if (phase === 'open') waiting++;
    if (phase !== 'active') continue;
    if (idleDaysOf(ctx, i) >= ctx.idleDays) stuck++;
    else moving++;
  }
  const weeks = weekTotals(flow);
  const cur = weeks[weeks.length - 1];
  const prev = weeks[weeks.length - 2];
  return {
    moving,
    stuck,
    waiting,
    closedThisWeek: cur?.closed ?? 0,
    closedLastWeek: prev?.closed ?? 0,
    openedThisWeek: cur?.created ?? 0,
    openedLastWeek: prev?.created ?? 0,
  };
}

export interface HeadlinePart {
  text: string;
  /** A number or a name, drawn a notch stronger. */
  strong?: boolean;
  tone?: 'red' | 'amber' | 'green';
  /** Clicking it previews this in the right pane. */
  target?: RightPaneContent;
}

/** One sentence about the workspace, in parts so the page can emphasise numbers and link project names. */
export function headline(p: Pulse, rows: readonly ProjectRow[]): HeadlinePart[] {
  const parts: HeadlinePart[] = [];
  const inFlight = p.moving + p.stuck;
  if (inFlight === 0) {
    parts.push({ text: 'Nothing is in progress' });
    if (p.waiting > 0) parts.push({ text: ', ' }, { text: String(p.waiting), strong: true }, { text: ' waiting to start' });
  } else {
    parts.push({ text: String(p.moving), strong: true }, { text: p.moving === 1 ? ' task moving' : ' tasks moving' });
    if (p.stuck > 0) {
      parts.push({ text: ', ' }, { text: String(p.stuck), strong: true, tone: 'amber' }, { text: ' stuck' });
    }
  }
  parts.push({ text: '.' });

  const slipping = rows.filter((r) => (r.signal === 'off_track' || r.signal === 'at_risk') && (r.behindDays ?? 0) > 0);
  const worst = slipping[0];
  if (worst) {
    const days = worst.behindDays ?? 0;
    parts.push(
      { text: ' ' },
      { text: worst.project.name, strong: true, target: projectTarget(worst.project.id) },
      { text: ' is ' },
      { text: plural(days, 'day'), strong: true, tone: worst.signal === 'off_track' ? 'red' : 'amber' },
      { text: ' behind' },
    );
    const more = slipping.length - 1;
    parts.push({ text: more > 0 ? `, and ${plural(more, 'other project')} ${more === 1 ? 'is' : 'are'} slipping.` : '.' });
  } else if (rows.length > 0 && rows.every((r) => r.signal === 'on_track')) {
    // Only said when every project has a projection that meets its target, never for "not enough data".
    parts.push({ text: ' Every project is on track.', tone: 'green' });
  }
  return parts;
}

/** "+3" / "-2" / "same as last week" for the weekly delta line. */
export function deltaText(now: number, before: number): string {
  const d = now - before;
  return d === 0 ? 'same as last week' : `${d > 0 ? '+' : '−'}${Math.abs(d)} vs last week`;
}

// ───────────────────────────── worth a look ─────────────────────────────

export type WatchKind =
  | 'needs_you'
  | 'stale'
  | 'held_up'
  | 'milestone_overdue'
  | 'project_slipping'
  | 'unowned_urgent';

export interface WatchItem {
  id: string;
  kind: WatchKind;
  score: number;
  tone: 'red' | 'amber' | 'neutral';
  /** What it is: a task title, a milestone or project name. */
  title: string;
  /** Task key, for task rows. */
  key?: string;
  /** Task status, to draw its glyph. */
  status?: string;
  /** Why it is on the list, in plain words. */
  reason: string;
  target: RightPaneContent;
}

const PRIORITY_BONUS: Record<string, number> = { urgent: 8, high: 5, medium: 2 };

const toneOf = (score: number): WatchItem['tone'] => (score >= 70 ? 'red' : score >= 45 ? 'amber' : 'neutral');

/** Every candidate, unsorted. Exported for tests; the page uses `watchlist`. */
export function watchCandidates(ctx: OverviewContext, rows: readonly ProjectRow[] = projectRows(ctx)): WatchItem[] {
  const items: WatchItem[] = [];
  const today = startOfDay(ctx.now);
  const byId = new Map(ctx.issues.map((i) => [i.id, i]));
  const add = (item: Omit<WatchItem, 'tone'>): void => {
    items.push({ ...item, tone: toneOf(item.score) });
  };

  // The server's attention queue: things only a human can unblock.
  for (const a of ctx.attention) {
    const issue = a.issueId ? byId.get(a.issueId) : undefined;
    if (!issue || a.state !== 'open') continue;
    add({
      id: `needs:${a.id}`,
      kind: 'needs_you',
      score: a.severity === 'high' ? 90 : a.severity === 'medium' ? 60 : 40,
      title: issue.title,
      key: issue.key,
      status: issue.status,
      reason: a.title,
      target: taskTarget(issue),
    });
  }

  // Started and then quiet.
  const children = new Map<string, Issue[]>();
  for (const i of ctx.issues) {
    if (!i.parentId) continue;
    const list = children.get(i.parentId);
    if (list) list.push(i);
    else children.set(i.parentId, [i]);
  }
  for (const i of ctx.issues) {
    const phase = phaseOfIssue(ctx, i);
    if (phase === 'active') {
      const idle = idleDaysOf(ctx, i);
      if (idle >= ctx.idleDays) {
        add({
          id: `stale:${i.id}`,
          kind: 'stale',
          score: 40 + Math.min(idle, 30) + (PRIORITY_BONUS[i.priority] ?? 0),
          title: i.title,
          key: i.key,
          status: i.status,
          reason: `${ctx.issueLabel(i.status)}, but nothing has happened for ${plural(idle, 'day')}`,
          target: taskTarget(i),
        });
      }
    }
    if (phase === 'active' || phase === 'open') {
      if (!i.assigneeId && (i.priority === 'urgent' || i.priority === 'high')) {
        add({
          id: `unowned:${i.id}`,
          kind: 'unowned_urgent',
          score: i.priority === 'urgent' ? 65 : 45,
          title: i.title,
          key: i.key,
          status: i.status,
          reason: `${i.priority === 'urgent' ? 'Urgent' : 'High priority'} and nobody owns it`,
          target: taskTarget(i),
        });
      }
    }
    // A chain: the parent waits on subtasks that have all gone quiet.
    if (phase !== 'done' && phase !== 'canceled') {
      const open = (children.get(i.id) ?? []).filter((c) => {
        const p = phaseOfIssue(ctx, c);
        return p === 'open' || p === 'active';
      });
      if (open.length >= 2 && open.every((c) => idleDaysOf(ctx, c) >= ctx.idleDays)) {
        const quiet = Math.min(...open.map((c) => idleDaysOf(ctx, c)));
        add({
          id: `held:${i.id}`,
          kind: 'held_up',
          score: 50 + Math.min(open.length, 10) + (PRIORITY_BONUS[i.priority] ?? 0),
          title: i.title,
          key: i.key,
          status: i.status,
          reason: `Waits on ${open.length} subtasks that nobody touched for ${plural(quiet, 'day')}`,
          target: taskTarget(i),
        });
      }
    }
  }

  // Milestones whose date passed with work left.
  const issuesOf = new Map<string, Issue[]>();
  for (const i of ctx.issues) {
    for (const id of i.milestoneIds) {
      const list = issuesOf.get(id);
      if (list) list.push(i);
      else issuesOf.set(id, [i]);
    }
  }
  const projectName = new Map(ctx.projects.map((p) => [p.id, p.name]));
  for (const m of ctx.milestones) {
    const type = ctx.projectType(ctx.projects.find((p) => p.id === m.projectId)?.status ?? '');
    if (type === 'completed' || type === 'canceled') continue;
    const due = m.targetDate ? startOfDay(new Date(m.targetDate)) : undefined;
    if (!due) continue;
    const late = differenceInCalendarDays(today, due);
    if (late <= 0) continue;
    const scoped = (issuesOf.get(m.id) ?? []).filter((i) => phaseOfIssue(ctx, i) !== 'canceled');
    const left = scoped.filter((i) => phaseOfIssue(ctx, i) !== 'done').length;
    if (left === 0) continue;
    add({
      id: `milestone:${m.id}`,
      kind: 'milestone_overdue',
      score: 70 + Math.min(late, 30) / 2,
      title: `${m.name}${projectName.get(m.projectId) ? ` · ${projectName.get(m.projectId)}` : ''}`,
      reason: `Due ${plural(late, 'day')} ago, ${left} of ${plural(scoped.length, 'task')} still open`,
      target: projectTarget(m.projectId),
    });
  }

  // Projects heading past their target at the current pace.
  for (const r of rows) {
    if (r.signal !== 'off_track' && r.signal !== 'at_risk') continue;
    const late = r.behindDays ?? 0;
    add({
      id: `project:${r.project.id}`,
      kind: 'project_slipping',
      score: (r.signal === 'off_track' ? 75 : 50) + Math.min(Math.max(late, 0), 40) / 2,
      title: r.project.name,
      reason: r.forecast.explanation,
      target: projectTarget(r.project.id),
    });
  }
  return items;
}

/** The few things most worth a look: highest score first, at most two of a kind before others get a turn. */
export function watchlist(
  ctx: OverviewContext,
  rows: readonly ProjectRow[] = projectRows(ctx),
  limit = WATCH_LIMIT,
): WatchItem[] {
  const sorted = watchCandidates(ctx, rows).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const seen = new Map<WatchKind, number>();
  const picked: WatchItem[] = [];
  const rest: WatchItem[] = [];
  const taskSeen = new Set<string>();
  for (const item of sorted) {
    // One row per task, even when it is stale and unowned at once.
    if (item.key && taskSeen.has(item.key)) continue;
    if (item.key) taskSeen.add(item.key);
    const n = seen.get(item.kind) ?? 0;
    if (n < 2 && picked.length < limit) {
      picked.push(item);
      seen.set(item.kind, n + 1);
    } else rest.push(item);
  }
  for (const item of rest) {
    if (picked.length >= limit) break;
    picked.push(item);
  }
  return picked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
