// Issue-first overview data, derived once from the loaded workspace.
import { Injectable, computed, inject } from '@angular/core';
import { addDays, differenceInCalendarDays, format, startOfDay } from 'date-fns';
import {
  ATTENTION_KIND_META,
  ATTENTION_KINDS,
  TramaStore,
  PRIORITY_META,
  type AttentionItem,
  type Decision,
  type Issue,
} from '../../core';
import type { BarRow } from '../stats/charts/bar-list';
import type { ChartSeries } from '../stats/charts/chart-utils';
import type { KpiDelta } from '../stats/charts/kpi-tile';
import { absDelta, formatDuration, pctDelta } from '../stats/insights';

const DAY = 86_400_000;
const WINDOW = 30;
const isOpenIssue = (i: Issue): boolean => i.status !== 'done' && i.status !== 'canceled';
const ts = (iso: string | undefined | null): number | undefined => {
  if (!iso) return undefined;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? undefined : value;
};
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export interface OverviewKpi {
  key: string;
  label: string;
  value: string;
  delta?: KpiDelta;
  hint?: string;
  spark: number[];
  sparkColor: string;
  link: string[];
  query?: Record<string, string>;
}

export interface AttentionRow {
  item: AttentionItem;
  commands: string[];
  query?: Record<string, string>;
  chip: { type: 'issue' | 'decision'; ref: string } | null;
}

@Injectable()
export class OverviewModel {
  private readonly store = inject(TramaStore);
  readonly slug = computed(() => this.store.slug() ?? '');
  readonly me = this.store.me;

  readonly attentionCount = this.store.attentionCount;
  readonly attentionRows = computed<AttentionRow[]>(() => {
    const store = this.store;
    const slug = this.slug();
    return store.openAttention().slice(0, 5).map((item) => {
      const commands = ['/', slug, 'issues'];
      let query: Record<string, string> | undefined;
      if (item.kind === 'needs_decision' && item.decisionId) {
        const decision = store.decisionById().get(item.decisionId);
        if (decision) commands.splice(2, 1, 'decisions', decision.key);
      } else if (item.kind === 'triage') {
        query = { status: 'backlog', ...(item.issueId && store.issueById().get(item.issueId)?.teamId ? { team: store.issueById().get(item.issueId)!.teamId! } : {}) };
      }
      const chip: AttentionRow['chip'] = item.decisionId && store.decisionById().has(item.decisionId)
        ? { type: 'decision', ref: item.decisionId }
        : item.issueId && store.issueById().has(item.issueId)
          ? { type: 'issue', ref: item.issueId }
          : null;
      return { item, commands, query, chip };
    });
  });
  readonly attentionKinds = computed(() => {
    const counts = this.store.attentionCounts();
    return ATTENTION_KINDS.filter((kind) => counts[kind] > 0).map((kind) => ({
      kind,
      count: counts[kind],
      label: ATTENTION_KIND_META[kind].label,
    }));
  });

  readonly assigned = computed<Issue[]>(() => {
    const me = this.store.me()?.id;
    if (!me) return [];
    return this.store.issues()
      .filter((i) => i.assigneeId === me && i.status === 'in_progress')
      .sort((a, b) => PRIORITY_META[a.priority].order - PRIORITY_META[b.priority].order || b.updatedAt.localeCompare(a.updatedAt));
  });
  readonly assignedTop = computed(() => this.assigned().slice(0, 4));

  readonly firstName = computed(() => (this.store.me()?.name ?? '').trim().split(/\s+/)[0] ?? '');
  readonly openIssueCount = computed(() => this.store.issues().filter(isOpenIssue).length);
  readonly statusLine = computed(() => {
    const count = this.attentionCount();
    return count ? `${count} ${count === 1 ? 'thing needs' : 'things need'} your attention` : 'No issues need your attention right now.';
  });
  readonly subtitle = computed(() => `${plural(this.openIssueCount(), 'open issue')}`);

  private readonly issueTimes = computed(() => {
    const recs: { created: number; started?: number; done?: number; closed?: number }[] = [];
    let doneWithoutTime = 0;
    for (const issue of this.store.issues()) {
      const created = ts(issue.createdAt);
      if (created === undefined) continue;
      const completed = ts(issue.completedAt);
      const isDone = issue.status === 'done';
      const isClosed = isDone || issue.status === 'canceled';
      if (isDone && completed === undefined) doneWithoutTime++;
      recs.push({
        created,
        started: ts(issue.startedAt),
        done: isDone ? completed : undefined,
        closed: isClosed ? (completed ?? ts(issue.updatedAt)) : undefined,
      });
    }
    return { recs, doneWithoutTime };
  });

  private readonly axis = computed(() => {
    this.store.issues();
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
    const openAt = (t: number): number => recs.filter((r) => r.created <= t && (r.closed === undefined || r.closed > t)).length;
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
    const openedTotal = f.opened.reduce((n, value) => n + value, 0);
    const closedTotal = f.closed.reduce((n, value) => n + value, 0);
    return {
      series,
      labels: ax.starts.map((s) => format(s, 'MMM d')),
      titles: ax.starts.map((s) => format(s, 'EEE, MMM d')),
      empty: openedTotal + closedTotal === 0 ? 'No issues were opened or closed in the last 30 days.' : undefined,
      subtitle: `${openedTotal} opened · ${closedTotal} closed in 30 days`,
      note: missing
        ? `${plural(missing, 'done issue')} ${missing === 1 ? 'has' : 'have'} no completion time and ${missing === 1 ? 'is' : 'are'} not counted as closed.`
        : 'Closed counts issues moved to Done.',
    };
  });

  readonly kpis = computed<OverviewKpi[]>(() => {
    const { recs } = this.issueTimes();
    const ax = this.axis();
    const f = this.flow();
    const now = ax.now;
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
    const inRange = (t: number | undefined, from: number, to: number): boolean => t !== undefined && t >= from && t < to;
    const closed7 = recs.filter((r) => inRange(r.done, now - 7 * DAY, now + 1)).length;
    const closedPrev7 = recs.filter((r) => inRange(r.done, now - 14 * DAY, now - 7 * DAY)).length;
    const closed: OverviewKpi = {
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
    const cycle = (from: number, to: number): number[] => recs
      .filter((r) => r.started !== undefined && r.done !== undefined && r.done >= r.started && inRange(r.done, from, to))
      .map((r) => (r.done! - r.started!) / DAY)
      .sort((a, b) => a - b);
    const durations = cycle(now - WINDOW * DAY, now + 1);
    const previous = cycle(now - 2 * WINDOW * DAY, now - WINDOW * DAY);
    const median = (values: number[]): number | undefined =>
      values.length ? values[Math.floor(values.length / 2)] : undefined;
    const currentMedian = median(durations);
    const previousMedian = median(previous);
    const cycleKpi: OverviewKpi = {
      key: 'cycle',
      label: 'Median cycle time',
      value: currentMedian === undefined ? '—' : formatDuration(currentMedian),
      delta: currentMedian !== undefined && previousMedian !== undefined ? pctDelta(currentMedian, previousMedian, 'down', `vs the previous 30 days (${formatDuration(previousMedian)})`) : undefined,
      hint: currentMedian === undefined ? 'no finished issues with a start time' : `started to done · ${plural(durations.length, 'issue')}`,
      spark: [],
      sparkColor: 'var(--chart-3)',
      link: ['stats'],
    };
    return [open, closed, cycleKpi];
  });

  readonly teamBars = computed<BarRow[]>(() => {
    const out: BarRow[] = [];
    for (const [teamId, issues] of this.store.issuesByTeam()) {
      const team = teamId ? this.store.teamById().get(teamId) : undefined;
      if (!team) continue;
      const value = issues.filter(isOpenIssue).length;
      if (value) out.push({ key: team.id, label: team.name, hint: team.key, value, detail: `${team.name}: ${value} open` });
    }
    return out.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)).slice(0, 8);
  });

  readonly decisions = computed<Decision[]>(() => {
    const all = this.store.decisions();
    const proposed = all.filter((d) => d.status === 'proposed').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const rest = all.filter((d) => d.status === 'accepted').sort((a, b) => (b.decidedAt ?? b.updatedAt).localeCompare(a.decidedAt ?? a.updatedAt));
    return [...proposed, ...rest].slice(0, 5);
  });
  readonly proposedCount = computed(() => this.store.decisions().filter((d) => d.status === 'proposed').length);
  readonly backlogCount = this.store.backlogIssueCount;
  readonly triage = computed(() => [...this.store.backlogIssues()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4));
  readonly events = computed(() => this.store.events().slice(0, 8));
}
