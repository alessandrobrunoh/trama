// The "Last four weeks" chart on Home, as data: one column per day, tasks closed against tasks opened, with
// milestones and completed projects pinned on their day. Pure functions over plain inputs (`now` and the status
// classifiers are passed in), so the rules are testable without the store.
import { addDays, differenceInCalendarDays, format, startOfDay, subDays } from 'date-fns';
import type { Issue, Milestone, Project } from '../../core/contracts/domain';

/** Days the chart covers: four weeks. */
export const FLOW_DAYS = 28;

export interface FlowContext {
  now: Date;
  issues: readonly Issue[];
  projects: readonly Project[];
  milestones: readonly Milestone[];
  /** Semantic status type of a stored issue / project status (workspace statuses can be renamed). */
  issueType: (status: string) => string | undefined;
  projectType: (status: string) => string | undefined;
}

export type FlowEventKind = 'milestone_hit' | 'milestone_missed' | 'project_done';

export interface FlowEvent {
  kind: FlowEventKind;
  label: string;
  /** The project the event belongs to (its page opens on click). */
  projectId: string;
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

export interface WeekTotal {
  /** First day of the 7-day block. */
  start: Date;
  created: number;
  closed: number;
  current: boolean;
}

const ms = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** When a task was closed: its completion, else its last update (the Timeline's rule). */
const closedAtOf = (i: Issue): number | undefined => ms(i.completedAt) ?? ms(i.updatedAt);

const dayKey = (d: Date): string => format(d, 'yyyy-MM-dd');

/** Per day of the last `days` days (oldest first, ending today): tasks opened, tasks closed and what was pinned there. */
export function dailyFlow(ctx: FlowContext, days = FLOW_DAYS): FlowDay[] {
  const type = (i: Issue) => ctx.issueType(i.status);
  const today = startOfDay(ctx.now);
  const first = subDays(today, days - 1);
  const out: FlowDay[] = Array.from({ length: days }, (_, n) => {
    const date = addDays(first, n);
    const dow = date.getDay();
    return { date, key: dayKey(date), created: 0, closed: 0, today: n === days - 1, weekend: dow === 0 || dow === 6, events: [] };
  });
  const slot = (t: number | undefined): FlowDay | undefined => {
    if (t === undefined) return undefined;
    const n = differenceInCalendarDays(new Date(t), first);
    return n >= 0 && n < days ? out[n] : undefined;
  };

  for (const i of ctx.issues) {
    const created = slot(ms(i.createdAt));
    if (created) created.created++;
    // Canceled tasks were opened but never count as closed work.
    if (type(i) === 'done') {
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
    const scoped = (issuesOf.get(m.id) ?? []).filter((i) => type(i) !== 'canceled');
    if (scoped.length > 0 && scoped.every((i) => type(i) === 'done')) {
      const at = Math.max(...scoped.map((i) => closedAtOf(i) ?? 0));
      slot(at)?.events.push({ kind: 'milestone_hit', label: `${m.name} reached`, projectId: m.projectId });
      continue;
    }
    const due = ms(m.targetDate);
    if (due !== undefined && due < ctx.now.getTime()) {
      slot(due)?.events.push({ kind: 'milestone_missed', label: `${m.name} was due`, projectId: m.projectId });
    }
  }
  for (const p of ctx.projects) {
    if (ctx.projectType(p.status) !== 'completed') continue;
    slot(ms(p.completedAt))?.events.push({ kind: 'project_done', label: `${p.name} completed`, projectId: p.id });
  }
  return out;
}

/** The days cut into 7-day blocks, oldest first; the last one ends today. */
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
