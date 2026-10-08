import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  ISSUE_STATUS_META,
  ISSUE_STATUSES,
  NablaStore,
  PRIORITIES,
  PRIORITY_META,
  WORKSTREAM_STATUS_FLOW,
  WORKSTREAM_STATUS_META,
} from '../../core';
import { BarList } from './charts/bar-list';
import { ChartCard } from './charts/chart-card';
import type { ChartSlice } from './charts/chart-utils';
import { DonutChart } from './charts/donut-chart';
import { EstimatesView } from './estimates-view';
import { IssueExtras } from './issue-extras';
import { KpiTile } from './charts/kpi-tile';
import { Sparkline } from './charts/sparkline';
import { StackBar } from './charts/stack-bar';
import { TimeChart } from './charts/time-chart';
import { PERIODS, issueInsights, workstreamInsights, type Kpi, type Period, type SeriesBlock } from './insights';
import { filterWork } from './perf';
import { ISSUE_COLOR, PRIORITY_COLOR, WS_COLOR } from './stats-colors';
import type { Distribution, StatsModel } from './stats-model';
import { EMPTY_TIMELINE, type Timeline } from './timeline';
import { EMPTY_WORK } from './work';
import { WsExtras } from './ws-extras';

export type StatsScope = 'issues' | 'workstreams' | 'estimates';
const SCOPES: readonly StatsScope[] = ['issues', 'workstreams', 'estimates'];

const SCOPE_META: Record<StatsScope, { label: string; blurb: string }> = {
  issues: { label: 'Issues', blurb: 'Demand: what comes in, how fast it clears, and what is waiting.' },
  workstreams: { label: 'Workstreams', blurb: 'Outcomes: what gets delivered, how long it takes, and where it stalls.' },
  estimates: { label: 'Estimates & time', blurb: 'How long work really takes, and how well estimates predict it.' },
};

/**
 * Renders a {@link StatsModel}. `strip` is the one-line summary used above a list; `full` is the
 * Insights-style board with a scope toggle (issues = demand, workstreams = outcomes) and a period.
 */
@Component({
  selector: 'app-stats-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, BarList, ChartCard, DonutChart, EstimatesView, IssueExtras, KpiTile, Sparkline, StackBar, TimeChart, WsExtras],
  host: { class: 'block' },
  template: `
    @if (variant() === 'strip') {
      <section class="border-b px-4 py-2.5 sm:px-6" aria-label="Issue summary">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
          @for (c of model().cards; track c.label) {
            <span class="inline-flex items-baseline gap-1 text-xs">
              <span class="text-foreground font-medium tabular-nums">{{ c.value }}</span>
              <span class="text-muted-foreground">{{ c.label }}</span>
            </span>
          }
          @if (stripSpark().length > 1) {
            <span class="text-meta inline-flex items-center gap-2 text-[11px]" title="Open issues over the last 30 days">
              <app-sparkline class="w-20" [values]="stripSpark()" />
              <span>30d</span>
            </span>
          }
          @if (moreLink().length) {
            <a class="text-meta hover:text-foreground ms-auto text-xs" [routerLink]="moreLink()">All statistics</a>
          }
        </div>
        @if (stripSlices().length) {
          <div class="mt-2">
            <app-stack-bar [slices]="stripSlices()" [thickness]="8" />
          </div>
        }
      </section>
    } @else {
      <div class="flex flex-col gap-6">
        @if (scopes().length) {
          <!-- one sticky filter row above everything it scopes -->
          <div class="bg-background/90 sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
            <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
              @if (scopes().length > 1) {
                <div class="inline-flex rounded-md border p-0.5" role="group" aria-label="Scope">
                  @for (s of scopes(); track s) {
                    <button
                      type="button"
                      class="h-6 rounded px-2.5 text-xs transition-colors"
                      [class]="scope() === s ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'"
                      [attr.aria-pressed]="scope() === s"
                      (click)="setScope(s)"
                    >
                      {{ scopeMeta[s].label }}
                    </button>
                  }
                </div>
              }
              <select
                class="border-input bg-background h-7 max-w-40 rounded-md border px-1.5 text-xs"
                aria-label="Person"
                (change)="setPerson($any($event.target).value)"
              >
                <option value="all" [selected]="person() === 'all'">Everyone</option>
                @if (store.me()) {
                  <option value="me" [selected]="person() === 'me'">Me</option>
                }
                @for (m of store.members(); track m.user.id) {
                  <option [value]="m.user.id" [selected]="person() === m.user.id">{{ m.user.name }}</option>
                }
              </select>
              @if (store.teams().length) {
                <select
                  class="border-input bg-background h-7 max-w-40 rounded-md border px-1.5 text-xs"
                  aria-label="Team"
                  (change)="setTeam($any($event.target).value)"
                >
                  <option value="all" [selected]="team() === 'all'">All teams</option>
                  @for (t of store.teams(); track t.id) {
                    <option [value]="t.id" [selected]="team() === t.id">{{ t.name }}</option>
                  }
                </select>
              }
              @if (filtered()) {
                <button type="button" class="text-meta hover:text-foreground text-xs" (click)="clearFilters()">Clear filters</button>
              }
            </div>
            <div class="inline-flex rounded-md border p-0.5" role="group" aria-label="Period">
              @for (p of periods; track p.id) {
                <button
                  type="button"
                  class="h-6 min-w-9 rounded px-2 text-xs tabular-nums transition-colors"
                  [class]="period() === p.id ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'"
                  [attr.aria-pressed]="period() === p.id"
                  [attr.title]="p.long"
                  (click)="setPeriod(p.id)"
                >
                  {{ p.label }}
                </button>
              }
            </div>
          </div>
          @if (scope(); as sc) {
            <p class="text-meta -mt-3 text-xs">{{ scopeMeta[sc].blurb }}</p>
          }
        }

        @if (issueView(); as v) {
          <ng-container *ngTemplateOutlet="kpiRow; context: { $implicit: v.kpis }" />

          <div class="grid gap-4 lg:grid-cols-3">
            <app-chart-card
              class="lg:col-span-2"
              title="Opened vs closed"
              [subtitle]="periodLong()"
              [note]="v.flow.note"
              [empty]="flowEmpty(v.flow) ? 'No issues opened or closed in this period.' : undefined"
            >
              <app-time-chart
                mode="line"
                [series]="v.flow.series"
                [labels]="v.flow.labels"
                [tooltipTitles]="v.flow.titles"
                ariaLabel="Issues opened and closed over time"
              />
            </app-chart-card>

            <app-chart-card title="Status now" subtitle="All issues, current state" [empty]="issueStatus().length ? undefined : 'No issues yet.'">
              <app-donut-chart [slices]="issueStatus()" centerLabel="issues" />
              @if (issuePriority().length) {
                <h4 class="text-muted-foreground mt-5 mb-2 text-xs">By priority</h4>
                <app-stack-bar [slices]="issuePriority()" [legend]="true" />
              }
            </app-chart-card>
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <app-chart-card
              class="lg:col-span-2"
              title="Backlog flow"
              subtitle="Issues by status over time, canceled excluded"
              [note]="v.stock?.note"
              [empty]="v.stock ? undefined : v.stockUnavailable"
            >
              @if (v.stock; as st) {
                <app-time-chart
                  mode="stacked"
                  [series]="st.series"
                  [labels]="st.labels"
                  [tooltipTitles]="st.titles"
                  ariaLabel="Issues by status over time"
                />
              }
            </app-chart-card>

            <app-chart-card title="Open backlog age" subtitle="How long open issues have been waiting" [empty]="ageEmpty(v.age) ? 'No open issues.' : undefined">
              <app-time-chart
                mode="bars"
                [series]="v.age.series"
                [labels]="v.age.labels"
                [tooltipTitles]="v.age.titles"
                [height]="170"
                ariaLabel="Open issues by age"
              />
            </app-chart-card>
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <app-chart-card title="Opened by type" [subtitle]="periodLong()" [empty]="v.openedByKind.length ? undefined : 'No issues opened in this period.'">
              <app-bar-list [rows]="v.openedByKind" ariaLabel="Issues opened by type" />
            </app-chart-card>
            <app-chart-card title="Opened by team" [subtitle]="periodLong()" [empty]="v.openedByTeam.length ? undefined : 'No issues opened in this period.'">
              <app-bar-list [rows]="v.openedByTeam" defaultColor="var(--chart-2)" ariaLabel="Issues opened by team" />
            </app-chart-card>
            <app-chart-card title="Open by assignee" subtitle="Current backlog" [empty]="v.openByAssignee.length ? undefined : 'No open issues.'">
              <app-bar-list [rows]="v.openByAssignee" defaultColor="var(--chart-3)" ariaLabel="Open issues by assignee" />
            </app-chart-card>
          </div>

          <app-issue-extras [work]="filteredWork()" [period]="period()" [now]="nowMs()" [scale]="scale()" />
        }

        @if (wsView(); as v) {
          <ng-container *ngTemplateOutlet="kpiRow; context: { $implicit: v.kpis }" />

          <div class="grid gap-4 lg:grid-cols-3">
            <app-chart-card
              class="lg:col-span-2"
              title="Created vs shipped"
              [subtitle]="periodLong()"
              [empty]="flowEmpty(v.flow) ? 'No workstreams created or shipped in this period.' : undefined"
            >
              <app-time-chart
                mode="line"
                [series]="v.flow.series"
                [labels]="v.flow.labels"
                [tooltipTitles]="v.flow.titles"
                ariaLabel="Workstreams created and shipped over time"
              />
            </app-chart-card>

            <app-chart-card title="Status now" subtitle="All workstreams, current state" [empty]="wsStatus().length ? undefined : 'No workstreams yet.'">
              <app-donut-chart [slices]="wsStatus()" centerLabel="workstreams" />
              @if (wsPriority().length) {
                <h4 class="text-muted-foreground mt-5 mb-2 text-xs">By priority</h4>
                <app-stack-bar [slices]="wsPriority()" [legend]="true" />
              }
            </app-chart-card>
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <app-chart-card
              class="lg:col-span-2"
              title="Active workstreams by status"
              subtitle="Shipped and canceled excluded"
              [note]="v.stock?.note"
              [empty]="v.stock ? undefined : v.stockUnavailable"
            >
              @if (v.stock; as st) {
                <app-time-chart
                  mode="stacked"
                  [series]="st.series"
                  [labels]="st.labels"
                  [tooltipTitles]="st.titles"
                  ariaLabel="Active workstreams by status over time"
                />
              }
            </app-chart-card>

            <app-chart-card
              title="Cycle time"
              subtitle="Planned to shipped, workstreams shipped in this period"
              [note]="v.cycleNote"
              [empty]="v.cycle ? undefined : 'Nothing shipped with a Planned step in this period.'"
            >
              @if (v.cycle; as c) {
                <app-time-chart
                  mode="bars"
                  [series]="c.series"
                  [labels]="c.labels"
                  [tooltipTitles]="c.titles"
                  [height]="170"
                  ariaLabel="Shipped workstreams by cycle time"
                />
              }
            </app-chart-card>
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            <app-chart-card
              title="Time blocked"
              subtitle="Days spent in Blocked, per workstream"
              [note]="v.blockedNote"
              [empty]="v.blocked.length ? undefined : 'No blocked time in this period.'"
            >
              <app-bar-list [rows]="v.blocked" ariaLabel="Blocked time by workstream" />
            </app-chart-card>

            <app-chart-card
              title="Criteria progress"
              subtitle="Acceptance criteria met on active workstreams"
              [empty]="v.criteria.length ? undefined : 'No acceptance criteria on active workstreams.'"
            >
              @if (criteriaSlices().length) {
                <app-stack-bar class="mb-3" [slices]="criteriaSlices()" [legend]="true" />
              }
              <app-bar-list [rows]="v.criteria" [max]="100" ariaLabel="Criteria met per workstream" />
            </app-chart-card>
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            <app-chart-card title="Active by team" subtitle="Current" [empty]="v.activeByTeam.length ? undefined : 'No active workstreams.'">
              <app-bar-list [rows]="v.activeByTeam" ariaLabel="Active workstreams by team" />
            </app-chart-card>
            <app-chart-card title="Shipped by team" [subtitle]="periodLong()" [empty]="v.shippedByTeam.length ? undefined : 'Nothing shipped in this period.'">
              <app-bar-list [rows]="v.shippedByTeam" defaultColor="var(--chart-2)" ariaLabel="Shipped workstreams by team" />
            </app-chart-card>
          </div>

          <app-ws-extras [data]="work()" [wsIds]="wsIds()" [now]="nowMs()" />
        }

        @if (scope() === 'estimates') {
          <app-estimates-view [work]="filteredWork()" [period]="period()" [now]="nowMs()" [scale]="scale()" [periodLong]="periodLong()" />
        }

        @if (showDelivery()) {
          <div class="grid gap-4 lg:grid-cols-3">
            @for (dist of deliveryDists(); track dist.title) {
              <app-chart-card [title]="dist.title" [subtitle]="dist.total + ' total'">
                <app-stack-bar [slices]="slices(dist)" [legend]="true" />
              </app-chart-card>
            }
          </div>
        }

        @if (!scopes().length && !deliveryDists().length) {
          <p class="text-meta rounded-lg border border-dashed py-12 text-center">Nothing to chart yet. Statistics appear once issues or workstreams exist.</p>
        }

        @if (model().cards.length && !filtered() && scope() !== 'estimates') {
          <section aria-label="Snapshot">
            <h2 class="text-muted-foreground mb-2 text-xs font-medium">Snapshot</h2>
            <ul class="grid grid-cols-2 overflow-hidden rounded-lg border sm:grid-cols-4">
              @for (c of model().cards; track c.label) {
                <li class="border-border -mb-px -mr-px border-r border-b px-4 py-3">
                  <div class="text-muted-foreground text-xs">{{ c.label }}</div>
                  <div class="mt-1 text-xl font-semibold tracking-tight">{{ c.value }}</div>
                  @if (c.hint) {
                    <div class="text-meta mt-0.5 truncate text-[11px]">{{ c.hint }}</div>
                  }
                </li>
              }
            </ul>
          </section>
        }
      </div>
    }

    <ng-template #kpiRow let-kpis>
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-3" aria-label="Key figures">
        @for (k of kpis; track k.label) {
          <li class="flex">
            <app-kpi-tile
              class="w-full"
              [label]="k.label"
              [value]="k.value"
              [delta]="k.delta"
              [hint]="k.hint"
              [spark]="k.spark"
              [sparkColor]="k.sparkColor"
            />
          </li>
        }
      </ul>
    </ng-template>
  `,
})
export class StatsBoard {
  readonly model = input.required<StatsModel>();
  readonly variant = input<'full' | 'strip'>('full');
  /** Where "All statistics" goes. Empty hides the link. */
  readonly moreLink = input<readonly string[]>([]);
  /** Limit the scope toggle (e.g. a single workstream only has issue demand). Defaults to what the data has. */
  readonly onlyScopes = input<readonly StatsScope[] | undefined>(undefined, { alias: 'scopes' });
  /** Keep scope, period, person and team in the URL query (the statistics page). */
  readonly syncUrl = input(false);

  protected readonly store = inject(NablaStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });

  protected readonly periods = PERIODS;
  protected readonly scopeMeta = SCOPE_META;
  protected readonly period = signal<Period>('30d');
  protected readonly picked = signal<StatsScope | null>(null);
  /** `all` | `me` | a user id. */
  protected readonly person = signal<string>('all');
  /** `all` | a team id. */
  protected readonly team = signal<string>('all');

  constructor() {
    effect(() => {
      if (!this.syncUrl()) return;
      const q = this.query();
      untracked(() => {
        const scope = q.get('scope');
        const period = q.get('period');
        this.picked.set(SCOPES.includes(scope as StatsScope) ? (scope as StatsScope) : null);
        this.period.set(PERIODS.some((p) => p.id === period) ? (period as Period) : '30d');
        this.person.set(q.get('person') || 'all');
        this.team.set(q.get('team') || 'all');
      });
    });
  }

  private readonly rawTimeline = computed<Timeline>(() => this.model().timeline ?? EMPTY_TIMELINE);
  protected readonly work = computed(() => this.model().work ?? EMPTY_WORK);
  protected readonly nowMs = computed(() => this.rawTimeline().now || Date.now());
  protected readonly scale = computed(() => this.store.estimateScale());

  // ── person and team filters, applied to every scope
  private readonly personId = computed(() => {
    const p = this.person();
    return p === 'all' ? null : p === 'me' ? (this.store.me()?.id ?? null) : p;
  });
  private readonly teamId = computed(() => (this.team() === 'all' ? null : this.team()));
  protected readonly filtered = computed(() => this.personId() !== null || this.teamId() !== null);

  private readonly timeline = computed<Timeline>(() => {
    const tl = this.rawTimeline();
    const p = this.personId();
    const t = this.teamId();
    if (!p && !t) return tl;
    return {
      ...tl,
      issues: tl.issues.filter((i) => (!p || i.assigneeId === p) && (!t || i.teamId === t)),
      workstreams: tl.workstreams.filter((w) => (!p || w.accountableId === p) && (!t || w.teamId === t)),
    };
  });
  protected readonly filteredWork = computed(() => filterWork(this.work().issues, { person: this.personId(), team: this.teamId() }));
  protected readonly wsIds = computed<ReadonlySet<string> | null>(() =>
    this.filtered() ? new Set(this.timeline().workstreams.map((w) => w.id)) : null,
  );

  protected readonly scopes = computed<StatsScope[]>(() => {
    const raw = this.rawTimeline();
    const out: StatsScope[] = [];
    if (raw.issues.length) out.push('issues');
    if (raw.workstreams.length) out.push('workstreams');
    if (this.work().issues.length) out.push('estimates');
    const only = this.onlyScopes();
    return only ? out.filter((s) => only.includes(s)) : out;
  });
  protected readonly scope = computed<StatsScope | null>(() => {
    const pick = this.picked();
    const all = this.scopes();
    return pick && all.includes(pick) ? pick : (all[0] ?? null);
  });

  protected readonly issueView = computed(() =>
    this.variant() === 'full' && this.scope() === 'issues' ? issueInsights(this.timeline(), this.period()) : null,
  );
  protected readonly wsView = computed(() =>
    this.variant() === 'full' && this.scope() === 'workstreams' ? workstreamInsights(this.timeline(), this.period()) : null,
  );

  protected readonly periodLong = computed(() => PERIODS.find((p) => p.id === this.period())?.long ?? '');

  // strip
  protected readonly stripSpark = computed(() =>
    this.variant() === 'strip' && this.rawTimeline().issues.length
      ? (issueInsights(this.rawTimeline(), '30d').kpis.find((k) => k.label === 'Open backlog')?.spark ?? [])
      : [],
  );
  protected readonly stripSlices = computed(() => {
    const d = this.model().distributions[0];
    return d ? this.slices(d) : [];
  });

  // composition: the model's distributions, or counted from the filtered records when a filter is on
  protected readonly issueStatus = computed<ChartSlice[]>(() =>
    this.filtered()
      ? ISSUE_STATUSES.map((s) => ({ key: s, label: ISSUE_STATUS_META[s].label, value: this.timeline().issues.filter((i) => i.status === s).length, color: ISSUE_COLOR[s] })).filter((x) => x.value > 0)
      : this.slicesOf('Issue status'),
  );
  protected readonly issuePriority = computed<ChartSlice[]>(() =>
    this.filtered()
      ? PRIORITIES.map((p) => ({ key: p, label: PRIORITY_META[p].label, value: this.timeline().issues.filter((i) => i.priority === p).length, color: PRIORITY_COLOR[p] })).filter((x) => x.value > 0)
      : this.slicesOf('Issue priority'),
  );
  protected readonly wsStatus = computed<ChartSlice[]>(() =>
    this.filtered()
      ? WORKSTREAM_STATUS_FLOW.map((st) => ({ key: st, label: WORKSTREAM_STATUS_META[st].label, value: this.timeline().workstreams.filter((w) => w.status === st).length, color: WS_COLOR[st] })).filter((x) => x.value > 0)
      : this.slicesOf('Workstream status'),
  );
  protected readonly wsPriority = computed<ChartSlice[]>(() =>
    this.filtered()
      ? PRIORITIES.map((p) => ({ key: p, label: PRIORITY_META[p].label, value: this.timeline().workstreams.filter((w) => w.priority === p).length, color: PRIORITY_COLOR[p] })).filter((x) => x.value > 0)
      : this.slicesOf('Workstream priority'),
  );
  protected readonly criteriaSlices = computed(() => this.slicesOf('Acceptance criteria'));

  protected readonly deliveryDists = computed(() =>
    this.filtered()
      ? []
      : this.model().distributions.filter((d) => d.title === 'Artifacts' || d.title === 'Decisions' || (d.title === 'Acceptance criteria' && !this.scopes().includes('workstreams'))),
  );
  /** Artifacts & decisions belong to delivery: show them with workstreams, or when there is no workstream scope. */
  protected readonly showDelivery = computed(
    () => this.variant() === 'full' && this.deliveryDists().length > 0 && (this.scope() === 'workstreams' || !this.scopes().includes('workstreams')),
  );

  protected setScope(s: StatsScope): void {
    this.picked.set(s);
    this.sync({ scope: s });
  }
  protected setPeriod(p: Period): void {
    this.period.set(p);
    this.sync({ period: p === '30d' ? null : p });
  }
  protected setPerson(v: string): void {
    this.person.set(v);
    this.sync({ person: v === 'all' ? null : v });
  }
  protected setTeam(v: string): void {
    this.team.set(v);
    this.sync({ team: v === 'all' ? null : v });
  }
  protected clearFilters(): void {
    this.person.set('all');
    this.team.set('all');
    this.sync({ person: null, team: null });
  }

  private sync(params: Record<string, string | null>): void {
    if (!this.syncUrl()) return;
    void this.router.navigate([], { relativeTo: this.route, queryParams: params, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected slices(dist: Distribution): ChartSlice[] {
    return dist.rows.map((r) => ({ key: r.label, label: r.label, value: r.count, color: r.color }));
  }

  private slicesOf(title: string): ChartSlice[] {
    const d = this.model().distributions.find((x) => x.title === title);
    return d ? this.slices(d) : [];
  }

  protected flowEmpty(block: SeriesBlock): boolean {
    return block.series.every((s) => s.values.every((v) => !v));
  }

  protected ageEmpty(block: SeriesBlock): boolean {
    return block.series.every((s) => s.values.every((v) => !v));
  }
}

export type { Kpi };
