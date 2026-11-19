import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { format } from 'date-fns';
import { ISSUE_KIND_META } from '../../../core';
import { BarList, type BarRow } from '../charts/bar-list';
import { ChartCard } from '../charts/chart-card';
import type { ChartSeries } from '../charts/chart-utils';
import { ColumnChart, type ColumnSeries } from '../charts/column-chart';
import { KpiTile } from '../charts/kpi-tile';
import { PercentileStrip } from '../charts/percentile-strip';
import { StatSection } from '../charts/stat-section';
import { TimeChart } from '../charts/time-chart';
import { formatDuration, pctDelta } from '../insights';
import {
  DURATION_BINS,
  closedPerBucket,
  completedInRange,
  createdInRange,
  createdPerBucket,
  cumulativeFlow,
  cycleDays,
  durations,
  histogram,
  leadDays,
  mean,
  medianPerBucket,
  percentiles,
  rollingMean,
  wipOverTime,
} from '../stats-flow';
import { median } from '../flow-stats';
import { ISSUE_COLOR } from '../stats-colors';
import { StatsScope } from '../stats-scope';

/** Flow: how much is created and closed, how long it takes, how much is in progress at once. */
@Component({
  selector: 'app-stats-flow-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [StatSection, KpiTile, ChartCard, ColumnChart, TimeChart, BarList, PercentileStrip],
  host: { class: 'block' },
  template: `
    <app-stat-section
      title="Created and closed"
      description="Tasks created, and tasks moved to Done, during the period ({{ s.range().label }}). Canceled tasks are never counted as closed. Durations use completed tasks only and are summarised with the median, so one forgotten task cannot move them."
    >
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3" aria-label="Key figures">
        <li class="flex">
          <app-kpi-tile class="w-full" label="Created" [value]="'' + created().length" [delta]="createdDelta()" [hint]="s.range().label" [spark]="createdSeries()" sparkColor="var(--chart-1)" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Closed" [value]="'' + closed().length" [delta]="closedDelta()" [hint]="s.range().label" [spark]="closedSeries()" sparkColor="var(--status-shipped)" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Net change" [value]="netText()" [hint]="netHint()" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Median cycle time" [value]="text(cycle().median)" [delta]="cycleDelta()" [hint]="cycleHint()" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Median lead time" [value]="text(lead().median)" [delta]="leadDelta()" [hint]="leadHint()" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Average in progress" [value]="avgWip() === undefined ? '—' : '' + +avgWip()!.toFixed(1)" [hint]="wipHint()" />
        </li>
      </ul>

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <app-chart-card
          [title]="'Created vs closed per ' + s.bucketSet().unit"
          subtitle="When more tasks are created than closed, the open list is growing."
          [empty]="flowEmpty() ? 'No task was created or closed in this period.' : undefined"
        >
          <app-column-chart [series]="flowSeries()" [labels]="labels()" [tooltipTitles]="titles()" ariaLabel="Tasks created and closed per bucket" />
        </app-chart-card>
        <app-chart-card
          title="Throughput trend"
          [subtitle]="'Tasks closed per ' + s.bucketSet().unit + ', with the ' + avgWindow() + '-' + s.bucketSet().unit + ' average to show the direction.'"
          [empty]="closedEmpty() ? 'No task was closed in this period.' : undefined"
        >
          <app-column-chart [series]="throughputSeries()" [labels]="labels()" [tooltipTitles]="titles()" ariaLabel="Tasks closed per bucket with a rolling average" />
        </app-chart-card>
      </div>
    </app-stat-section>

    <app-stat-section
      title="How long tasks take"
      description="Cycle time runs from the day a task was first started to the day it was completed, so it includes any waiting in between. Lead time runs from the day it was created. Tasks that are still open, canceled or stale never count."
    >
      <div class="grid gap-4 lg:grid-cols-2">
        <app-chart-card
          title="Cycle time"
          subtitle="Start to done. Each bar counts completed tasks that took that long."
          [empty]="cycle().n ? undefined : 'No task completed in this period has a start date. Cycle time needs a task that was moved to In progress and then to Done.'"
          [note]="cycleNote()"
        >
          <app-percentile-strip class="mb-3" [stats]="cycle()" />
          <app-time-chart mode="bars" [series]="cycleBins()" [labels]="binLabels" [height]="170" ariaLabel="Completed tasks by cycle time" />
        </app-chart-card>
        <app-chart-card
          title="Lead time"
          subtitle="Created to done. Each bar counts completed tasks that took that long."
          [empty]="lead().n ? undefined : 'No task was completed in this period.'"
        >
          <app-percentile-strip class="mb-3" [stats]="lead()" />
          <app-time-chart mode="bars" [series]="leadBins()" [labels]="binLabels" [height]="170" ariaLabel="Completed tasks by lead time" />
        </app-chart-card>
        <app-chart-card
          [title]="'Cycle and lead time per ' + s.bucketSet().unit"
          subtitle="The median for the tasks completed in each bar. A gap means no task was completed then."
          [empty]="trendEmpty() ? 'Needs at least one completed task in the period.' : undefined"
        >
          <app-time-chart [series]="trendSeries()" [labels]="labels()" [tooltipTitles]="titles()" [integer]="false" [valueFormat]="days" ariaLabel="Median cycle and lead time per bucket" />
        </app-chart-card>
        <app-chart-card
          title="Cycle time by kind of task"
          subtitle="Median start-to-done time for each kind. Kinds with a single task are shown but mean little."
          [empty]="kindRows().length ? undefined : 'No completed task in this period has a start date.'"
        >
          <app-bar-list [rows]="kindRows()" ariaLabel="Median cycle time by kind" />
        </app-chart-card>
      </div>
    </app-stat-section>

    <app-stat-section
      title="Work in progress"
      description="Tasks being worked on (In progress or In review) at the end of each day. The history is rebuilt from each task's start and completion dates, so a task moved back to Todo after it started still shows as worked on until today."
    >
      <div class="grid gap-4 lg:grid-cols-2">
        <app-chart-card
          title="In progress over time"
          [subtitle]="'Tasks being worked on at once. ' + staleNote()"
          [empty]="wipEmpty() ? 'No task was in progress during this period.' : undefined"
        >
          <app-time-chart [series]="wipSeries()" [labels]="timeLabels()" [tooltipTitles]="timeTitles()" ariaLabel="Tasks in progress over time" />
        </app-chart-card>
        <app-chart-card
          title="Cumulative flow"
          subtitle="All tasks, by where they were. A band that keeps widening is a queue building up; a thin In progress band means work flows."
          [empty]="cfdEmpty() ? 'No task existed during this period.' : undefined"
          note="Canceled tasks are left out."
        >
          <app-time-chart mode="stacked" [series]="cfdSeries()" [labels]="timeLabels()" [tooltipTitles]="timeTitles()" ariaLabel="Cumulative flow of tasks by state" />
        </app-chart-card>
      </div>
    </app-stat-section>
  `,
})
export class FlowTab {
  protected readonly s = inject(StatsScope);
  protected readonly binLabels = DURATION_BINS.map((b) => b.label);
  protected readonly days = (v: number): string => (v === 0 ? '0' : formatDuration(v));

  // ── counts
  protected readonly created = computed(() => createdInRange(this.s.issues(), this.s.range()));
  protected readonly closed = computed(() => completedInRange(this.s.issues(), this.s.range()));
  private readonly createdPrev = computed(() => createdInRange(this.s.issues(), this.s.prevRange()).length);
  private readonly closedPrev = computed(() => completedInRange(this.s.issues(), this.s.prevRange()).length);
  private readonly against = 'vs the previous period';
  protected readonly createdDelta = computed(() => pctDelta(this.created().length, this.createdPrev(), null, this.against));
  protected readonly closedDelta = computed(() => pctDelta(this.closed().length, this.closedPrev(), 'up', this.against));
  protected readonly netText = computed(() => {
    const n = this.created().length - this.closed().length;
    return n === 0 ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
  });
  protected readonly netHint = computed(() => {
    const n = this.created().length - this.closed().length;
    return n > 0 ? 'open list grew' : n < 0 ? 'open list shrank' : 'closed = created';
  });

  // ── per bucket
  private readonly items = computed(() => this.s.bucketSet().items);
  protected readonly labels = computed(() => this.items().map((b) => b.label));
  protected readonly titles = computed(() => this.items().map((b) => b.title));
  private readonly createdPer = computed(() => createdPerBucket(this.s.issues(), this.items()));
  private readonly closedPer = computed(() => closedPerBucket(this.s.issues(), this.items()));
  protected readonly createdSeries = this.createdPer;
  protected readonly closedSeries = this.closedPer;
  protected readonly flowEmpty = computed(() => this.createdPer().every((v) => v === 0) && this.closedPer().every((v) => v === 0));
  protected readonly closedEmpty = computed(() => this.closedPer().every((v) => v === 0));
  protected readonly avgWindow = computed(() => (this.s.bucketSet().unit === 'week' ? 4 : 7));
  protected readonly flowSeries = computed<ColumnSeries[]>(() => [
    { key: 'created', label: 'Created', color: 'var(--chart-1)', values: this.createdPer() },
    { key: 'closed', label: 'Closed', color: ISSUE_COLOR.done, values: this.closedPer() },
  ]);
  protected readonly throughputSeries = computed<ColumnSeries[]>(() => [
    { key: 'closed', label: 'Closed', color: ISSUE_COLOR.done, values: this.closedPer() },
    {
      key: 'avg',
      label: `${this.avgWindow()}-${this.s.bucketSet().unit} average`,
      color: 'var(--chart-3)',
      type: 'line',
      values: rollingMean(this.closedPer(), this.avgWindow()).map((v) => (v === null ? null : +v.toFixed(2))),
    },
  ]);

  // ── durations
  private readonly closedPrevList = computed(() => completedInRange(this.s.issues(), this.s.prevRange()));
  protected readonly cycle = computed(() => percentiles(durations(this.closed(), cycleDays)));
  protected readonly lead = computed(() => percentiles(durations(this.closed(), leadDays)));
  private readonly cyclePrev = computed(() => percentiles(durations(this.closedPrevList(), cycleDays)));
  private readonly leadPrev = computed(() => percentiles(durations(this.closedPrevList(), leadDays)));
  protected readonly cycleDelta = computed(() => {
    const c = this.cycle().median;
    return c === undefined ? undefined : pctDelta(c, this.cyclePrev().median, 'down', this.against);
  });
  protected readonly leadDelta = computed(() => {
    const c = this.lead().median;
    return c === undefined ? undefined : pctDelta(c, this.leadPrev().median, 'down', this.against);
  });
  protected readonly cycleHint = computed(() => (this.cycle().n ? `${this.cycle().n} ${this.cycle().n === 1 ? 'task' : 'tasks'}, start to done` : 'no task with a start date'));
  protected readonly leadHint = computed(() => (this.lead().n ? `${this.lead().n} ${this.lead().n === 1 ? 'task' : 'tasks'}, created to done` : 'no completed task'));
  protected readonly cycleNote = computed(() => {
    const missing = this.closed().length - this.cycle().n;
    return missing > 0 ? `${missing} completed ${missing === 1 ? 'task has' : 'tasks have'} no start date and ${missing === 1 ? 'is' : 'are'} left out.` : undefined;
  });
  protected readonly cycleBins = computed<ChartSeries[]>(() => [
    { key: 'n', label: 'Tasks', color: 'var(--chart-1)', values: histogram(durations(this.closed(), cycleDays)) },
  ]);
  protected readonly leadBins = computed<ChartSeries[]>(() => [
    { key: 'n', label: 'Tasks', color: 'var(--chart-2)', values: histogram(durations(this.closed(), leadDays)) },
  ]);
  private readonly cyclePer = computed(() => medianPerBucket(this.s.issues(), this.items(), cycleDays));
  private readonly leadPer = computed(() => medianPerBucket(this.s.issues(), this.items(), leadDays));
  protected readonly trendEmpty = computed(() => this.cyclePer().every((v) => v === null) && this.leadPer().every((v) => v === null));
  protected readonly trendSeries = computed<ChartSeries[]>(() => [
    { key: 'cycle', label: 'Cycle time', color: 'var(--chart-1)', values: this.cyclePer() },
    { key: 'lead', label: 'Lead time', color: 'var(--chart-2)', values: this.leadPer() },
  ]);
  protected readonly kindRows = computed<BarRow[]>(() => {
    const byKind = new Map<string, number[]>();
    for (const i of this.closed()) {
      const d = cycleDays(i);
      if (d !== undefined) byKind.set(i.kind, [...(byKind.get(i.kind) ?? []), d]);
    }
    return [...byKind.entries()]
      .map(([kind, list]) => ({ kind, n: list.length, med: median(list)! }))
      .sort((a, b) => b.med - a.med)
      .map(({ kind, n, med }) => ({
        key: kind,
        label: ISSUE_KIND_META[kind as keyof typeof ISSUE_KIND_META]?.label ?? kind,
        hint: `${n} ${n === 1 ? 'task' : 'tasks'}`,
        value: med,
        valueLabel: formatDuration(med),
        detail: `${ISSUE_KIND_META[kind as keyof typeof ISSUE_KIND_META]?.label ?? kind}: median ${formatDuration(med)} over ${n} completed ${n === 1 ? 'task' : 'tasks'}`,
        color: n < 2 ? 'var(--status-draft)' : 'var(--chart-1)',
      }));
  });

  // ── over time
  private readonly timesList = computed(() => this.s.times());
  protected readonly timeLabels = computed(() => this.timesList().map((t) => format(t, 'MMM d')));
  protected readonly timeTitles = computed(() => this.timesList().map((t) => format(t, 'EEE, MMM d')));
  private readonly wip = computed(() => wipOverTime(this.s.issues(), this.timesList(), this.s.now(), this.s.staleIds()));
  protected readonly avgWip = computed(() => mean(this.wip()));
  protected readonly wipEmpty = computed(() => this.wip().every((v) => v === 0));
  protected readonly wipHint = computed(() => {
    const n = this.s.staleIds().size;
    return n ? `${n} stale ${n === 1 ? 'task is' : 'tasks are'} left out` : 'average over the days of the period';
  });
  protected readonly staleNote = computed(() => {
    const n = this.s.staleIds().size;
    return n ? `${n} stale ${n === 1 ? 'task is' : 'tasks are'} not counted.` : 'No task is stale.';
  });
  protected readonly wipSeries = computed<ChartSeries[]>(() => [
    { key: 'wip', label: 'In progress or in review', color: ISSUE_COLOR.in_progress, values: this.wip() },
  ]);
  private readonly flow = computed(() => cumulativeFlow(this.s.issues(), this.timesList(), this.s.now()));
  protected readonly cfdEmpty = computed(() => {
    const f = this.flow();
    return f.waiting.every((v, i) => v + f.active[i] + f.done[i] === 0);
  });
  protected readonly cfdSeries = computed<ChartSeries[]>(() => [
    { key: 'done', label: 'Done', color: ISSUE_COLOR.done, values: this.flow().done },
    { key: 'active', label: 'In progress or in review', color: ISSUE_COLOR.in_progress, values: this.flow().active },
    { key: 'waiting', label: 'Not started', color: ISSUE_COLOR.todo, values: this.flow().waiting },
  ]);

  protected text(days: number | undefined): string {
    return days === undefined ? '—' : formatDuration(days);
  }
}
