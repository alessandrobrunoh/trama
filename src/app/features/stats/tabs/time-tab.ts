import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { addDays, format, startOfWeek } from 'date-fns';
import { formatEstimate, formatSpan, type EstimateScale } from '../../../core';
import { BarList, type BarRow } from '../charts/bar-list';
import { ChartCard } from '../charts/chart-card';
import type { ChartSeries } from '../charts/chart-utils';
import { Heatmap } from '../charts/heatmap';
import { KpiTile, type KpiDelta } from '../charts/kpi-tile';
import { StatSection } from '../charts/stat-section';
import { TaskList, type TaskListRow } from '../charts/task-list';
import { PACE_BAND, REF_MIN, estimateAccuracy, estimateCoverage } from '../flow-stats';
import { StatsScope } from '../stats-scope';
import { TimeChart } from '../charts/time-chart';
import { accuracyPerBucket, biggestOverruns, daySummary, msByKey, msPerBucket, pacedTasks, totalMs, weekdayHour } from '../stats-time';

const HOUR = 3_600_000;
const TOP_TASKS = 8;

const hours = (v: number): string => (v === 0 ? '0' : v < 1 ? `${+(v * 60).toFixed(1)}m` : `${+v.toFixed(1)}h`);
const pointsText = (estimate: number, scale: EstimateScale): string => {
  const label = formatEstimate(estimate, scale);
  return /^[\d.]+$/.test(label) ? `${label} ${label === '1' ? 'point' : 'points'}` : label;
};

/**
 * Time: only the time the signed-in person tracked with the timer, and how it compares with estimates. Time that a
 * task spent in a status is never used as time spent, and a timer that is still running is not counted until it stops.
 */
@Component({
  selector: 'app-stats-time-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, StatSection, KpiTile, ChartCard, TimeChart, BarList, Heatmap, TaskList],
  host: { class: 'block' },
  template: `
    @if (!s.entries().length) {
      <div class="border-border mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 border border-dashed px-4 py-3 text-xs">
        <p class="text-muted-foreground min-w-0 flex-1">
          You have not tracked any time yet. Start the timer on a task, or add time by hand, and these charts fill in.
        </p>
        <a hlmBtn variant="outline" size="sm" [routerLink]="['/', s.slug(), 'timer']">Open the timer</a>
      </div>
    }

    <app-stat-section
      title="My tracked time"
      description="Time you tracked with the timer during the period ({{ s.range().label }}), never the time a task sat in a status. It is your time only: teammates' time is not shown. {{ timersNote() }}"
    >
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3" aria-label="Key figures">
        <li class="flex">
          <app-kpi-tile class="w-full" label="Tracked" [value]="span(total())" [delta]="delta()" [hint]="s.range().label" [spark]="sparkHours()" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Days with time" [value]="'' + summary().activeDays" [hint]="'of ' + s.range().days + ' days'" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Avg per active day" [value]="summary().activeDays ? span(total() / summary().activeDays) : '—'" hint="on the days you tracked" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Longest day" [value]="summary().longestMs ? span(summary().longestMs) : '—'" hint="most time tracked in one day" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Tasks worked on" [value]="'' + byTask().length" hint="with time tracked in the period" />
        </li>
        <li class="flex">
          <app-kpi-tile class="w-full" label="Your time per point" [value]="paced().paceMsPerPoint ? span(paced().paceMsPerPoint!) : '—'" [hint]="paceHint()" />
        </li>
      </ul>

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <app-chart-card
          [title]="'Tracked time per ' + s.timeBucketSet().unit"
          subtitle="Hours you tracked in each bar."
          [empty]="total() ? undefined : noTime"
          class="lg:col-span-2"
        >
          <app-time-chart mode="bars" [series]="perBucketSeries()" [labels]="bucketLabels()" [tooltipTitles]="bucketTitles()" [integer]="false" [valueFormat]="hoursFormat" ariaLabel="Tracked time per bucket" />
        </app-chart-card>
        <app-chart-card title="By project" subtitle="Where your time went." [empty]="total() ? undefined : noTime">
          <app-bar-list [rows]="projectRows()" ariaLabel="Tracked time by project" />
        </app-chart-card>
        <app-chart-card
          title="By label"
          subtitle="Time on tasks that carry each label. A task with several labels counts under each."
          [empty]="total() ? (labelRows().length ? undefined : 'None of the tasks you tracked time on has a label.') : noTime"
        >
          <app-bar-list [rows]="labelRows()" ariaLabel="Tracked time by label" />
        </app-chart-card>
        <app-chart-card title="Most time on" subtitle="The tasks that took most of your time. Select one to open it." [empty]="total() ? undefined : noTime">
          <app-bar-list [rows]="taskRows()" [interactive]="true" (rowClick)="openTask($event)" ariaLabel="Tracked time by task" />
        </app-chart-card>
        <app-chart-card title="By weekday" subtitle="Which days of the week you track most." [empty]="total() ? undefined : noTime">
          <app-bar-list [rows]="weekdayRows()" ariaLabel="Tracked time by weekday" />
        </app-chart-card>
        <app-chart-card
          title="When you work"
          subtitle="Weekday and hour of the day. The darker the cell, the more time you tracked then."
          [empty]="total() ? undefined : noTime"
          class="lg:col-span-2"
        >
          <app-heatmap [rows]="weekdayNames()" [columns]="hourLabels" [values]="grid()" [format]="gridFormat" [describe]="gridDescribe" ariaLabel="Tracked time by weekday and hour" />
        </app-chart-card>
      </div>
    </app-stat-section>

    <app-stat-section
      title="Estimate against actual"
      description="For each finished task that has an estimate, this compares the estimate with the time you tracked on it. Estimates are points, so “expected” means your usual time per point times the estimate. It looks at your tasks that are finished, over all time, not just the period."
    >
      @if (scale() === 'none' && !paced().sample) {
        <p class="text-muted-foreground border-border border border-dashed px-4 py-6 text-center text-[13px]">
          Estimates are turned off in this workspace. Pick an estimate scale in settings to compare estimates with tracked time.
        </p>
      } @else {
        <div class="grid gap-4 lg:grid-cols-2">
          <app-chart-card
            title="Time tracked per estimate"
            subtitle="The median time you tracked on finished tasks, for each estimate size."
            [empty]="accuracy().rows.length ? undefined : notEnough()"
            [note]="accuracyNote()"
          >
            @if (paceLine(); as line) {
              <p class="text-muted-foreground mb-3 font-mono text-[11px]">{{ line }}</p>
            }
            <app-bar-list [rows]="estimateRows()" ariaLabel="Median tracked time per estimate" />
          </app-chart-card>
          <app-chart-card
            [title]="'Estimate accuracy per ' + s.bucketSet().unit"
            [subtitle]="'The share of tasks finished in each bar that took between half and ' + paceBand + '× your usual time for their estimate.'"
            [empty]="accuracyEmpty() ? (paced().paceMsPerPoint === undefined ? notEnough() : 'No task with an estimate and tracked time was finished in this period.') : undefined"
          >
            <app-time-chart [series]="accuracySeries()" [labels]="accuracyLabels()" [tooltipTitles]="accuracyTitles()" [valueFormat]="percentFormat" [integer]="false" ariaLabel="Estimate accuracy per bucket" />
          </app-chart-card>
          <app-chart-card
            title="Biggest overruns"
            subtitle="Finished tasks that took longest compared with their estimate."
            [empty]="overrunRows().length ? undefined : paced().paceMsPerPoint === undefined ? notEnough() : 'No finished task took longer than your usual time for its estimate.'"
          >
            <app-task-list [rows]="overrunRows()" [slug]="s.slug()" ariaLabel="Biggest overruns" />
          </app-chart-card>
          <app-chart-card
            title="What is missing"
            subtitle="How many finished tasks can be compared at all."
          >
            <ul class="flex flex-col gap-1.5 text-xs">
              <li class="flex items-center gap-2"><span class="font-medium tabular-nums">{{ coverage().withEstimate }}</span><span class="text-muted-foreground">of your {{ coverage().finished }} finished {{ coverage().finished === 1 ? 'task has' : 'tasks have' }} an estimate</span></li>
              <li class="flex items-center gap-2"><span class="font-medium tabular-nums">{{ coverage().withTime }}</span><span class="text-muted-foreground">have time you tracked</span></li>
              <li class="flex items-center gap-2"><span class="font-medium tabular-nums">{{ coverage().both }}</span><span class="text-muted-foreground">have both, which is what gets compared (at least {{ refMin }} needed)</span></li>
            </ul>
          </app-chart-card>
        </div>
      }
    </app-stat-section>
  `,
})
export class TimeTab {
  protected readonly s = inject(StatsScope);
  private readonly router = inject(Router);
  protected readonly noTime = 'You tracked no time in this period. Start the timer on a task to see it here.';
  protected readonly refMin = REF_MIN;
  protected readonly paceBand = PACE_BAND;
  protected readonly hourLabels = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  protected readonly hoursFormat = hours;
  protected readonly percentFormat = (v: number): string => `${Math.round(v)}%`;
  protected readonly scale = computed(() => this.s.estimateScale());

  // ── totals
  protected readonly total = computed(() => totalMs(this.s.spans(), this.s.range()));
  private readonly prevTotal = computed(() => totalMs(this.s.spans(), this.s.prevRange()));
  /** More tracked time is not good or bad in itself, so the change is neutral and written as a span of time. */
  protected readonly delta = computed<KpiDelta | undefined>(() => {
    const prev = this.prevTotal();
    const diff = this.total() - prev;
    if (!prev && !this.total()) return undefined;
    const title = `vs the previous period: ${prev ? formatSpan(prev) : 'nothing tracked'}`;
    if (Math.abs(diff) < 60_000) return { text: 'no change', direction: 'flat', tone: 'neutral', title };
    return { text: formatSpan(Math.abs(diff)), direction: diff > 0 ? 'up' : 'down', tone: 'neutral', title };
  });
  protected readonly summary = computed(() => daySummary(this.s.spans(), this.s.range()));
  protected readonly timersNote = computed(() => {
    const n = this.s.runningTimers();
    return n ? `${n} running ${n === 1 ? 'timer is' : 'timers are'} not counted until stopped.` : '';
  });

  // ── per bucket
  private readonly items = computed(() => this.s.timeBucketSet().items);
  protected readonly bucketLabels = computed(() => this.items().map((b) => b.label));
  protected readonly bucketTitles = computed(() => this.items().map((b) => b.title));
  private readonly perBucket = computed(() => msPerBucket(this.s.spans(), this.items()).map((ms) => +(ms / HOUR).toFixed(3)));
  protected readonly sparkHours = this.perBucket;
  protected readonly perBucketSeries = computed<ChartSeries[]>(() => [
    { key: 'tracked', label: 'Tracked', color: 'var(--chart-1)', values: this.perBucket() },
  ]);

  // ── breakdowns
  private readonly byProjectAll = computed(() => msByKey(this.s.spans(), this.s.range(), (sp) => [sp.projectId ?? 'none']));
  protected readonly projectRows = computed<BarRow[]>(() =>
    this.byProjectAll().map(({ key, ms }) => {
      const project = key === 'none' ? undefined : this.s.store.getProject(key);
      const label = key === 'none' ? 'No project' : (project?.name ?? 'Unknown project');
      return { key, label, project, value: ms, valueLabel: this.span(ms), detail: `${label}: ${this.span(ms)}`, color: key === 'none' ? 'var(--status-draft)' : (project?.color ?? 'var(--chart-1)') };
    }),
  );
  protected readonly labelRows = computed<BarRow[]>(() => {
    const byId = this.s.store.issueById();
    const labels = this.s.store.settings().labels;
    return msByKey(this.s.spans(), this.s.range(), (sp) => {
      const ids = sp.issueId ? (byId.get(sp.issueId)?.labels ?? []) : [];
      return ids.length ? ids : [''];
    })
      .filter((r, _, all) => r.key !== '' || all.some((x) => x.key !== ''))
      .map(({ key, ms }) => {
        const label = key ? (labels.find((l) => l.id === key)?.name ?? 'Unknown label') : 'No label';
        return { key: key || 'none', label, value: ms, valueLabel: this.span(ms), detail: `${label}: ${this.span(ms)}`, color: key ? (labels.find((l) => l.id === key)?.color ?? 'var(--chart-1)') : 'var(--status-draft)' };
      });
  });
  protected readonly byTask = computed(() => msByKey(this.s.spans(), this.s.range(), (sp) => (sp.issueId ? [sp.issueId] : [])));
  protected readonly taskRows = computed<BarRow[]>(() => {
    const byId = this.s.store.issueById();
    return this.byTask()
      .slice(0, TOP_TASKS)
      .map(({ key, ms }) => {
        const issue = byId.get(key);
        return { key: issue?.key ?? key, label: issue?.title ?? 'Deleted task', hint: issue?.key, value: ms, valueLabel: this.span(ms), detail: `${issue?.key ?? ''} ${issue?.title ?? ''}: ${this.span(ms)}`.trim(), color: 'var(--chart-2)' };
      });
  });

  // ── weekday and hour
  protected readonly grid = computed(() => weekdayHour(this.s.spans(), this.s.range(), this.s.store.weekStartsOn()));
  protected readonly weekdayNames = computed(() => {
    const start = this.s.store.weekStartsOn();
    const first = startOfWeek(new Date(), { weekStartsOn: start });
    return Array.from({ length: 7 }, (_, i) => format(addDays(first, i), 'EEE'));
  });
  protected readonly gridFormat = (ms: number): string => (ms > 0 ? formatSpan(ms) : 'no time');
  protected readonly gridDescribe = (row: string, col: string, value: string): string => `${row}, ${col}:00 to ${String((Number(col) + 1) % 24).padStart(2, '0')}:00: ${value}`;
  protected readonly weekdayRows = computed<BarRow[]>(() =>
    this.grid().map((cells, i) => {
      const ms = cells.reduce((a, b) => a + b, 0);
      const label = this.weekdayNames()[i];
      return { key: label, label, value: ms, valueLabel: ms ? this.span(ms) : '—', detail: `${label}: ${ms ? this.span(ms) : 'no time'}`, color: 'var(--chart-1)' };
    }),
  );

  // ── estimates against my tracked time
  /** My tasks: assigned to me, or any task I tracked time on. */
  private readonly myIssues = computed(() => {
    const me = this.s.myId();
    const tracked = this.s.tracked();
    return this.s.issues().filter((i) => i.assigneeId === me || tracked.has(i.id));
  });
  protected readonly paced = computed(() => pacedTasks(this.myIssues(), this.s.tracked()));
  protected readonly accuracy = computed(() => estimateAccuracy(this.myIssues(), this.s.tracked()));
  protected readonly coverage = computed(() => estimateCoverage(this.myIssues(), this.s.tracked()));
  protected readonly paceHint = computed(() => (this.paced().paceMsPerPoint ? `median of ${this.paced().sample} finished tasks` : `needs ${REF_MIN} finished tasks with an estimate and time`));
  protected readonly estimateRows = computed<BarRow[]>(() =>
    this.accuracy().rows.map((r) => ({
      key: String(r.estimate),
      label: pointsText(r.estimate, this.scale()),
      hint: `${r.n} ${r.n === 1 ? 'task' : 'tasks'}`,
      value: r.medianMs,
      valueLabel: this.span(r.medianMs),
      detail: `${pointsText(r.estimate, this.scale())}: median ${this.span(r.medianMs)}, middle half ${this.span(r.p25Ms)} to ${this.span(r.p75Ms)}, ${r.n} finished ${r.n === 1 ? 'task' : 'tasks'}${r.thin ? ` (fewer than ${REF_MIN}: treat with care)` : ''}`,
      color: r.thin ? 'var(--status-draft)' : 'var(--chart-1)',
    })),
  );
  protected readonly paceLine = computed(() => {
    const a = this.accuracy();
    if (a.paceMsPerPoint === undefined || a.consistentPct === undefined) return undefined;
    return `Your usual pace: ${this.span(a.paceMsPerPoint)} per point. ${a.consistentPct}% of ${a.sample} finished tasks took between half and ${PACE_BAND}× that.`;
  });
  protected readonly accuracyNote = computed(() => {
    const a = this.accuracy();
    const parts: string[] = [];
    if (a.excluded.noTime) parts.push(`${a.excluded.noTime} finished with an estimate but no tracked time`);
    if (a.excluded.noEstimate) parts.push(`${a.excluded.noEstimate} finished with tracked time but no estimate`);
    if (a.open.count) parts.push(`${a.open.count} still open with ${this.span(a.open.ms)} tracked (not compared)`);
    return parts.length ? `Left out: ${parts.join('; ')}.` : undefined;
  });
  protected readonly notEnough = computed(
    () => `Needs ${REF_MIN} finished tasks that have both an estimate and tracked time. You have ${this.coverage().both}.`,
  );
  private readonly accuracyPer = computed(() => accuracyPerBucket(this.paced().tasks, this.s.bucketSet().items));
  protected readonly accuracyEmpty = computed(() => this.accuracyPer().every((v) => v === null));
  protected readonly accuracyLabels = computed(() => this.s.bucketSet().items.map((b) => b.label));
  protected readonly accuracyTitles = computed(() => this.s.bucketSet().items.map((b) => b.title));
  protected readonly accuracySeries = computed<ChartSeries[]>(() => [
    { key: 'accuracy', label: 'Within the usual range', color: 'var(--chart-2)', values: this.accuracyPer() },
  ]);
  protected readonly overrunRows = computed<TaskListRow[]>(() =>
    biggestOverruns(this.paced().tasks).map((t) => ({
      id: t.issue.id,
      key: t.issue.key,
      title: t.issue.title,
      status: t.issue.status,
      detail: `${pointsText(t.issue.estimate!, this.scale())} · ${this.span(t.trackedMs)} tracked, about ${this.span(t.expectedMs)} expected`,
      badge: `${+t.factor.toFixed(1)}× longer`,
      tone: 'bad' as const,
    })),
  );

  protected span(ms: number): string {
    return formatSpan(ms);
  }
  protected openTask(row: BarRow): void {
    if (row.key) void this.router.navigate(['/', this.s.slug(), 'tasks', row.key]);
  }
}
