// Everything the overview page shows, derived once from the store with computed signals. Components
// only render; nothing here is recomputed per row. Numbers that cannot be known from the loaded data
// come back as undefined (rendered as "—"), never as a guess.
import { Injectable, computed, inject } from '@angular/core';
import { addDays, differenceInCalendarDays, format, parseISO, startOfDay } from 'date-fns';
import {
  ATTENTION_KIND_META,
  ATTENTION_KINDS,
  NablaStore,
  PRIORITY_META,
  WORKSTREAM_STATUS_META,
  isOverdue,
  shortDate,
  type AttentionItem,
  type Decision,
  type Issue,
  type Milestone,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { progressLabel, type MilestoneState, type MilestoneStats } from '../milestones/milestone-model';
import type { BarRow } from '../stats/charts/bar-list';
import type { ChartSeries, ChartSlice } from '../stats/charts/chart-utils';
import type { KpiDelta } from '../stats/charts/kpi-tile';
import { absDelta, formatDuration, pctDelta } from '../stats/insights';
import { WS_COLOR } from '../stats/stats-colors';

const DAY = 86_400_000;
const WINDOW = 30;

/** Workstreams that are in flight: not a draft, not finished. */
export const isActiveWs = (w: Workstream): boolean => w.status !== 'shipped' && w.status !== 'canceled' && w.status !== 'draft';
const isOpenIssue = (i: Issue): boolean => i.status !== 'done' && i.status !== 'canceled';

/** Most urgent first, ending with the done states. */
export const WS_URGENCY: readonly WorkstreamStatus[] = [
  'blocked',
  'needs_input',
  'ready_to_land',
  'in_review',
  'working',
  'planned',
  'draft',
  'shipped',
  'canceled',
];

export type Health = 'blocked' | 'late' | 'at-risk' | 'on-track' | 'idle';

export const HEALTH_VIEW: Record<Health, { label: string; pill: string }> = {
  blocked: { label: 'Blocked', pill: 'text-status-blocked bg-status-blocked/10' },
  late: { label: 'Overdue', pill: 'text-status-blocked bg-status-blocked/10' },
  'at-risk': { label: 'At risk', pill: 'text-status-needs-input bg-status-needs-input/10' },
  'on-track': { label: 'On track', pill: 'text-status-shipped bg-status-shipped/10' },
  idle: { label: 'Not started', pill: 'text-muted-foreground bg-foreground/[0.06]' },
};

export interface WsRow {
  ws: Workstream;
  health: Health;
  /** One line explaining the health ("Overdue by 3d"). */
  reason: string;
  /** Linked issues that are done / all linked issues that are not canceled. */
  done: number;
  total: number;
  fraction: number;
  overdue: boolean;
  mine: boolean;
}

export interface UpcomingItem {
  id: string;
  kind: 'milestone' | 'workstream';
  ws: Workstream;
  name: string;
  date: string;
  /** "Oct 12". */
  dateText: string;
  /** Calendar days from today (negative: overdue). */
  days: number;
  when: string;
  overdue: boolean;
  /** Milestone: "61% of 7 issues". Workstream: "10/18 issues". */
  progress: string;
  fraction: number;
  /** Milestones only. */
  state?: MilestoneState;
  stats?: MilestoneStats;
}

export interface OverviewKpi {
  key: string;
  label: string;
  value: string;
  delta?: KpiDelta;
  hint?: string;
  spark: number[];
  sparkColor: string;
  /** Router path segments after the slug, plus optional query params. */
  link: string[];
  query?: Record<string, string>;
}

export interface AttentionRow {
  item: AttentionItem;
  commands: string[];
  query?: Record<string, string>;
  chip: { type: 'workstream' | 'issue' | 'decision'; ref: string } | null;
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const ts = (iso: string | undefined | null): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

/** "today" / "tomorrow" / "in 3 days" / "2 days overdue". */
export function dueLabel(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days > 1) return `in ${days} days`;
  return days === -1 ? '1 day overdue' : `${-days} days overdue`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

@Injectable()
export class OverviewModel {
  private readonly store = inject(NablaStore);
  private readonly ms = inject(MilestoneInfo);

  readonly slug = computed(() => this.store.slug() ?? '');
  readonly me = this.store.me;

  // ───────────────────────── workstreams ─────────────────────────

  private readonly myOpenIssueWs = computed(() => {
    const me = this.store.me()?.id;
    const out = new Set<string>();
    if (!me) return out;
    for (const i of this.store.issues()) if (i.assigneeId === me && isOpenIssue(i)) for (const id of i.workstreamIds) out.add(id);
    return out;
  });

  /** Active workstreams with progress and health, most urgent first. */
  readonly rows = computed<WsRow[]>(() => {
    const byWs = this.store.issuesByWorkstream();
    const me = this.store.me()?.id;
    const mineIssueWs = this.myOpenIssueWs();
    const now = Date.now();
    const today = startOfDay(now);
    const out: WsRow[] = [];
    for (const ws of this.store.workstreams()) {
      if (!isActiveWs(ws)) continue;
      const issues = (byWs.get(ws.id) ?? []).filter((i) => i.status !== 'canceled');
      const total = issues.length;
      const done = issues.filter((i) => i.status === 'done').length;
      const remaining = total - done;
      const overdue = isOverdue(ws.targetDate);
      const daysLeft = ws.targetDate ? differenceInCalendarDays(parseISO(ws.targetDate), today) : undefined;

      let health: Health;
      let reason: string;
      if (ws.status === 'blocked') {
        health = 'blocked';
        reason = 'Blocked';
      } else if (overdue && daysLeft !== undefined) {
        health = 'late';
        reason = `Overdue by ${-daysLeft}d`;
      } else if (ws.status === 'needs_input') {
        health = 'at-risk';
        reason = 'Waiting on input';
      } else if (ws.status === 'planned' || total === 0) {
        health = 'idle';
        reason = total === 0 ? 'No issues yet' : 'Not started';
      } else {
        health = 'on-track';
        reason = 'On track';
        if (daysLeft !== undefined && remaining > 0) {
          // pace: issues completed in the last 28 days, projected to the target date
          const recent = issues.filter((i) => {
            const t = i.status === 'done' ? ts(i.completedAt) : undefined;
            return t !== undefined && now - t <= 28 * DAY;
          }).length;
          const started = issues.some((i) => i.status !== 'backlog' && i.status !== 'todo');
          const projected = (recent / 28) * daysLeft;
          if ((started || daysLeft <= 14) && projected < remaining * 0.97) {
            health = 'at-risk';
            reason = recent === 0 ? 'No recent completions' : `Projected to miss ${shortDate(ws.targetDate)}`;
          }
        }
      }
      out.push({
        ws,
        health,
        reason,
        done,
        total,
        fraction: total ? done / total : 0,
        overdue,
        mine: (!!me && ws.accountableUserId === me) || mineIssueWs.has(ws.id),
      });
    }
    const rank = (r: WsRow): number => (r.health === 'blocked' ? 0 : r.health === 'late' ? 1 : r.health === 'at-risk' ? 2 : 3);
    return out.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        WS_URGENCY.indexOf(a.ws.status) - WS_URGENCY.indexOf(b.ws.status) ||
        (a.ws.targetDate ?? '9999').localeCompare(b.ws.targetDate ?? '9999') ||
        a.ws.number - b.ws.number,
    );
  });
  readonly activeCount = computed(() => this.rows().length);
  readonly atRiskRows = computed(() => this.rows().filter((r) => r.health === 'blocked' || r.health === 'late' || r.health === 'at-risk'));
  readonly overdueRows = computed(() => this.rows().filter((r) => r.overdue));

  /** Teams that own at least one active workstream, biggest first. */
  readonly teamsWithWork = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.rows()) counts.set(r.ws.ownerTeamId, (counts.get(r.ws.ownerTeamId) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => ({ team: this.store.teamById().get(id), count }))
      .filter((t): t is { team: NonNullable<typeof t.team>; count: number } => !!t.team)
      .sort((a, b) => b.count - a.count || a.team.name.localeCompare(b.team.name));
  });

  // ───────────────────────── upcoming ─────────────────────────

  /** Milestones and workstream target dates that are overdue or due within 14 days, in date order. */
  readonly upcomingAll = computed<UpcomingItem[]>(() => {
    const today = startOfDay(Date.now());
    const activeIds = new Map(this.rows().map((r) => [r.ws.id, r] as const));
    const stats = this.ms.stats();
    const states = this.ms.states();
    const items: UpcomingItem[] = [];
    const days = (iso: string): number => differenceInCalendarDays(parseISO(iso), today);

    for (const m of this.store.milestones() as readonly Milestone[]) {
      const row = activeIds.get(m.workstreamId);
      const st = stats.get(m.id);
      if (!row || !st || st.complete || !m.targetDate) continue;
      const d = days(m.targetDate);
      if (d > 14) continue;
      items.push({
        id: m.id,
        kind: 'milestone',
        ws: row.ws,
        name: m.name,
        date: m.targetDate,
        dateText: format(parseISO(m.targetDate), 'MMM d'),
        days: d,
        when: dueLabel(d),
        overdue: d < 0,
        progress: progressLabel(st),
        fraction: st.fraction,
        state: states.get(m.id),
        stats: st,
      });
    }
    for (const r of activeIds.values()) {
      const t = r.ws.targetDate;
      if (!t) continue;
      const d = days(t);
      if (d > 14) continue;
      items.push({
        id: r.ws.id,
        kind: 'workstream',
        ws: r.ws,
        name: r.ws.title,
        date: t,
        dateText: format(parseISO(t), 'MMM d'),
        days: d,
        when: dueLabel(d),
        overdue: d < 0,
        progress: r.total ? `${r.done}/${r.total} issues` : 'No issues',
        fraction: r.fraction,
      });
    }
    return items.sort((a, b) => a.days - b.days || a.kind.localeCompare(b.kind));
  });
  readonly upcoming = computed(() => this.upcomingAll().slice(0, 7));
  readonly upcomingMore = computed(() => Math.max(0, this.upcomingAll().length - 7));
  readonly milestonesDueThisWeek = computed(() => this.upcomingAll().filter((u) => u.kind === 'milestone' && u.days >= 0 && u.days <= 7).length);

  // ───────────────────────── attention & my work ─────────────────────────

  readonly attentionCount = this.store.attentionCount;
  readonly attentionRows = computed<AttentionRow[]>(() => {
    const store = this.store;
    const slug = this.slug();
    return store
      .openAttention()
      .slice(0, 5)
      .map((item) => {
        const ws = item.workstreamId ? store.workstreamById().get(item.workstreamId) : undefined;
        let commands: string[] = ws ? ['/', slug, 'workstreams', ws.key] : ['/', slug, 'workstreams'];
        let query: Record<string, string> | undefined;
        if (item.kind === 'needs_decision') {
          const d = item.decisionId ? store.decisionById().get(item.decisionId) : undefined;
          if (d) commands = ['/', slug, 'decisions', d.key];
        } else if (item.kind === 'triage') {
          const i = item.issueId ? store.issueById().get(item.issueId) : undefined;
          commands = ['/', slug, 'issues'];
          query = { status: 'backlog', ...(i?.teamId ? { team: i.teamId } : {}) };
        }
        let chip: AttentionRow['chip'] = null;
        if (item.decisionId && store.decisionById().has(item.decisionId)) chip = { type: 'decision', ref: item.decisionId };
        else if (item.issueId && store.issueById().has(item.issueId)) chip = { type: 'issue', ref: item.issueId };
        else if (ws) chip = { type: 'workstream', ref: ws.id };
        return { item, commands, query, chip };
      });
  });
  readonly attentionKinds = computed(() => {
    const counts = this.store.attentionCounts();
    return ATTENTION_KINDS.filter((k) => counts[k] > 0).map((kind) => ({ kind, count: counts[kind], label: ATTENTION_KIND_META[kind].label }));
  });

  readonly assigned = computed<Issue[]>(() => {
    const me = this.store.me()?.id;
    if (!me) return [];
    return this.store
      .issues()
      .filter((i) => i.assigneeId === me && i.status === 'in_progress')
      .sort((a, b) => PRIORITY_META[a.priority].order - PRIORITY_META[b.priority].order || b.updatedAt.localeCompare(a.updatedAt));
  });
  readonly assignedTop = computed(() => this.assigned().slice(0, 4));

  // ───────────────────────── greeting ─────────────────────────

  readonly firstName = computed(() => (this.store.me()?.name ?? '').trim().split(/\s+/)[0] ?? '');
  readonly statusLine = computed(() => {
    const parts: string[] = [];
    const a = this.attentionCount();
    if (a > 0) parts.push(`${a} ${a === 1 ? 'thing needs' : 'things need'} you`);
    const risk = this.atRiskRows().length;
    if (risk > 0) parts.push(`${plural(risk, 'workstream')} at risk`);
    const due = this.milestonesDueThisWeek();
    if (due > 0) parts.push(`${plural(due, 'milestone')} due this week`);
    return parts.length ? parts.join(' · ') : 'All quiet: nothing needs you and nothing is at risk.';
  });
  readonly subtitle = computed(() => `${plural(this.activeCount(), 'active workstream')} · ${plural(this.openIssueCount(), 'open issue')}`);

  // ───────────────────────── issue timeline ─────────────────────────

  readonly openIssueCount = computed(() => this.store.issues().filter(isOpenIssue).length);

  /** Plain timestamps per issue, computed once. */
  private readonly issueTimes = computed(() => {
    const recs: { created: number; started?: number; done?: number; closed?: number }[] = [];
    let doneWithoutTime = 0;
    for (const i of this.store.issues()) {
      const created = ts(i.createdAt);
      if (created === undefined) continue;
      const completed = ts(i.completedAt);
      const isDone = i.status === 'done';
      const isClosed = isDone || i.status === 'canceled';
      if (isDone && completed === undefined) doneWithoutTime++;
      recs.push({
        created,
        started: ts(i.startedAt),
        done: isDone ? completed : undefined,
        // for the backlog history, a closed issue without a completion time falls back to its last update
        closed: isClosed ? (completed ?? ts(i.updatedAt)) : undefined,
      });
    }
    return { recs, doneWithoutTime };
  });

  /** 30 day buckets ending today; `starts[i]` is local midnight. */
  private readonly axis = computed(() => {
    this.store.issues(); // refresh "today" with the data
    const end = addDays(startOfDay(Date.now()), 1);
    const starts = Array.from({ length: WINDOW }, (_, i) => addDays(end, -(WINDOW - i)).getTime());
    return { starts, from: starts[0], to: end.getTime(), now: Date.now() };
  });

  private readonly flow = computed(() => {
    const { recs } = this.issueTimes();
    const ax = this.axis();
    const bucket = (t: number): number => Math.floor(differenceInCalendarDays(t, ax.from));
    const opened = new Array<number>(WINDOW).fill(0);
    const closed = new Array<number>(WINDOW).fill(0);
    for (const r of recs) {
      if (r.created >= ax.from && r.created < ax.to) opened[bucket(r.created)]++;
      if (r.done !== undefined && r.done >= ax.from && r.done < ax.to) closed[bucket(r.done)]++;
    }
    const openAt = (t: number): number => {
      let n = 0;
      for (const r of recs) if (r.created <= t && (r.closed === undefined || r.closed > t)) n++;
      return n;
    };
    const ends = ax.starts.map((s) => Math.min(s + DAY - 1, ax.now));
    const openSpark = ends.map(openAt);
    return { opened, closed, openSpark, openThen: openAt(ax.from - 1), openNow: openSpark[WINDOW - 1] };
  });

  readonly flowChart = computed(() => {
    const f = this.flow();
    const ax = this.axis();
    const series: ChartSeries[] = [
      { key: 'opened', label: 'Opened', color: 'var(--chart-1)', values: f.opened },
      { key: 'closed', label: 'Closed', color: 'var(--chart-2)', values: f.closed },
    ];
    const missing = this.issueTimes().doneWithoutTime;
    const openedTotal = f.opened.reduce((n, v) => n + v, 0);
    const closedTotal = f.closed.reduce((n, v) => n + v, 0);
    return {
      series,
      labels: ax.starts.map((s) => format(s, 'MMM d')),
      titles: ax.starts.map((s) => format(s, 'EEE, MMM d')),
      empty: openedTotal + closedTotal === 0 ? 'No issues were opened or closed in the last 30 days.' : undefined,
      subtitle: `${openedTotal} opened · ${closedTotal} closed in 30 days`,
      note:
        missing > 0
          ? `${plural(missing, 'done issue')} ${missing === 1 ? 'has' : 'have'} no completion time and ${missing === 1 ? 'is' : 'are'} not counted as closed.`
          : 'Closed counts issues moved to Done.',
    };
  });

  // ───────────────────────── KPIs ─────────────────────────

  readonly kpis = computed<OverviewKpi[]>(() => {
    const { recs } = this.issueTimes();
    const ax = this.axis();
    const f = this.flow();
    const now = ax.now;

    // open issues, against 30 days ago
    const openNow = this.openIssueCount();
    const open: OverviewKpi = {
      key: 'open',
      label: 'Open issues',
      value: String(openNow),
      delta: absDelta(openNow - f.openThen, 'down', `vs ${f.openThen} thirty days ago`),
      hint: `${this.store.backlogIssueCount()} in backlog`,
      spark: f.openSpark,
      sparkColor: 'var(--chart-1)',
      link: ['issues'],
    };

    // workstreams in flight
    const risk = this.atRiskRows().length;
    const blocked = this.rows().filter((r) => r.health === 'blocked').length;
    const active: OverviewKpi = {
      key: 'active',
      label: 'Active workstreams',
      value: String(this.activeCount()),
      hint: risk ? `${risk} at risk${blocked ? ` · ${blocked} blocked` : ''}` : 'none at risk',
      spark: [],
      sparkColor: 'var(--chart-4)',
      link: ['workstreams'],
    };

    // closed in the last 7 days, against the 7 before
    const inRange = (t: number | undefined, from: number, to: number): boolean => t !== undefined && t >= from && t < to;
    const closed7 = recs.filter((r) => inRange(r.done, now - 7 * DAY, now + 1)).length;
    const closedPrev7 = recs.filter((r) => inRange(r.done, now - 14 * DAY, now - 7 * DAY)).length;
    const closedKpi: OverviewKpi = {
      key: 'closed',
      label: 'Closed this week',
      value: String(closed7),
      delta: pctDelta(closed7, closedPrev7, 'up', 'vs the previous 7 days'),
      hint: 'issues done, last 7 days',
      spark: f.closed,
      sparkColor: 'var(--chart-2)',
      link: ['issues'],
      query: { view: 'done' },
    };

    // median cycle time (started to done) of issues finished in the window
    const cycle = (from: number, to: number): { med?: number; n: number } => {
      const days = recs
        .filter((r) => r.started !== undefined && r.done !== undefined && r.done >= r.started && inRange(r.done, from, to))
        .map((r) => (r.done! - r.started!) / DAY);
      return { med: median(days), n: days.length };
    };
    const cur = cycle(now - WINDOW * DAY, now + 1);
    const prev = cycle(now - 2 * WINDOW * DAY, now - WINDOW * DAY);
    const cycleKpi: OverviewKpi = {
      key: 'cycle',
      label: 'Median cycle time',
      value: cur.med === undefined ? '—' : formatDuration(cur.med),
      delta: cur.med !== undefined && prev.med !== undefined ? pctDelta(cur.med, prev.med, 'down', `vs the previous 30 days (${formatDuration(prev.med)})`) : undefined,
      hint: cur.med === undefined ? 'no finished issues with a start time' : `started to done · ${plural(cur.n, 'issue')}`,
      spark: [],
      sparkColor: 'var(--chart-3)',
      link: ['stats'],
    };

    // schedule: overdue workstreams (+ on-time rate of what shipped lately)
    const overdue = this.overdueRows().length;
    const { onTime, withTarget } = this.shippedSchedule();
    const schedule: OverviewKpi = {
      key: 'overdue',
      label: 'Overdue workstreams',
      value: String(overdue),
      hint: withTarget ? `${Math.round((onTime / withTarget) * 100)}% on time · ${onTime}/${withTarget} shipped` : 'no dated workstreams shipped lately',
      spark: [],
      sparkColor: 'var(--chart-5)',
      link: ['workstreams'],
    };
    return [open, active, closedKpi, cycleKpi, schedule];
  });

  /** Of the workstreams shipped in the last 30 days that had a target date, how many made it. */
  private readonly shippedSchedule = computed(() => {
    let onTime = 0;
    let withTarget = 0;
    for (const w of this.shippedRecent()) {
      if (!w.targetDate || !w.shippedAt) continue;
      withTarget++;
      if (differenceInCalendarDays(parseISO(w.shippedAt), parseISO(w.targetDate)) <= 0) onTime++;
    }
    return { onTime, withTarget };
  });

  // ───────────────────────── distributions ─────────────────────────

  readonly statusSlices = computed<(ChartSlice & { status: WorkstreamStatus; link: string; query?: Record<string, string> })[]>(() => {
    const counts = new Map<WorkstreamStatus, number>();
    for (const w of this.store.workstreams()) counts.set(w.status, (counts.get(w.status) ?? 0) + 1);
    const view = (s: WorkstreamStatus): Record<string, string> | undefined =>
      s === 'shipped' ? { view: 'shipped' } : s === 'draft' || s === 'planned' ? { view: 'backlog' } : s === 'canceled' ? { view: 'all' } : undefined;
    return WS_URGENCY.filter((s) => (counts.get(s) ?? 0) > 0 && s !== 'canceled').map((status) => ({
      key: status,
      status,
      label: WORKSTREAM_STATUS_META[status].label,
      value: counts.get(status) ?? 0,
      color: WS_COLOR[status],
      link: 'workstreams',
      query: view(status),
    }));
  });
  readonly statusTotal = computed(() => this.statusSlices().reduce((n, s) => n + s.value, 0));

  readonly teamBars = computed<BarRow[]>(() => {
    const out: BarRow[] = [];
    for (const [teamId, issues] of this.store.issuesByTeam()) {
      const team = teamId ? this.store.teamById().get(teamId) : undefined;
      if (!team) continue;
      const value = issues.filter(isOpenIssue).length;
      if (value > 0) out.push({ key: team.id, label: team.name, hint: team.key, value, detail: `${team.name}: ${value} open` });
    }
    return out.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 8);
  });

  // ───────────────────────── rail ─────────────────────────

  readonly shippedRecent = computed(() => {
    const cutoff = Date.now() - WINDOW * DAY;
    return this.store
      .workstreams()
      .filter((w) => w.status === 'shipped' && (ts(w.shippedAt) ?? 0) >= cutoff)
      .sort((a, b) => (b.shippedAt ?? '').localeCompare(a.shippedAt ?? ''));
  });
  readonly shipped = computed(() => this.shippedRecent().slice(0, 5));

  readonly decisions = computed<Decision[]>(() => {
    const all = this.store.decisions();
    const proposed = all.filter((d) => d.status === 'proposed').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const rest = all
      .filter((d) => d.status === 'accepted')
      .sort((a, b) => (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt));
    return [...proposed, ...rest].slice(0, 5);
  });
  readonly proposedCount = computed(() => this.store.decisions().filter((d) => d.status === 'proposed').length);

  readonly backlogCount = this.store.backlogIssueCount;
  readonly triage = computed(() => [...this.store.backlogIssues()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4));
  readonly events = computed(() => this.store.events().slice(0, 8));
}
