import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChevronDown, LucideDynamicIcon, LucideTriangleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { format } from 'date-fns';
import { usePageShortcuts } from '../../core/keyboard';
import { TimeEntriesStore } from '../../core/stores/time-entries.store';
import { TramaStore } from '../../core/stores/trama.store';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import {
  HOUR,
  WEEK_START_DAY,
  axisFor,
  doneSamples,
  downloadText,
  hm,
  hoursMinutes,
  hoursShort,
  reportDays,
  segments,
  toCsv,
  trackedByTask,
  valueRows,
  type ReportDay,
  type Seg,
  type Series,
  type ValueRow,
} from './time-model';
import { TimeTabs } from './time-nav';

type Group = 'project' | 'task';

const RANGES: readonly { weeks: number; label: string }[] = [
  { weeks: 1, label: 'This week' },
  { weeks: 2, label: 'Last 2 weeks' },
  { weeks: 4, label: 'Last 4 weeks' },
  { weeks: 8, label: 'Last 8 weeks' },
  { weeks: 12, label: 'Last 12 weeks' },
];

const GROUPS: readonly { id: Group; label: string }[] = [
  { id: 'project', label: 'Project' },
  { id: 'task', label: 'Task' },
];

/** Colours of the task series (and of tasks of no project): the chart slots, then the gray ones. */
const TASK_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
const OTHER_COLOR = 'var(--line)';
const MAX_TASK_SERIES = TASK_COLORS.length;

/** A task with an estimate and what it took, against what its estimate usually takes. */
interface PointsRow {
  key: string;
  title: string;
  points: number;
  actual: number;
  expected: number | null;
  over: boolean;
}

/**
 * `/:workspace/timer/reports` (v3 "24 · Time · Reports"): your tracked time over the last weeks.
 *
 *   filters   the range, and what the bars are split by (project or task)
 *   tiles     tracked, average per week, days with time, tasks worked on
 *   chart     hours per day, stacked by the split; hover a day for the numbers
 *   list      the same split as a ranked list
 *   rail      points vs actual: tasks with an estimate and their time against the hours that estimate usually takes
 *
 * The API returns only the signed-in person's time, so there is no people or billable filter. Expected hours come
 * from the median of your done tasks with the same estimate (see Estimates). Export CSV (⇧E) writes the chart's days.
 */
@Component({
  selector: 'app-time-reports-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmButtonImports, Kbd, PageHeader, TopBarActions, TimeTabs],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header title="Reports" />

    <ng-template appTopBarActions>
      <app-time-tabs />
      <button hlmBtn variant="outline" type="button" (click)="exportCsv()">Export CSV <app-kbd keys="shift+e" /></button>
    </ng-template>

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <div class="flex min-w-0 flex-1 flex-col gap-5 px-4 py-[22px] sm:px-8 lg:overflow-y-auto">
        <!-- filters -->
        <div class="flex flex-wrap items-center gap-2.5">
          <label
            class="bg-delta-line/8 border-delta-line/40 focus-within:outline-ring relative flex cursor-pointer items-center gap-1.5 border px-[9px] py-1 font-mono text-[11px] leading-[13px] focus-within:outline-2"
          >
            <span class="text-muted-foreground">Range</span>
            <span class="text-foreground">{{ rangeLabel() }}</span>
            <svg [lucideIcon]="chevron" [size]="11" class="text-faint"></svg>
            <select
              class="absolute inset-0 size-full cursor-pointer opacity-0"
              aria-label="Range"
              (change)="weeks.set(+$any($event.target).value)"
            >
              @for (r of ranges; track r.weeks) {
                <option [value]="r.weeks" [selected]="r.weeks === weeks()">{{ r.label }}</option>
              }
            </select>
          </label>
          <span class="flex-1"></span>
          <div class="flex items-center" role="group" aria-label="Split by">
            @for (g of groups; track g.id) {
              <button
                type="button"
                class="border-border -ms-px h-[22px] border px-2.5 font-mono text-[11px] first:ms-0"
                [class]="group() === g.id ? 'bg-secondary text-foreground' : 'text-muted-foreground'"
                [attr.aria-pressed]="group() === g.id"
                (click)="group.set(g.id)"
              >
                {{ g.label }}
              </button>
            }
          </div>
        </div>

        <!-- tiles -->
        <div class="border-border grid grid-cols-2 border sm:grid-cols-4">
          @for (k of tiles(); track k.label) {
            <div class="border-border flex min-w-0 flex-col gap-1 px-[18px] py-3.5 not-first:border-l">
              <div class="flex items-end gap-2">
                <span class="font-title text-foreground text-[28px] leading-8">{{ k.value }}</span>
                @if (k.note) {
                  <span class="text-faint pb-1 font-mono text-[10.5px] leading-[13px]">{{ k.note }}</span>
                }
              </div>
              <span class="text-faint font-mono text-[10.5px] leading-[13px]">{{ k.label }}</span>
            </div>
          }
        </div>

        <!-- chart -->
        <section class="flex flex-col gap-3" aria-label="Hours per day">
          <div class="flex flex-wrap items-end gap-x-4 gap-y-1">
            <h2 class="font-title text-foreground text-[20px] leading-[26px]">Hours per day, by {{ group() }}</h2>
            <span class="flex-1"></span>
            @for (s of series(); track s.key) {
              <span class="text-muted-foreground flex items-center gap-1.5 font-mono text-[11px]">
                <span class="size-2.5 shrink-0" [style.background]="s.color" aria-hidden="true"></span>{{ s.label }}
              </span>
            }
          </div>

          @if (days().length && total() > 0) {
            <div class="relative h-[210px] ps-9" (pointerleave)="hover.set(null)">
              @for (t of axis().ticks; track t) {
                <div class="pointer-events-none absolute inset-x-0 flex items-center" [style.bottom.%]="(t * 3_600_000 * 100) / axis().top">
                  <span class="text-faint w-9 shrink-0 font-mono text-[9.5px] leading-3 -translate-y-px">{{ t }}h</span>
                  <span class="h-px flex-1" [class]="t === 0 ? 'bg-line' : 'bg-border'"></span>
                </div>
              }
              <div class="relative flex h-full items-end gap-1.5 ps-1">
                @for (d of days(); track d.day.from; let i = $index) {
                  <div
                    class="flex h-full min-w-0 flex-1 flex-col-reverse items-stretch gap-0.5"
                    (pointerenter)="hover.set(i)"
                    (focusin)="hover.set(i)"
                    tabindex="0"
                    [attr.aria-label]="dayLabel(d)"
                  >
                    @if (d.total > 0) {
                      @for (s of series(); track s.key) {
                        @if (d.parts.get(s.key); as ms) {
                          <span
                            class="block"
                            [class.opacity-55]="d.day.today"
                            [style.height.%]="(ms * 100) / axis().top"
                            [style.background]="s.color"
                          ></span>
                        }
                      }
                    } @else {
                      <span class="bg-border block h-0.5" aria-hidden="true"></span>
                    }
                  </div>
                }
                @if (hover(); as at) {
                  <div
                    class="bg-secondary border-border-strong pointer-events-none absolute top-1 z-10 flex w-[168px] flex-col gap-[5px] border px-[11px] py-[9px] shadow-[0_8px_20px_#00000088]"
                    [style.left.%]="tipLeft()"
                    style="transform: translateX(-50%)"
                    role="tooltip"
                  >
                    <span class="text-foreground font-mono text-[10px] leading-[13px] uppercase">{{ tipTitle() }}</span>
                    @for (s of series(); track s.key) {
                      <span class="flex items-center gap-1.5">
                        <span class="size-2 shrink-0" [style.background]="s.color" aria-hidden="true"></span>
                        <span class="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">{{ s.label }}</span>
                        <span class="text-foreground font-mono text-[11px]">{{ hm(days()[at]?.parts?.get(s.key) ?? 0) }}</span>
                      </span>
                    }
                  </div>
                }
              </div>
            </div>
            <div class="flex ps-10 pt-1" aria-hidden="true">
              @for (w of weekSpans(); track $index) {
                <span class="text-faint font-mono text-[10px] leading-4" [style.flex]="w.count + ' 1 0'">{{ w.label }}</span>
              }
            </div>
            @if (note()) {
              <p class="text-faint font-mono text-[10px]">{{ note() }}</p>
            }
          } @else {
            <div class="border-border text-muted-foreground border border-dashed px-5 py-8 text-center text-[13px]">
              @if (timers.state() === 'loading') {
                Loading time entries…
              } @else {
                No time tracked in this range. Start the timer or log a session on the Timesheet.
              }
            </div>
          }
        </section>

        <!-- ranked list -->
        @if (series().length) {
          <section class="flex flex-col" aria-label="By {{ group() }}">
            <div class="flex items-end gap-2.5 pb-2">
              <h2 class="font-title text-foreground text-[20px] leading-[26px]">By {{ group() }}</h2>
              <span class="text-faint pb-0.5 font-mono text-[10.5px]">{{ rangeLabel().toLowerCase() }}</span>
            </div>
            @for (s of series(); track s.key) {
              <div class="border-border flex min-h-[37px] items-center gap-3 border-t py-2">
                <span class="size-2.5 shrink-0" [style.background]="s.color" aria-hidden="true"></span>
                @if (s.link; as key) {
                  <a
                    class="text-foreground w-[220px] min-w-0 shrink truncate text-[13px] hover:underline hover:underline-offset-4"
                    [routerLink]="['/', slug(), 'tasks', key]"
                    >{{ s.label }}</a
                  >
                } @else {
                  <span class="text-foreground w-[220px] min-w-0 shrink truncate text-[13px]">{{ s.label }}</span>
                }
                <span class="bg-secondary hidden h-1.5 flex-1 sm:block" aria-hidden="true">
                  <span class="bg-foreground block h-1.5" [style.width.%]="(s.ms * 100) / topSeries()"></span>
                </span>
                <span class="text-foreground w-16 shrink-0 text-end font-mono text-[11px]">{{ hours(s.ms) }}</span>
                <span class="text-faint w-[84px] shrink-0 text-end font-mono text-[10.5px]">{{ share(s.ms) }}% of total</span>
              </div>
            }
          </section>
        }
      </div>

      <!-- points vs actual -->
      <aside
        class="bg-card border-border w-full shrink-0 border-t lg:w-[360px] lg:overflow-y-auto lg:border-t-0 lg:border-l"
        aria-label="Points vs actual"
      >
        <div class="flex flex-col gap-1 px-5 pt-[18px] pb-3">
          <h2 class="font-title text-foreground text-[20px] leading-[26px]">Points vs actual</h2>
          <p class="text-faint font-mono text-[10.5px] leading-[13px]">expected hours come from your history</p>
          <div class="flex gap-3.5 pt-1.5 font-mono text-[10.5px]">
            <span class="text-faint flex items-center gap-1.5"><span class="bg-foreground h-1.5 w-3" aria-hidden="true"></span>actual</span>
            <span class="text-faint flex items-center gap-1.5"><span class="bg-line h-1.5 w-3" aria-hidden="true"></span>expected for its points</span>
          </div>
        </div>
        @for (p of points(); track p.key) {
          <div class="border-border flex flex-col gap-1.5 border-t px-5 py-2.5">
            <div class="flex items-center gap-2">
              <a class="text-faint shrink-0 font-mono text-[10px] hover:underline" [routerLink]="['/', slug(), 'tasks', p.key]">{{ p.key }}</a>
              <span class="text-foreground min-w-0 truncate text-[12.5px]">{{ p.title }}</span>
              <span class="flex-1"></span>
              <span class="text-foreground shrink-0 font-mono text-[10.5px]">
                {{ p.points }} · {{ hoursShort(p.actual) }}{{ p.expected ? ' of ~' + hoursShort(p.expected) : '' }}
              </span>
              @if (p.over) {
                <svg [lucideIcon]="warn" [size]="13" class="text-status-in-progress shrink-0" aria-label="Over estimate"></svg>
              }
            </div>
            <div class="relative h-2" aria-hidden="true">
              @if (p.expected) {
                <span class="bg-line absolute inset-y-0 left-0" [style.width.%]="(p.expected * 100) / pointsScale()"></span>
              }
              <span class="bg-foreground absolute top-0.5 left-0 h-1" [style.width.%]="(p.actual * 100) / pointsScale()"></span>
            </div>
          </div>
        } @empty {
          <p class="border-border text-muted-foreground border-t px-5 py-4 text-[13px]">
            No task with an estimate has time tracked in this range.
          </p>
        }
        @if (points().length) {
          <p class="text-faint border-border border-t px-5 py-3 font-mono text-[10px] leading-[15px]">
            @if (hasExpected()) {
              ⚠ over estimate · expected hours are the median of your done tasks with the same points
            } @else {
              Expected hours appear once three done tasks share an estimate and have tracked time.
            }
          </p>
        }
      </aside>
    </div>
  `,
})
export class TimeReportsPage {
  private readonly store = inject(TramaStore);
  protected readonly timers = inject(TimeEntriesStore);

  protected readonly ranges = RANGES;
  protected readonly groups = GROUPS;
  protected readonly chevron = LucideChevronDown;
  protected readonly warn = LucideTriangleAlert;
  protected readonly hm = hm;
  protected readonly hoursShort = hoursShort;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly weeks = signal(4);
  protected readonly group = signal<Group>('project');
  protected readonly hover = signal<number | null>(null);
  private readonly now = signal(Date.now());

  constructor() {
    usePageCrumbs(() => [{ label: 'Time', link: ['/', this.slug(), 'timer'] }, { label: 'Reports' }]);
    const tick = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
    void this.timers.load();
    usePageShortcuts([{ keys: 'shift+e', label: 'Export CSV', run: () => this.exportCsv() }]);
  }

  protected readonly rangeLabel = computed(() => RANGES.find((r) => r.weeks === this.weeks())?.label ?? '');
  private readonly issues = computed(() => new Map(this.store.issues().map((i) => [i.id, i])));
  private readonly projects = computed(() => new Map(this.store.projects().map((p) => [p.id, p])));
  private readonly segs = computed(() => segments(this.timers.entries(), this.now()));
  private readonly startsOn = computed(() => WEEK_START_DAY[this.store.settings().weekStart] ?? 1);

  /** The key a span is split by: its project (its own, else its task's) or its task. */
  private rawKey(s: Seg): string {
    if (this.group() === 'task') return s.issueId ?? 'none';
    return s.projectId ?? (s.issueId ? this.issues().get(s.issueId)?.projectId : undefined) ?? 'none';
  }

  private readonly rawDays = computed(() =>
    reportDays(this.segs(), this.weeks(), this.now(), (s) => this.rawKey(s), this.startsOn()),
  );

  /** Series of the chart, biggest first; tasks beyond the top few are folded into "Other tasks". */
  protected readonly series = computed<(Series & { link?: string })[]>(() => {
    const totals = new Map<string, number>();
    for (const d of this.rawDays()) for (const [k, ms] of d.parts) totals.set(k, (totals.get(k) ?? 0) + ms);
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    if (this.group() === 'project') {
      return ranked.map(([key, ms], i) => {
        const project = this.projects().get(key);
        return {
          key,
          ms,
          label: project?.name ?? 'No project',
          color: project?.color ?? (key === 'none' ? OTHER_COLOR : TASK_COLORS[i % TASK_COLORS.length]),
        };
      });
    }
    const top = ranked.slice(0, MAX_TASK_SERIES);
    const out: (Series & { link?: string })[] = top.map(([key, ms], i) => {
      const issue = this.issues().get(key);
      return {
        key,
        ms,
        label: issue ? `${issue.key} · ${issue.title}` : 'No task',
        color: TASK_COLORS[i],
        link: issue?.key,
      };
    });
    const rest = ranked.slice(MAX_TASK_SERIES).reduce((n, [, ms]) => n + ms, 0);
    if (rest > 0) out.push({ key: 'other', ms: rest, label: 'Other tasks', color: OTHER_COLOR });
    return out;
  });

  /** Days with their time folded into the series above. */
  protected readonly days = computed<ReportDay[]>(() => {
    const shown = new Set(this.series().map((s) => s.key));
    return this.rawDays().map((d) => {
      const parts = new Map<string, number>();
      for (const [k, ms] of d.parts) {
        const key = shown.has(k) ? k : 'other';
        parts.set(key, (parts.get(key) ?? 0) + ms);
      }
      return { ...d, parts };
    });
  });

  protected readonly total = computed(() => this.days().reduce((n, d) => n + d.total, 0));
  protected readonly axis = computed(() => axisFor(Math.max(0, ...this.days().map((d) => d.total))));
  protected readonly topSeries = computed(() => Math.max(1, ...this.series().map((s) => s.ms)));

  protected readonly weekSpans = computed(() => {
    const out: { label: string; count: number }[] = [];
    for (const d of this.days()) {
      if (d.weekLabel) out.push({ label: d.weekLabel, count: 1 });
      else if (out.length) out[out.length - 1].count += 1;
    }
    return out;
  });

  protected readonly tiles = computed(() => {
    const total = this.total();
    const worked = new Set(this.segs().filter((s) => s.issueId && this.inRange(s)).map((s) => s.issueId));
    const active = this.days().filter((d) => d.total > 0).length;
    const past = this.days().filter((d) => !d.day.future).length;
    return [
      { value: hoursMinutes(total), note: '', label: `tracked · ${this.weeks()} ${this.weeks() === 1 ? 'week' : 'weeks'}` },
      { value: hoursMinutes(total / this.weeks()), note: '', label: 'average per week' },
      { value: String(active), note: `of ${past}`, label: 'days with time' },
      { value: String(worked.size), note: '', label: 'tasks worked on' },
    ];
  });

  private inRange(s: Seg): boolean {
    const days = this.days();
    if (!days.length) return false;
    return s.end > days[0].day.from && s.start < days[days.length - 1].day.to;
  }

  protected readonly note = computed(() => {
    const days = this.days();
    const today = days.find((d) => d.day.today);
    if (!today) return '';
    const ahead = days.filter((d) => d.day.future).length;
    const parts = [`Today (${format(today.day.from, 'EEE')}) is partial`];
    if (ahead) parts.push(`${ahead} ${ahead === 1 ? 'day' : 'days'} ahead`);
    return parts.join(' · ');
  });

  protected tipLeft(): number {
    const at = this.hover();
    const n = this.days().length;
    if (at === null || !n) return 0;
    return Math.min(84, Math.max(16, ((at + 0.5) / n) * 100));
  }

  protected tipTitle(): string {
    const at = this.hover();
    const d = at === null ? undefined : this.days()[at];
    return d ? `${format(d.day.from, 'EEE MMM d')} · ${hoursMinutes(d.total)}` : '';
  }

  protected dayLabel(d: ReportDay): string {
    return `${format(d.day.from, 'EEEE, MMM d')}: ${hoursMinutes(d.total)}`;
  }

  protected hours(ms: number): string {
    return hoursMinutes(ms);
  }

  protected share(ms: number): number {
    const total = this.total();
    return total ? Math.round((ms / total) * 100) : 0;
  }

  // ───────────── points vs actual ─────────────

  /** The hours each estimate value usually takes, learned from every done task with tracked time. */
  private readonly learned = computed<Map<number, ValueRow>>(() => {
    const tracked = trackedByTask(this.segs());
    return new Map(valueRows(doneSamples(this.store.issues(), tracked)).map((r) => [r.points, r]));
  });

  protected readonly points = computed<PointsRow[]>(() => {
    const days = this.days();
    if (!days.length) return [];
    const inside = new Set<string>();
    for (const s of this.segs()) if (s.issueId && this.inRange(s)) inside.add(s.issueId);
    const tracked = new Map<string, number>();
    for (const s of this.segs()) {
      if (!s.issueId || !inside.has(s.issueId)) continue;
      tracked.set(s.issueId, (tracked.get(s.issueId) ?? 0) + (s.end - s.start));
    }
    const rows: PointsRow[] = [];
    for (const [id, actual] of tracked) {
      const issue = this.issues().get(id);
      const points = issue?.estimate ?? 0;
      if (!issue || points <= 0) continue;
      const learned = this.learned().get(points);
      const expected = learned && learned.band ? learned.median : null;
      rows.push({
        key: issue.key,
        title: issue.title,
        points,
        actual,
        expected,
        over: expected !== null && actual > expected,
      });
    }
    return rows.sort((a, b) => b.actual - a.actual).slice(0, 8);
  });

  protected readonly pointsScale = computed(() =>
    Math.max(HOUR, ...this.points().map((p) => Math.max(p.actual, p.expected ?? 0))),
  );
  protected readonly hasExpected = computed(() => this.points().some((p) => p.expected !== null));

  protected exportCsv(): void {
    const series = this.series();
    const rows: (string | number)[][] = [['Date', ...series.map((s) => s.label), 'Total hours']];
    for (const d of this.days()) {
      rows.push([
        format(d.day.from, 'yyyy-MM-dd'),
        ...series.map((s) => Number(((d.parts.get(s.key) ?? 0) / HOUR).toFixed(2))),
        Number((d.total / HOUR).toFixed(2)),
      ]);
    }
    downloadText(`time-report-${format(this.now(), 'yyyy-MM-dd')}.csv`, toCsv(rows));
  }
}
