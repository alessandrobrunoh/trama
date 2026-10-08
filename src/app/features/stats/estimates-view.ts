import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { NablaStore, type EstimateScale } from '../../core';
import { BarList } from './charts/bar-list';
import { BoxPlot } from './charts/box-plot';
import { ChartCard } from './charts/chart-card';
import { ColumnChart, type ColumnSeries } from './charts/column-chart';
import { dayLabel } from './charts/log-scale';
import { KpiTile } from './charts/kpi-tile';
import { ScatterChart } from './charts/scatter-chart';
import { estimateInsights, type Lookup, type SlowRow } from './perf';
import type { Period } from './insights';
import type { WorkRec } from './work';

type SlowKey = 'ratio' | 'actual' | 'estimate' | 'completed' | 'assignee';

/**
 * "Estimates & time": how long work really takes against what it was estimated at.
 * Everything comes from startedAt / completedAt / estimate; what cannot be computed is counted and
 * said out loud, never guessed.
 */
@Component({
  selector: 'app-estimates-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, BarList, BoxPlot, ChartCard, ColumnChart, KpiTile, ScatterChart],
  host: { class: 'flex flex-col gap-6' },
  template: `
    @if (ins(); as v) {
      <ul class="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-3" aria-label="Key figures">
        @for (k of v.kpis; track k.label) {
          <li class="flex">
            <app-kpi-tile class="w-full" [label]="k.label" [value]="k.value" [delta]="k.delta" [hint]="k.hint" [spark]="k.spark" [sparkColor]="k.sparkColor" />
          </li>
        }
      </ul>

      @if (scale() === 'none') {
        <p class="text-meta rounded-lg border border-dashed px-4 py-3 text-xs">
          Estimates are turned off for this workspace, so only time-based charts are shown. Pick an estimate scale in settings to compare estimates with actual time.
        </p>
      }
      @if (exclusionNote(); as note) {
        <p class="text-meta text-xs" data-testid="exclusions">{{ note }}</p>
      }

      <div class="grid gap-4 lg:grid-cols-2">
        <app-chart-card
          title="Estimate accuracy"
          [subtitle]="'Actual time against estimate · ' + periodLong()"
          [empty]="scatterEmpty()"
          [note]="'Each dot is a finished issue (cycle time = started to done, log scale). The tick is the median per estimate; red dots took more than 2× the median for their estimate. Click a dot to open it.'"
        >
          <app-scatter-chart [points]="v.scatter.points" [columns]="v.scatter.columns" ariaLabel="Actual cycle time against estimate" (pointClick)="open($event)" />
        </app-chart-card>

        <app-chart-card
          title="Cycle time by estimate"
          [subtitle]="'Spread per size · ' + periodLong()"
          [empty]="scatterEmpty()"
          [note]="boxNote()"
        >
          <app-box-plot [boxes]="v.box.boxes" ariaLabel="Cycle time spread by estimate" />
          @if (v.box.overlaps.length) {
            <div class="mt-3 rounded-md border px-3 py-2 text-xs" style="border-color: color-mix(in oklab, var(--tone-amber) 45%, transparent)">
              <p class="font-medium" style="color: var(--tone-amber)">These estimates don't separate well</p>
              <ul class="text-muted-foreground mt-1 list-disc ps-4">
                @for (o of v.box.overlaps; track o) {
                  <li>{{ o }}</li>
                }
              </ul>
            </div>
          }
        </app-chart-card>
      </div>

      <app-chart-card
        title="Took longer than expected"
        subtitle="Finished issues that took more than 2× the median for their estimate"
        [empty]="v.slow.length ? undefined : slowEmpty()"
        [note]="'Compared with the median of all finished issues of the same estimate (needs 3 or more). Issues without an estimate are listed when they are in the slowest 10% of all cycle times.'"
      >
        <div class="-mx-2 overflow-x-auto">
          <table class="w-full min-w-[560px] text-xs">
            <thead>
              <tr class="text-muted-foreground text-start">
                <th class="px-2 py-1.5 text-start font-medium">Issue</th>
                <th class="px-2 py-1.5 text-start font-medium" [attr.aria-sort]="sortAria('estimate')"><button type="button" class="hover:text-foreground" (click)="sortBy('estimate')">Estimate{{ arrow('estimate') }}</button></th>
                <th class="px-2 py-1.5 text-end font-medium" [attr.aria-sort]="sortAria('actual')"><button type="button" class="hover:text-foreground" (click)="sortBy('actual')">Actual{{ arrow('actual') }}</button></th>
                <th class="px-2 py-1.5 text-end font-medium">Typical</th>
                <th class="px-2 py-1.5 text-end font-medium" [attr.aria-sort]="sortAria('ratio')"><button type="button" class="hover:text-foreground" (click)="sortBy('ratio')">Slower by{{ arrow('ratio') }}</button></th>
                <th class="px-2 py-1.5 text-start font-medium" [attr.aria-sort]="sortAria('assignee')"><button type="button" class="hover:text-foreground" (click)="sortBy('assignee')">Assignee{{ arrow('assignee') }}</button></th>
              </tr>
            </thead>
            <tbody>
              @for (r of slowRows(); track r.id) {
                <tr class="hover:bg-hover border-border/60 border-t">
                  <td class="max-w-0 px-2 py-1.5">
                    <a class="flex min-w-0 items-baseline gap-2 hover:underline" [routerLink]="['/', slug(), 'issues', r.key]">
                      <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ r.key }}</span>
                      <span class="truncate">{{ r.title }}</span>
                    </a>
                  </td>
                  <td class="px-2 py-1.5 tabular-nums">{{ r.estimateLabel }}</td>
                  <td class="px-2 py-1.5 text-end tabular-nums">{{ day(r.actual) }}</td>
                  <td class="text-muted-foreground px-2 py-1.5 text-end tabular-nums" [attr.title]="r.basis === 'decile' ? 'Median of all finished issues (no estimate)' : 'Median for this estimate'">{{ day(r.expected) }}</td>
                  <td class="px-2 py-1.5 text-end">
                    <span class="inline-flex rounded px-1.5 py-0.5 font-medium tabular-nums" [class]="ratioClass(r.ratio)">{{ r.ratio.toFixed(1) }}×</span>
                  </td>
                  <td class="text-muted-foreground max-w-32 truncate px-2 py-1.5">{{ r.assignee }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        @if (v.slow.length > slowLimit) {
          <button type="button" class="text-meta hover:text-foreground mt-2 text-xs" (click)="showAllSlow.set(!showAllSlow())">
            {{ showAllSlow() ? 'Show fewer' : 'Show all ' + v.slow.length }}
          </button>
        }
      </app-chart-card>

      <app-chart-card
        title="Currently dragging"
        subtitle="In progress and already past the p75 for their estimate"
        [empty]="v.dragging.length ? undefined : draggingEmpty()"
        note="p75 = the time three quarters of finished issues of the same estimate stayed within."
      >
        <ul class="flex flex-col">
          @for (r of v.dragging; track r.id) {
            <li class="border-border/60 flex items-center gap-3 border-t py-1.5 text-xs first:border-t-0">
              <a class="flex min-w-0 flex-1 items-baseline gap-2 hover:underline" [routerLink]="['/', slug(), 'issues', r.key]">
                <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ r.key }}</span>
                <span class="truncate">{{ r.title }}</span>
              </a>
              <span class="text-muted-foreground hidden shrink-0 sm:inline">{{ r.assignee }}</span>
              <span class="text-muted-foreground shrink-0 tabular-nums">{{ r.estimateLabel }} pts</span>
              <span class="shrink-0 text-end tabular-nums">
                <span class="font-medium">{{ day(r.age) }}</span>
                <span class="text-muted-foreground"> / p75 {{ day(r.p75) }}</span>
              </span>
              <span class="inline-flex shrink-0 rounded px-1.5 py-0.5 font-medium tabular-nums" [class]="ratioClass(r.age / r.p75, 2)">{{ (r.age / r.p75).toFixed(1) }}× p75</span>
            </li>
          }
        </ul>
        @if (v.draggingSkipped && v.dragging.length) {
          <p class="text-meta mt-2 text-[11px]">{{ v.draggingSkipped }} running issue{{ v.draggingSkipped === 1 ? '' : 's' }} could not be checked (no estimate, no start date, or too little history for their size).</p>
        }
      </app-chart-card>

      <div class="grid gap-4 lg:grid-cols-3">
        <app-chart-card
          class="lg:col-span-2"
          title="Velocity"
          [subtitle]="metric() === 'points' ? 'Points completed per week, with a 4-week average' : 'Issues completed per week, with a 4-week average'"
          [note]="velocityNote()"
          [empty]="velocityEmpty() ? 'Nothing completed in these weeks yet.' : undefined"
        >
          <div class="mb-2 inline-flex rounded-md border p-0.5" role="group" aria-label="Velocity unit">
            @for (m of metrics; track m.id) {
              <button
                type="button"
                class="h-6 rounded px-2.5 text-xs transition-colors"
                [class]="metric() === m.id ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'"
                [attr.aria-pressed]="metric() === m.id"
                (click)="metric.set(m.id)"
              >
                {{ m.label }}
              </button>
            }
          </div>
          <app-column-chart
            [series]="velocitySeries()"
            [labels]="v.velocity.labels"
            [tooltipTitles]="v.velocity.titles"
            [notes]="v.velocity.notes"
            [integer]="metric() === 'count'"
            ariaLabel="Completed work per week"
          />
        </app-chart-card>

        <app-chart-card
          title="Unestimated work"
          [subtitle]="'Completed without an estimate · ' + periodLong()"
          [empty]="v.unestimated.total ? undefined : 'Nothing completed in this period.'"
        >
          @if (v.unestimated.nudge; as n) {
            <p class="mb-3 rounded-md border px-3 py-2 text-xs" style="border-color: color-mix(in oklab, var(--tone-amber) 45%, transparent)">{{ n }}</p>
          } @else if (v.unestimated.missing === 0) {
            <p class="text-meta mb-3 text-xs">Every completed issue had an estimate.</p>
          }
          @if (v.unestimated.byTeam.length) {
            <h4 class="text-muted-foreground mb-1 text-xs">By team</h4>
            <app-bar-list [rows]="v.unestimated.byTeam" [max]="100" ariaLabel="Share of completed issues without estimate, by team" />
          }
          @if (v.unestimated.byPerson.length) {
            <h4 class="text-muted-foreground mt-4 mb-1 text-xs">By assignee</h4>
            <app-bar-list [rows]="v.unestimated.byPerson" [max]="100" defaultColor="var(--chart-2)" ariaLabel="Share of completed issues without estimate, by assignee" />
          }
        </app-chart-card>
      </div>

      <app-chart-card
        title="Waiting vs working"
        subtitle="Median days from created to started (waiting) and started to done (working), by week completed"
        [note]="leadNote()"
        [empty]="leadEmpty() ? 'No completed issues with both a creation and a start date in these weeks.' : undefined"
      >
        <app-column-chart
          [series]="leadSeries()"
          [labels]="v.lead.labels"
          [tooltipTitles]="v.lead.titles"
          [notes]="v.lead.notes"
          [stacked]="true"
          [integer]="false"
          [valueFormat]="dayFormat"
          ariaLabel="Median waiting and working time per week"
        />
      </app-chart-card>
    }
  `,
})
export class EstimatesView {
  /** Already filtered by person and team. */
  readonly work = input.required<readonly WorkRec[]>();
  readonly period = input.required<Period>();
  readonly now = input.required<number>();
  readonly scale = input<EstimateScale>('fibonacci');
  readonly periodLong = input('');

  private readonly store = inject(NablaStore);
  private readonly router = inject(Router);
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly dayFormat = dayLabel;
  protected readonly slowLimit = 12;
  protected readonly showAllSlow = signal(false);
  protected readonly metric = signal<'points' | 'count'>('points');
  protected readonly metrics = [
    { id: 'points', label: 'Points' },
    { id: 'count', label: 'Issues' },
  ] as const;
  private readonly sort = signal<{ key: SlowKey; dir: 1 | -1 }>({ key: 'ratio', dir: -1 });

  private readonly look: Lookup = {
    user: (id) => (id ? (this.store.getUser(id)?.name ?? 'Unknown') : 'Unassigned'),
    team: (id) => (id ? (this.store.getTeam(id)?.name ?? 'Unknown team') : 'No team'),
  };

  protected readonly ins = computed(() => estimateInsights(this.work(), this.period(), this.now(), this.scale(), this.look));

  protected readonly slowRows = computed<SlowRow[]>(() => {
    const { key, dir } = this.sort();
    const rows = [...this.ins().slow].sort((a, b) => {
      const c =
        key === 'assignee'
          ? a.assignee.localeCompare(b.assignee)
          : key === 'estimate'
            ? (a.estimate ?? -1) - (b.estimate ?? -1)
            : (a[key] as number) - (b[key] as number);
      return c * dir || b.ratio - a.ratio;
    });
    return this.showAllSlow() ? rows : rows.slice(0, this.slowLimit);
  });

  protected readonly exclusionNote = computed(() => {
    const e = this.ins().excluded;
    if (!e.done) return undefined;
    const parts: string[] = [];
    if (e.noStart) parts.push(`${e.noStart} without a start date`);
    if (e.noEstimate && this.scale() !== 'none') parts.push(`${e.noEstimate} without an estimate (not in the estimate charts)`);
    if (e.thinBuckets) parts.push(`${e.thinBuckets} in estimates with fewer than 3 finished issues (plotted, but not judged slow)`);
    const head = `${e.done} issue${e.done === 1 ? '' : 's'} completed in this period.`;
    return parts.length ? `${head} Left out: ${parts.join('; ')}.` : `${head} All have a start date and an estimate.`;
  });

  protected readonly scatterEmpty = computed(() => {
    const v = this.ins();
    if (this.scale() === 'none') return 'Estimates are turned off in this workspace.';
    if (v.scatter.points.length) return undefined;
    if (v.excluded.done === 0) return 'Nothing completed in this period. Pick a longer period, or finish some issues.';
    if (v.excluded.noEstimate > 0 && v.excluded.noEstimate >= v.excluded.done - v.excluded.noStart)
      return 'Add estimates to issues to see accuracy: none of the issues completed in this period has one.';
    return 'No completed issue has both a start date and an estimate in this period. Move issues through In progress before Done to record when work started.';
  });

  protected readonly boxNote = computed(() => {
    const b = this.ins().box;
    const rho =
      b.rho === undefined
        ? 'Rank correlation needs at least 6 estimated issues and 2 sizes.'
        : `Rank correlation between estimate and time: ρ = ${b.rho.toFixed(2)} (${b.rhoN} issues). Near 1 means bigger estimates really took longer; near 0 means the estimate says little about duration.`;
    return `Box = middle half of issues (p25–p75), line = median, whiskers = fastest and slowest. Log scale. ${rho}`;
  });

  protected readonly slowEmpty = computed(() => {
    const e = this.ins().excluded;
    if (e.done === 0) return 'Nothing completed in this period.';
    if (e.thinBuckets && e.thinBuckets >= e.done - e.noStart - e.noEstimate)
      return 'Not enough history to judge: each estimate needs at least 3 finished issues to have a typical time.';
    return 'No finished issue took more than twice the median for its estimate. Nice.';
  });

  protected readonly draggingEmpty = computed(() => {
    const skipped = this.ins().draggingSkipped;
    return skipped
      ? `Nothing is past its typical time. ${skipped} running issue${skipped === 1 ? ' was' : 's were'} not checked (no estimate, no start date, or too little history for their size).`
      : 'Nothing is running longer than usual.';
  });

  protected readonly velocityEmpty = computed(() => {
    const v = this.ins().velocity;
    return v.count.every((n) => n === 0);
  });

  protected readonly velocitySeries = computed<ColumnSeries[]>(() => {
    const v = this.ins().velocity;
    const pts = this.metric() === 'points';
    return [
      { key: 'done', label: pts ? 'Points completed' : 'Issues completed', color: 'var(--chart-1)', values: pts ? v.points : v.count },
      { key: 'avg', label: '4-week average', color: 'var(--chart-3)', type: 'line', values: pts ? v.avgPoints : v.avgCount },
    ];
  });

  protected readonly velocityNote = computed(() => {
    const v = this.ins().velocity;
    const base = 'Weeks are rolling 7-day windows ending today. The average needs 4 weeks of history.';
    return this.metric() === 'points' && v.unestimated
      ? `${base} ${v.unestimated} completed issue${v.unestimated === 1 ? ' has' : 's have'} no estimate and count as 0 points; switch to Issues to include them.`
      : base;
  });

  protected readonly leadEmpty = computed(() => this.ins().lead.n === 0 && this.ins().lead.wait.every((x) => x === null));

  protected readonly leadSeries = computed<ColumnSeries[]>(() => {
    const l = this.ins().lead;
    return [
      { key: 'wait', label: 'Waiting (created to started)', color: 'var(--chart-3)', values: l.wait },
      { key: 'work', label: 'Working (started to done)', color: 'var(--chart-1)', values: l.work },
    ];
  });

  protected readonly leadNote = computed(() => {
    const l = this.ins().lead;
    if (l.n === 0 || l.medLead === undefined) return 'Medians are per week; stacking two medians approximates the typical lead time.';
    return `This period (${l.n} issues): median wait ${dayLabel(l.medWait ?? 0)}, median work ${dayLabel(l.medWork ?? 0)}, median lead time ${dayLabel(l.medLead)}. Weekly bars stack two medians, so their sum approximates (not equals) the median lead time.`;
  });

  protected day(v: number): string {
    return dayLabel(v);
  }

  protected ratioClass(ratio: number, red = 4): string {
    return ratio >= red ? 'bg-tone-red/15 text-tone-red' : 'bg-tone-amber/15 text-tone-amber';
  }

  protected sortBy(key: SlowKey): void {
    this.sort.update((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'assignee' ? 1 : -1 }));
  }
  protected arrow(key: SlowKey): string {
    const s = this.sort();
    return s.key === key ? (s.dir === 1 ? ' ▲' : ' ▼') : '';
  }
  protected sortAria(key: SlowKey): 'ascending' | 'descending' | 'none' {
    const s = this.sort();
    return s.key === key ? (s.dir === 1 ? 'ascending' : 'descending') : 'none';
  }

  /** A point carries the issue id; the route takes its key. */
  protected open(id: string): void {
    const key = this.work().find((r) => r.id === id)?.key;
    if (key) void this.router.navigate(['/', this.slug(), 'issues', key]);
  }
}
