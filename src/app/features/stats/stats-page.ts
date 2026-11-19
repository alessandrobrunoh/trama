import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { LucideChartBar } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUS_META,
  TimeEntriesStore,
  TramaStore,
  formatEstimate,
  formatSpan,
} from '../../core';
import { AppSelect, type Option } from '../../shared/app-select';
import { EmptyState } from '../../shared/empty-state';
import { PageHeader } from '../../shared/page-header';
import { BarList, type BarRow } from './charts/bar-list';
import { ChartCard } from './charts/chart-card';
import { ColumnChart, type ColumnSeries } from './charts/column-chart';
import { KpiTile } from './charts/kpi-tile';
import {
  DAY,
  DEFAULT_IDLE_DAYS,
  IDLE_CHOICES,
  PACE_BAND,
  REF_MIN,
  activityLookup,
  completedSummary,
  createdIn,
  estimateAccuracy,
  estimateCoverage,
  openByProject,
  openByStatus,
  periodRanges,
  runningRows,
  runningTimers,
  trackedByIssue,
  trackedIn,
  weeklyThroughput,
  workload,
} from './flow-stats';
import { PERIODS, formatDuration, pctDelta, type Period } from './insights';
import { ISSUE_COLOR } from './stats-colors';

const RUNNING_SHOWN = 10;

/**
 * Workspace statistics, organised around questions people actually ask:
 *  1. How much gets finished?            completed and created tasks per week, time to finish
 *  2. What is open right now?            open tasks by status, by person and by project
 *  3. What is in progress, what is idle? the tasks that are moving and the ones nobody has touched
 *  4. Do my estimates match my time?     estimates against the time I tracked with the timer
 * Definitions live in flow-stats.ts and are repeated in plain words under each chart.
 */
@Component({
  selector: 'app-stats-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmToggleGroupImports,
    HlmTooltip,
    PageHeader,
    EmptyState,
    AppSelect,
    BarList,
    ChartCard,
    ColumnChart,
    KpiTile,
  ],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header
      title="Statistics"
      description="What gets finished, what is open, what has gone quiet, and how your estimates compare with your tracked time."
    />
    <div class="mx-auto w-full max-w-[1100px] px-4 pb-10 sm:px-6">
      @if (!hasTasks()) {
        <app-empty-state
          [icon]="chartIcon"
          title="Nothing to chart yet"
          description="Statistics appear once the workspace has tasks."
        />
      } @else {
        <div
          class="bg-background/90 sticky top-0 z-10 -mx-4 mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6"
        >
          <hlm-toggle-group
            type="single"
            variant="outline"
            size="sm"
            [value]="period()"
            (valueChange)="setPeriod($event)"
            aria-label="Period"
          >
            @for (p of periods; track p.id) {
              <button hlmToggleGroupItem [value]="p.id" class="max-sm:h-9" [hlmTooltip]="p.long" position="bottom">{{ p.label }}</button>
            }
          </hlm-toggle-group>
          <label class="text-muted-foreground flex items-center gap-2 text-xs">
            Person
            <app-select
              size="sm"
              class="w-40"
              label="Person"
              [options]="personOptions()"
              [value]="person()"
              (valueChange)="setPerson($event)"
            />
          </label>
          <label class="text-muted-foreground flex items-center gap-2 text-xs">
            Idle after
            <app-select
              size="sm"
              class="w-28"
              label="Idle after"
              [options]="idleOptions"
              [value]="'' + idleDays()"
              (valueChange)="setIdle($event)"
            />
          </label>
          @if (personId()) {
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground" (click)="setPerson('all')">Clear person</button>
          }
        </div>

        <!-- 1. how much gets finished -->
        <section class="mb-10" aria-labelledby="stats-finished">
          <h2 id="stats-finished" class="text-base">How much gets finished?</h2>
          <p class="text-meta mt-1 mb-4 max-w-3xl text-xs">
            Tasks moved to Done. Canceled tasks are not counted. “Typical time to finish” is the median from the day a task
            was started to the day it was completed, so it includes any waiting in between. It only looks at finished tasks,
            so a task that is still open cannot change it.
          </p>
          <ul class="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3" aria-label="Key figures">
            <li class="flex">
              <app-kpi-tile
                class="w-full"
                label="Tasks completed"
                [value]="'' + finished().cur.count"
                [delta]="finishedDelta()"
                [hint]="periodLong()"
              />
            </li>
            <li class="flex">
              <app-kpi-tile
                class="w-full"
                label="Tasks created"
                [value]="'' + createdNow()"
                [delta]="createdDelta()"
                [hint]="createdHint()"
              />
            </li>
            <li class="flex">
              <app-kpi-tile
                class="w-full"
                label="Typical time to finish"
                [value]="finished().cur.medianDaysToFinish === undefined ? '—' : durationText(finished().cur.medianDaysToFinish!)"
                [hint]="finishHint()"
              />
            </li>
            @if (showPoints()) {
              <li class="flex">
                <app-kpi-tile
                  class="w-full"
                  label="Points completed"
                  [value]="'' + finished().cur.points"
                  [hint]="pointsHint()"
                />
              </li>
            }
          </ul>
          <div class="mt-4 grid gap-4 lg:grid-cols-2">
            <app-chart-card
              title="Completed per week"
              subtitle="Tasks moved to Done. Each bar is the 7 days ending on the date shown."
              [empty]="weeksEmpty() ? 'No tasks were completed in this period.' : undefined"
            >
              <app-column-chart
                [series]="doneSeries()"
                [labels]="weekLabels()"
                [tooltipTitles]="weekTitles()"
                [notes]="weekNotes()"
                ariaLabel="Tasks completed per week"
              />
            </app-chart-card>
            <app-chart-card
              title="Created vs completed"
              subtitle="When more tasks are created than completed, the open list is growing."
              [empty]="flowEmpty() ? 'No tasks were created or completed in this period.' : undefined"
            >
              <app-column-chart
                [series]="flowSeries()"
                [labels]="weekLabels()"
                [tooltipTitles]="weekTitles()"
                ariaLabel="Tasks created and completed per week"
              />
            </app-chart-card>
          </div>
        </section>

        <!-- 2. what is open -->
        <section class="mb-10" aria-labelledby="stats-open">
          <h2 id="stats-open" class="text-base">What is open right now?</h2>
          <p class="text-meta mt-1 mb-4 max-w-3xl text-xs">
            {{ openTotal() }} {{ openTotal() === 1 ? 'task is' : 'tasks are' }} open: not done and not canceled, backlog included.
            “By status” and “By project” follow the person filter; “By person” always shows everyone.
          </p>
          <div class="grid gap-4 lg:grid-cols-3">
            <app-chart-card
              title="By status"
              subtitle="Where the open tasks stand: backlog, todo, in progress, in review."
              [empty]="openTotal() ? undefined : 'Nothing is open.'"
            >
              <app-bar-list [rows]="statusRows()" ariaLabel="Open tasks by status" />
            </app-chart-card>
            <app-chart-card
              title="By person"
              subtitle="Todo, in progress and in review per assignee. The backlog is nobody's load yet."
              [empty]="loadRows().length ? undefined : 'No open work is assigned.'"
            >
              <app-bar-list [rows]="loadRows()" defaultColor="var(--chart-3)" ariaLabel="Open tasks per person" />
            </app-chart-card>
            <app-chart-card
              title="By project"
              subtitle="Which projects hold the most open work."
              [empty]="projectRows().length ? undefined : 'Nothing is open.'"
            >
              <app-bar-list [rows]="projectRows()" defaultColor="var(--chart-2)" ariaLabel="Open tasks by project" />
            </app-chart-card>
          </div>
        </section>

        <!-- 3. in progress and idle -->
        <section class="mb-10" aria-labelledby="stats-running">
          <h2 id="stats-running" class="text-base">What is in progress, and what has gone idle?</h2>
          <p class="text-meta mt-1 mb-4 max-w-3xl text-xs">
            Tasks in In progress or In review. A task is <strong>idle</strong> when nothing has happened on it for
            {{ idleDays() }} days: no edit, comment, linked pull request or tracked time. Idle tasks are listed first and are
            left out of every average on this page.
          </p>
          <div class="bg-card border-border rounded-lg border">
            <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pt-3 pb-2 text-sm">
              <span><span class="font-semibold tabular-nums">{{ running().length }}</span> in progress or in review</span>
              <span [class.text-status-needs-input]="idleCount() > 0" [class.text-muted-foreground]="idleCount() === 0">
                <span class="font-semibold tabular-nums">{{ idleCount() }}</span> idle
              </span>
            </div>
            @if (running().length) {
              <ul>
                @for (r of shownRunning(); track r.issue.id) {
                  <li class="hover:bg-hover flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-xs">
                    <a
                      class="text-muted-foreground hover:text-foreground shrink-0 font-mono"
                      [routerLink]="['/', slug(), 'tasks', r.issue.key]"
                      >{{ r.issue.key }}</a
                    >
                    <a
                      class="min-w-0 flex-1 truncate text-[13px] hover:underline max-sm:basis-full"
                      [routerLink]="['/', slug(), 'tasks', r.issue.key]"
                      >{{ r.issue.title }}</a
                    >
                    <span class="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span class="flex items-center gap-1.5">
                        <span class="size-2 rounded-full" [style.background]="statusColor(r.issue.status)"></span>
                        {{ statusLabel(r.issue.status) }}
                      </span>
                      <span>{{ assignee(r.issue.assigneeId) }}</span>
                      <span hlmTooltip="Since the task was first started">started {{ span(r.sinceMs) }} ago</span>
                      <span class="tabular-nums" hlmTooltip="Finished time entries on this task">{{
                        r.trackedMs ? span(r.trackedMs) + ' tracked' : 'no time tracked'
                      }}</span>
                    </span>
                    @if (r.idle) {
                      <span
                        class="bg-status-needs-input/10 text-status-needs-input rounded-full px-2 py-0.5 font-medium whitespace-nowrap"
                        hlmTooltip="No activity since then"
                        >Idle {{ span(r.idleMs) }}</span
                      >
                    } @else {
                      <span class="text-status-shipped rounded-full px-2 py-0.5 whitespace-nowrap">Active</span>
                    }
                  </li>
                }
              </ul>
              @if (running().length > shownCount()) {
                <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground w-full justify-start" (click)="showAllRunning.set(true)">
                  Show all {{ running().length }}
                </button>
              }
            } @else {
              <p class="text-meta px-4 py-8 text-center">Nothing is in progress.</p>
            }
          </div>
        </section>

        <!-- 4. estimates vs the time I tracked -->
        <section class="mb-4" aria-labelledby="stats-estimates">
          <h2 id="stats-estimates" class="text-base">Do your estimates match the time you tracked?</h2>
          <p class="text-meta mt-1 mb-4 max-w-3xl text-xs">
            For each finished task that has an estimate, this compares the estimate with the time <strong>you</strong> tracked on
            it with the timer, never with the time it sat in a status. Only your own tracked time counts here, so it looks at
            your tasks and ignores the person filter and the period.
          </p>
          @if (scale() === 'none' && !accuracy().sample) {
            <p class="text-meta bg-muted rounded-lg px-4 py-6 text-center text-xs">
              Estimates are turned off in this workspace. Pick an estimate scale in settings to compare estimates with
              tracked time.
            </p>
          } @else if (accuracy().sample < refMin) {
            <div class="bg-muted rounded-lg px-5 py-5">
              <h3 class="text-sm font-medium">Not enough data yet</h3>
              <p class="text-muted-foreground mt-1 max-w-xl text-xs">
                Estimates are compared once you have finished at least {{ refMin }} tasks that have both an estimate and time
                tracked with the timer. Here is where you are:
              </p>
              <ul class="mt-3 flex max-w-xl flex-col gap-1.5 text-xs">
                <li class="flex items-center gap-2">
                  <span class="tabular-nums font-medium">{{ coverage().withEstimate }}</span>
                  <span class="text-muted-foreground">of your {{ coverage().finished }} finished {{ coverage().finished === 1 ? 'task has' : 'tasks have' }} an estimate</span>
                </li>
                <li class="flex items-center gap-2">
                  <span class="tabular-nums font-medium">{{ coverage().withTime }}</span>
                  <span class="text-muted-foreground">have time you tracked</span>
                </li>
                <li class="flex items-center gap-2">
                  <span class="tabular-nums font-medium">{{ coverage().both }} / {{ refMin }}</span>
                  <span class="text-muted-foreground">have both, which is what gets compared</span>
                </li>
              </ul>
              <p class="text-meta mt-3 text-xs">
                Time tracked by you in this period: <span class="text-foreground font-medium">{{ trackedNow() ? span(trackedNow()) : 'none' }}</span>{{ timersNote() }}
              </p>
              <a hlmBtn variant="outline" size="sm" class="mt-3" [routerLink]="['/', slug(), 'timer']">Open the timer</a>
            </div>
          } @else {
            <div class="grid gap-4 lg:grid-cols-2">
              <app-chart-card
                title="Time tracked per estimate"
                subtitle="The median time you tracked on finished tasks, for each estimate size."
                [note]="accuracyNote()"
              >
                @if (paceLine(); as line) {
                  <p class="mb-3 text-xs">{{ line }}</p>
                }
                <app-bar-list [rows]="estimateRows()" ariaLabel="Median tracked time per estimate" />
              </app-chart-card>
              <app-chart-card
                title="Far from your usual pace"
                [subtitle]="'Finished tasks that took less than half or more than ' + paceBand + '× your usual time per point.'"
                [empty]="outlierEmpty()"
              >
                <ul class="-mx-1 flex flex-col gap-1">
                  @for (o of accuracy().outliers; track o.issue.id) {
                    <li class="px-1 py-2 text-xs">
                      <div class="flex min-w-0 items-baseline gap-2">
                        <a class="text-muted-foreground hover:text-foreground shrink-0 font-mono" [routerLink]="['/', slug(), 'tasks', o.issue.key]">{{ o.issue.key }}</a>
                        <a class="min-w-0 truncate text-[13px] hover:underline" [routerLink]="['/', slug(), 'tasks', o.issue.key]">{{ o.issue.title }}</a>
                      </div>
                      <p class="text-muted-foreground mt-0.5">
                        {{ points(o.issue.estimate!) }} · {{ span(o.trackedMs) }} tracked, about {{ span(o.expectedMs) }} expected ·
                        <span [class.text-status-blocked]="o.factor > 1" [class.text-status-needs-input]="o.factor < 1">{{ factorText(o.factor) }}</span>
                      </p>
                    </li>
                  }
                </ul>
              </app-chart-card>
            </div>
          }
        </section>
      }
    </div>
  `,
})
export class StatsPage {
  protected readonly store = inject(TramaStore);
  private readonly time = inject(TimeEntriesStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  protected readonly chartIcon = LucideChartBar;
  protected readonly periods = PERIODS;
  protected readonly idleOptions: Option[] = IDLE_CHOICES.map((d) => ({ value: String(d), label: `${d} days` }));
  protected readonly paceBand = PACE_BAND;
  protected readonly refMin = REF_MIN;
  protected readonly showAllRunning = signal(false);
  /** Re-read the clock once a minute so "idle for" and "started … ago" do not go stale on a long-open tab. */
  private readonly now = signal(Date.now());

  constructor() {
    void this.time.load();
    const tick = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  // ── filters (kept in the URL so a view can be shared)
  protected readonly period = computed<Period>(() => {
    const p = this.query().get('period');
    return PERIODS.some((x) => x.id === p) ? (p as Period) : '30d';
  });
  protected readonly person = computed(() => this.query().get('person') || 'all');
  protected readonly idleDays = computed(() => {
    const d = Number(this.query().get('idle'));
    return (IDLE_CHOICES as readonly number[]).includes(d) ? d : DEFAULT_IDLE_DAYS;
  });
  protected readonly personId = computed(() => {
    const p = this.person();
    return p === 'all' ? null : p === 'me' ? (this.store.me()?.id ?? null) : p;
  });
  protected readonly personOptions = computed<Option[]>(() => [
    { value: 'all', label: 'Everyone' },
    ...(this.store.me() ? [{ value: 'me', label: 'Me' }] : []),
    ...this.store.members().map((m) => ({ value: m.user.id, label: m.user.name })),
  ]);
  protected readonly periodLong = computed(() => PERIODS.find((p) => p.id === this.period())?.long ?? '');
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly scale = computed(() => this.store.estimateScale());

  // ── data
  protected readonly hasTasks = computed(() => this.store.issues().length > 0);
  private readonly issues = computed(() => {
    const person = this.personId();
    const all = this.store.issues();
    return person ? all.filter((i) => i.assigneeId === person) : all;
  });
  private readonly entries = this.time.entries;
  private readonly tracked = computed(() => trackedByIssue(this.entries()));
  private readonly activityAt = computed(() =>
    activityLookup({
      events: this.store.eventsBySubject(),
      artifacts: this.store.artifactsByIssue(),
      entries: this.entries(),
      now: this.now(),
    }),
  );

  // ── 1. finished and created
  private readonly ranges = computed(() => periodRanges(this.period(), this.now()));
  protected readonly finished = computed(() => ({
    cur: completedSummary(this.issues(), this.ranges().cur),
    prev: completedSummary(this.issues(), this.ranges().prev),
  }));
  private readonly prevLabel = computed(() => PERIODS.find((p) => p.id === this.period())?.prev ?? '');
  protected readonly finishedDelta = computed(() => {
    const f = this.finished();
    return pctDelta(f.cur.count, f.prev.count, 'up', `vs ${this.prevLabel()}`);
  });
  protected readonly createdNow = computed(() => createdIn(this.issues(), this.ranges().cur));
  protected readonly createdDelta = computed(() =>
    pctDelta(this.createdNow(), createdIn(this.issues(), this.ranges().prev), null, `vs ${this.prevLabel()}`),
  );
  protected readonly createdHint = computed(() => {
    const gap = this.createdNow() - this.finished().cur.count;
    if (gap === 0) return `${this.periodLong()} · as many completed`;
    return `${this.periodLong()} · ${Math.abs(gap)} ${gap > 0 ? 'more than completed' : 'fewer than completed'}`;
  });
  protected readonly showPoints = computed(() => this.scale() !== 'none' || this.finished().cur.points > 0);
  protected readonly pointsHint = computed(() => {
    const n = this.finished().cur.unestimated;
    return n ? `${n} completed ${n === 1 ? 'task has' : 'tasks have'} no estimate` : 'Estimates of completed tasks';
  });
  protected readonly finishHint = computed(() => {
    const n = this.finished().cur.finishSample;
    return n ? `median of ${n} completed ${n === 1 ? 'task' : 'tasks'}` : 'no completed task with a start date';
  });

  private readonly weeks = computed(() => weeklyThroughput(this.issues(), this.now(), this.period()));
  protected readonly weeksEmpty = computed(() => this.weeks().every((w) => w.done === 0));
  protected readonly flowEmpty = computed(() => this.weeks().every((w) => w.done === 0 && w.created === 0));
  protected readonly weekLabels = computed(() => this.weeks().map((w) => w.label));
  protected readonly weekTitles = computed(() => this.weeks().map((w) => w.title));
  protected readonly weekNotes = computed(() =>
    this.weeks().map((w) => (w.points ? `${w.points} estimate points` : '')),
  );
  protected readonly doneSeries = computed<ColumnSeries[]>(() => [
    { key: 'done', label: 'Completed', color: ISSUE_COLOR.done, values: this.weeks().map((w) => w.done) },
  ]);
  protected readonly flowSeries = computed<ColumnSeries[]>(() => [
    { key: 'created', label: 'Created', color: 'var(--chart-1)', values: this.weeks().map((w) => w.created) },
    { key: 'done', label: 'Completed', color: ISSUE_COLOR.done, values: this.weeks().map((w) => w.done) },
  ]);

  // ── 2. open work
  protected readonly statusRows = computed<BarRow[]>(() =>
    openByStatus(this.issues(), (s) => this.statusLabel(s)).map((r) => ({
      key: r.key,
      label: r.label,
      value: r.count,
      detail: `${r.label}: ${r.count} ${r.count === 1 ? 'task' : 'tasks'}${r.points ? ` · ${r.points} points` : ''}`,
      color: this.statusColor(r.key),
    })),
  );
  protected readonly openTotal = computed(() => this.statusRows().reduce((n, r) => n + r.value, 0));
  protected readonly projectRows = computed<BarRow[]>(() =>
    openByProject(this.issues(), (id) => this.store.getProject(id)?.name ?? 'Unknown project').map((r) => ({
      key: r.key,
      label: r.label,
      value: r.count,
      detail: `${r.label}: ${r.count} open ${r.count === 1 ? 'task' : 'tasks'}${r.points ? ` · ${r.points} points` : ''}`,
      color: r.key === 'none' ? 'var(--status-draft)' : undefined,
    })),
  );
  protected readonly loadRows = computed<BarRow[]>(() => {
    const now = this.now();
    const idleMs = this.idleDays() * DAY;
    const at = this.activityAt();
    return workload(
      this.store.issues(),
      (id) => this.assignee(id),
      (i) => now - at(i) >= idleMs,
    ).map((r) => ({
      key: r.key,
      label: r.label,
      hint: r.idle ? `${r.idle} idle` : undefined,
      value: r.total,
      detail: `${r.label}: ${r.todo} todo, ${r.inProgress} in progress, ${r.inReview} in review${r.points ? ` · ${r.points} points` : ''}${r.idle ? ` · ${r.idle} idle` : ''}`,
      color: r.key === 'unassigned' ? 'var(--status-draft)' : undefined,
    }));
  });

  // ── 3. in progress
  protected readonly running = computed(() =>
    runningRows(this.issues(), this.now(), this.idleDays(), this.activityAt(), this.tracked()),
  );
  protected readonly idleCount = computed(() => this.running().filter((r) => r.idle).length);
  protected readonly shownCount = computed(() => (this.showAllRunning() ? this.running().length : RUNNING_SHOWN));
  protected readonly shownRunning = computed(() => this.running().slice(0, this.shownCount()));

  // ── 4. estimates vs my tracked time
  /** The entries the API returns are the signed-in person's own: this is "my" tracked time. */
  protected readonly trackedNow = computed(() => trackedIn(this.entries(), this.ranges().cur, this.store.me()?.id ?? null));
  protected readonly timersNote = computed(() => {
    const n = runningTimers(this.entries());
    return n ? ` (${n} timer running, not counted until it stops)` : '';
  });
  /** My tasks: assigned to me, or any task I tracked time on. */
  private readonly myIssues = computed(() => {
    const me = this.store.me()?.id;
    const tracked = this.tracked();
    return this.store.issues().filter((i) => i.assigneeId === me || tracked.has(i.id));
  });
  protected readonly accuracy = computed(() => estimateAccuracy(this.myIssues(), this.tracked()));
  protected readonly coverage = computed(() => estimateCoverage(this.myIssues(), this.tracked()));
  protected readonly estimateRows = computed<BarRow[]>(() =>
    this.accuracy().rows.map((r) => ({
      key: String(r.estimate),
      label: this.points(r.estimate),
      hint: `${r.n} ${r.n === 1 ? 'task' : 'tasks'}`,
      value: r.medianMs,
      valueLabel: this.span(r.medianMs),
      detail: `${this.points(r.estimate)}: median ${this.span(r.medianMs)}, middle half ${this.span(r.p25Ms)} to ${this.span(r.p75Ms)}, ${r.n} finished ${r.n === 1 ? 'task' : 'tasks'}${r.thin ? ` (fewer than ${REF_MIN}: treat with care)` : ''}`,
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
  protected readonly outlierEmpty = computed(() => {
    const a = this.accuracy();
    if (a.consistentPct === undefined) return `Needs ${REF_MIN} finished tasks with an estimate and tracked time.`;
    return a.outliers.length ? undefined : 'Every finished task was within your usual range.';
  });

  // ── helpers
  protected span(ms: number): string {
    return formatSpan(ms);
  }
  protected durationText(days: number): string {
    return formatDuration(days);
  }
  protected points(estimate: number): string {
    const label = formatEstimate(estimate, this.scale());
    return /^[\d.]+$/.test(label) ? `${label} ${label === '1' ? 'point' : 'points'}` : label;
  }
  protected factorText(factor: number): string {
    return factor >= 1 ? `${+factor.toFixed(1)}× longer` : `${+(1 / factor).toFixed(1)}× shorter`;
  }
  protected statusLabel(status: string): string {
    return ISSUE_STATUS_META[status as keyof typeof ISSUE_STATUS_META]?.label ?? status;
  }
  protected statusColor(status: string): string {
    return ISSUE_COLOR[status as keyof typeof ISSUE_COLOR] ?? 'var(--status-draft)';
  }
  protected assignee(id: string | undefined): string {
    return id ? (this.store.getUser(id)?.name ?? 'Unknown') : 'Unassigned';
  }

  protected setPeriod(p: unknown): void {
    if (!PERIODS.some((x) => x.id === p)) return;
    this.navigate({ period: p === '30d' ? null : (p as string) });
  }
  protected setPerson(v: string): void {
    this.navigate({ person: v === 'all' || !v ? null : v });
  }
  protected setIdle(v: string): void {
    this.navigate({ idle: Number(v) === DEFAULT_IDLE_DAYS ? null : v });
  }
  private navigate(params: Record<string, string | null>): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: params,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
