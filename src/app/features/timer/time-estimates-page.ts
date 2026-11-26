import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChevronDown, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { addDays, format } from 'date-fns';
import { ESTIMATE_SCALE_DEFS } from '../../core/estimates';
import { SessionStore } from '../../core/session/session.store';
import { TimeEntriesStore } from '../../core/stores/time-entries.store';
import { TramaStore } from '../../core/stores/trama.store';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import {
  WEEK_START_DAY,
  doneSamples,
  hoursAxis,
  hoursMinutes,
  hoursShort,
  inBand,
  jitter,
  mondayOf,
  segments,
  summarize,
  trackedByTask,
  valueRows,
  type ValueRow,
} from './time-model';
import { TimeTabs } from './time-nav';

const DAY_MS = 86_400_000;

const RANGES: readonly { days: number; label: string }[] = [
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 180, label: 'Last 180 days' },
  { days: 365, label: 'Last year' },
];

interface PlannedRow {
  key: string;
  title: string;
  points: number | null;
  done: boolean;
}

interface CurveRow {
  key: string;
  points: number;
  ms: number;
  text: string;
  above: boolean;
  done: boolean;
}

const OPEN = new Set(['in_progress', 'in_review']);

/**
 * `/:workspace/timer/estimates` (v3 "28 · Time · Estimates"): what each estimate value really took.
 *
 *   tiles    done tasks inside their learned range, drift from the median, points done, open tasks with no value
 *   chart    one row per estimate value; a mark per done task at its tracked hours, the learned range (the middle
 *            80% of the hours) shaded, the median as a line; marks outside the range are amber
 *   rail     this week's points against your usual week, and the tasks that sit off the curve
 *
 * Only your own tracked time exists, so this is your curve (there is no per-person comparison). Done tasks keep
 * their estimate; the gap between estimate and hours is what teaches the curve.
 */
@Component({
  selector: 'app-time-estimates-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmButtonImports, Kbd, PageHeader, TopBarActions, TimeTabs],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header title="Estimates" />

    <ng-template appTopBarActions>
      <app-time-tabs />
      <a hlmBtn variant="outline" [routerLink]="['/', slug(), 'settings', 'workspace']">Scale settings <app-kbd keys="mod+," /></a>
    </ng-template>

    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <div class="flex min-w-0 flex-1 flex-col gap-5 px-4 py-[22px] sm:px-8 lg:overflow-y-auto">
        <!-- filters -->
        <div class="flex flex-wrap items-center gap-2.5">
          <label
            class="bg-delta-line/8 border-delta-line/40 focus-within:outline-ring relative flex cursor-pointer items-center gap-1.5 border px-[9px] py-[3px] font-mono text-[11px] leading-[normal] focus-within:outline-2"
          >
            <span class="text-muted-foreground">Range</span>
            <span class="text-foreground">{{ rangeLabel() }}</span>
            <svg [lucideIcon]="chevron" [size]="11" class="text-faint"></svg>
            <select class="absolute inset-0 size-full cursor-pointer opacity-0" aria-label="Range" (change)="days.set(+$any($event.target).value)">
              @for (r of ranges; track r.days) {
                <option [value]="r.days" [selected]="r.days === days()">{{ r.label }}</option>
              }
            </select>
          </label>
          <label
            class="border-border focus-within:outline-ring relative flex cursor-pointer items-center gap-1.5 border px-[9px] py-[3px] font-mono text-[11px] leading-[normal] focus-within:outline-2"
          >
            <span class="text-muted-foreground">Project</span>
            <span class="text-foreground">{{ projectLabel() }}</span>
            <svg [lucideIcon]="chevron" [size]="11" class="text-faint"></svg>
            <select class="absolute inset-0 size-full cursor-pointer opacity-0" aria-label="Project" (change)="projectId.set($any($event.target).value)">
              <option value="" [selected]="!projectId()">All</option>
              @for (p of store.projects(); track p.id) {
                <option [value]="p.id" [selected]="p.id === projectId()">{{ p.name }}</option>
              }
            </select>
          </label>
          <span class="flex-1"></span>
          <span class="text-faint font-mono text-[10.5px]">{{ scaleName() }} · {{ summary().tasks }} Done tasks with tracked time</span>
        </div>

        <!-- tiles -->
        <div class="border-border grid grid-cols-2 border lg:grid-cols-4">
          <div class="flex min-w-0 flex-col gap-1 px-4 py-3.5">
            <span class="text-faint font-mono text-[10px] leading-[13px]">WITHIN RANGE</span>
            <div class="flex items-end gap-2">
              <span class="font-title text-foreground text-[30px] leading-[normal]">{{ summary().within === null ? '—' : summary().within + '%' }}</span>
              @if (withinDelta(); as d) {
                <span class="font-mono text-[10.5px]" [class]="d > 0 ? 'text-status-done' : 'text-muted-foreground'">
                  {{ d > 0 ? '+' : '' }}{{ d }} vs prev
                </span>
              }
            </div>
            <span class="text-muted-foreground text-[11.5px] leading-[normal]">of tasks landed inside their value's range</span>
          </div>
          <div class="border-border flex min-w-0 flex-col gap-1 border-l px-4 py-3.5">
            <span class="text-faint font-mono text-[10px] leading-[13px]">DRIFT</span>
            <div class="flex items-end gap-2">
              <span class="font-title text-foreground text-[30px] leading-[normal]">{{ driftText() }}</span>
            </div>
            <span class="text-muted-foreground text-[11.5px] leading-[normal]">actual hours {{ (summary().drift ?? 0) < 0 ? 'below' : 'above' }} the median, on average</span>
          </div>
          <div class="border-border flex min-w-0 flex-col gap-1 border-t px-4 py-3.5 max-lg:border-l-0 lg:border-t-0 lg:border-l">
            <span class="text-faint font-mono text-[10px] leading-[13px]">POINTS DONE</span>
            <div class="flex items-end gap-2">
              <span class="font-title text-foreground text-[30px] leading-[normal]">{{ summary().points }}</span>
            </div>
            <span class="text-muted-foreground text-[11.5px] leading-[normal]">in {{ days() }} days · ≈ {{ perWeek() }} pts a week</span>
          </div>
          <div class="border-border flex min-w-0 flex-col gap-1 border-t border-l px-4 py-3.5 lg:border-t-0">
            <span class="text-faint font-mono text-[10px] leading-[13px]">UNESTIMATED</span>
            <div class="flex items-end gap-2">
              <span class="font-title text-foreground text-[30px] leading-[normal]">{{ unestimated() }}</span>
              @if (unestimated()) {
                <span class="text-status-in-progress font-mono text-[10.5px]">needs you</span>
              }
            </div>
            <span class="text-muted-foreground text-[11.5px] leading-[normal]">open tasks with no value yet</span>
          </div>
        </div>

        <!-- the curve -->
        <section class="flex flex-col gap-2.5" aria-label="Actual hours per value">
          <div class="border-border flex flex-wrap items-end gap-x-2.5 gap-y-1 border-b pb-2">
            <h2 class="font-title text-foreground text-[20px] leading-[normal]">Actual hours per value</h2>
            <span class="text-faint pb-0.5 font-mono text-[10.5px]">each mark is a Done task</span>
            <span class="flex-1"></span>
            <span class="text-muted-foreground flex items-center gap-[5px] font-mono text-[10.5px]"><span class="bg-delta-line size-2" aria-hidden="true"></span>task</span>
            <span class="text-muted-foreground flex items-center gap-[5px] font-mono text-[10.5px]" title="The middle 80% of the hours of the done tasks with this value"><span class="bg-delta-line/25 size-2" aria-hidden="true"></span>learned range</span>
            <span class="text-muted-foreground flex items-center gap-[5px] font-mono text-[10.5px]"><span class="bg-status-in-progress size-2" aria-hidden="true"></span>outside range</span>
          </div>
          @for (r of rows(); track r.points) {
            <div class="flex items-center gap-4 py-1.5">
              <span class="flex w-[70px] shrink-0 items-end gap-2">
                <span class="font-title text-foreground text-[22px] leading-[normal]">{{ r.points }}</span>
                <span class="text-faint pb-0.5 font-mono text-[10px]">pts</span>
              </span>
              <div class="relative h-[26px] min-w-0 flex-1">
                <span class="bg-border absolute inset-x-0 top-1/2 h-px"></span>
                @if (r.band; as b) {
                  <span
                    class="bg-delta-line/15 absolute top-1 h-[18px]"
                    [style.left.%]="(b.lo * 100) / axis().topMs"
                    [style.width.%]="((b.hi - b.lo) * 100) / axis().topMs"
                  ></span>
                }
                @for (s of r.samples; track s.issue.id) {
                  <a
                    class="absolute size-1.5 -translate-x-1/2 -translate-y-1/2"
                    [class]="dotInBand(r, s.ms) ? 'bg-delta-line/80' : 'bg-status-in-progress'"
                    [style.left.%]="(s.ms * 100) / axis().topMs"
                    [style.top.px]="dotTop(s.issue.id)"
                    [routerLink]="['/', slug(), 'tasks', s.issue.key]"
                    [title]="s.issue.key + ' · ' + s.issue.title + ' · ' + hoursMinutes(s.ms)"
                    [attr.aria-label]="s.issue.key + ', ' + hoursMinutes(s.ms)"
                  ></a>
                }
                <span class="bg-foreground absolute top-0 h-[26px] w-0.5" [style.left.%]="(r.median * 100) / axis().topMs" title="Median"></span>
              </div>
              <span class="flex w-24 shrink-0 flex-col gap-0.5">
                <span class="text-foreground font-mono text-[12px] leading-[15px]">~{{ hoursShort(r.median) }}</span>
                <span class="text-faint font-mono text-[10px] leading-3">
                  @if (r.band; as b) {
                    {{ rangeText(b.lo, b.hi) }} ·
                  }
                  {{ r.samples.length }}
                </span>
              </span>
            </div>
          } @empty {
            <div class="border-border text-muted-foreground border border-dashed px-5 py-8 text-center text-[13px]">
              @if (timers.state() === 'loading') {
                Loading time entries…
              } @else if (store.settings().estimateScale === 'none') {
                Estimates are turned off for this workspace. Turn a scale on in Scale settings.
              } @else {
                No done task with an estimate and tracked time in this range yet.
              }
            </div>
          }
          @if (rows().length) {
            <div class="flex gap-4" aria-hidden="true">
              <span class="w-[70px] shrink-0"></span>
              <span class="text-faint flex min-w-0 flex-1 justify-between font-mono text-[9.5px]">
                @for (t of axis().ticks; track t) {
                  <span>{{ t }}h</span>
                }
              </span>
              <span class="w-24 shrink-0"></span>
            </div>
          }
        </section>
      </div>

      <!-- this week and the tasks off the curve -->
      <aside
        class="bg-card border-border flex w-full shrink-0 flex-col gap-[22px] border-t p-[22px] lg:w-[360px] lg:overflow-y-auto lg:border-t-0 lg:border-l"
        aria-label="This week"
      >
        <section class="flex flex-col gap-2.5">
          <div class="flex items-end gap-2 font-mono text-[10px] leading-[13px]">
            <h2 class="text-faint">THIS WEEK</h2>
            <span class="flex-1"></span>
            <span class="text-faint">{{ weekLabel() }}</span>
          </div>
          <div class="flex items-end gap-2">
            <span class="font-title text-foreground text-[40px] leading-[normal]">{{ plan().total }}</span>
            <span class="text-muted-foreground font-mono text-[11px]">pts planned</span>
          </div>
          <p class="text-muted-foreground text-[12px] leading-[18px]">
            @if (plan().capacity; as cap) {
              Capacity ≈ {{ cap }} pts, the weekly average of your done tasks over the last {{ days() }} days.
            } @else {
              Capacity appears once you have done tasks with an estimate and tracked time.
            }
          </p>
          @if (plan().total || plan().capacity) {
            <div class="bg-secondary relative flex h-3" role="img" [attr.aria-label]="plan().done + ' done, ' + plan().planned + ' open, ' + plan().over + ' over'">
              <span class="bg-status-done h-3" [style.width.%]="(plan().done * 100) / plan().scale"></span>
              <span class="bg-delta-line/60 h-3" [style.width.%]="(plan().planned * 100) / plan().scale"></span>
              <span class="bg-status-in-progress h-3" [style.width.%]="(plan().over * 100) / plan().scale"></span>
              @if (plan().capacity; as cap) {
                <span class="bg-foreground absolute -top-[3px] h-[18px] w-0.5" [style.left.%]="(cap * 100) / plan().scale" title="Capacity"></span>
              }
            </div>
            <div class="text-muted-foreground flex gap-3 font-mono text-[10.5px]">
              <span class="flex items-center gap-[5px]"><span class="bg-status-done size-2" aria-hidden="true"></span>{{ plan().done }} done</span>
              <span class="flex items-center gap-[5px]"><span class="bg-delta-line/60 size-2" aria-hidden="true"></span>{{ plan().planned }} open</span>
              <span class="flex items-center gap-[5px]"><span class="bg-status-in-progress size-2" aria-hidden="true"></span>{{ plan().over }} over</span>
            </div>
          }
          <div class="flex flex-col">
            @for (t of plan().rows; track t.key) {
              <a
                class="flex min-h-[29px] items-center gap-2 py-[7px] hover:underline hover:underline-offset-4"
                [routerLink]="['/', slug(), 'tasks', t.key]"
              >
                <span class="text-faint shrink-0 font-mono text-[10.5px]">{{ t.key }}</span>
                <span class="min-w-0 truncate text-[12.5px]" [class]="t.done ? 'text-faint' : 'text-foreground'">{{ t.title }}</span>
                <span class="flex-1"></span>
                @if (t.points === null) {
                  <span class="text-status-in-progress font-mono text-[12px]" title="No estimate yet">—</span>
                } @else {
                  <span class="font-mono text-[12px]" [class]="t.done ? 'text-faint' : 'text-foreground'">{{ t.points }}</span>
                }
              </a>
            }
          </div>
        </section>

        <section class="flex flex-col gap-2.5">
          <div class="flex items-end gap-2 font-mono text-[10px] leading-[13px]">
            <h2 class="text-faint">OFF THE CURVE</h2>
            <span class="flex-1"></span>
            <span class="text-faint">re-estimate?</span>
          </div>
          @for (c of curve(); track c.key) {
            <a
              class="bg-background flex flex-col gap-1 px-3 py-2.5"
              [class]="c.above ? 'border-status-in-progress border-l-2' : ''"
              [routerLink]="['/', slug(), 'tasks', c.key]"
            >
              <span class="flex items-center gap-2 font-mono">
                <span class="text-muted-foreground text-[10.5px]">{{ c.key }}</span>
                <span class="text-foreground text-[11px]">est {{ c.points }}</span>
                <span class="flex-1"></span>
                <span class="text-[11px]" [class]="c.above ? 'text-status-in-progress' : 'text-foreground'">{{ hoursMinutes(c.ms) }}</span>
              </span>
              <span class="text-faint text-[11.5px]">{{ c.text }}</span>
            </a>
          } @empty {
            <p class="text-faint text-[12px]">Nothing sits far from its range right now.</p>
          }
          <p class="text-faint font-mono text-[10.5px] leading-4">Done tasks keep their value; the gap teaches the curve.</p>
        </section>
      </aside>
    </div>
  `,
})
export class TimeEstimatesPage {
  protected readonly store = inject(TramaStore);
  protected readonly timers = inject(TimeEntriesStore);
  private readonly session = inject(SessionStore);

  protected readonly ranges = RANGES;
  protected readonly chevron = LucideChevronDown;
  protected readonly hoursMinutes = hoursMinutes;
  protected readonly hoursShort = hoursShort;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly days = signal(90);
  protected readonly projectId = signal('');
  private readonly now = signal(Date.now());

  constructor() {
    usePageCrumbs(() => [{ label: 'Time', link: ['/', this.slug(), 'timer'] }, { label: 'Estimates' }]);
    const tick = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
    void this.timers.load();
  }

  protected readonly rangeLabel = computed(() => RANGES.find((r) => r.days === this.days())?.label ?? '');
  protected readonly projectLabel = computed(
    () => this.store.projects().find((p) => p.id === this.projectId())?.name ?? 'All',
  );
  protected readonly scaleName = computed(() => {
    const scale = this.store.settings().estimateScale;
    return (ESTIMATE_SCALE_DEFS[scale]?.name ?? scale).toLowerCase();
  });

  private readonly segs = computed(() => segments(this.timers.entries(), this.now()));
  private readonly tracked = computed(() => trackedByTask(this.segs()));
  private readonly range = computed(() => ({ from: this.now() - this.days() * DAY_MS, to: this.now() + 1 }));
  private readonly prevRange = computed(() => {
    const r = this.range();
    return { from: r.from - this.days() * DAY_MS, to: r.from };
  });

  protected readonly rows = computed<ValueRow[]>(() =>
    valueRows(doneSamples(this.store.issues(), this.tracked(), this.range(), this.projectId())),
  );
  protected readonly summary = computed(() => summarize(this.rows()));
  private readonly prevSummary = computed(() =>
    summarize(valueRows(doneSamples(this.store.issues(), this.tracked(), this.prevRange(), this.projectId()))),
  );
  /** Learned from every done task, whatever the range: what "off the curve" is measured against. */
  private readonly learned = computed(
    () => new Map(valueRows(doneSamples(this.store.issues(), this.tracked())).map((r) => [r.points, r])),
  );

  protected readonly axis = computed(() => {
    const max = Math.max(0, ...this.rows().flatMap((r) => r.samples.map((s) => s.ms)));
    const a = hoursAxis(max);
    return { ...a, topMs: a.top * 3_600_000 };
  });

  protected readonly withinDelta = computed(() => {
    const now = this.summary().within;
    const before = this.prevSummary().within;
    return now === null || before === null || now === before ? null : now - before;
  });
  protected readonly driftText = computed(() => {
    const d = this.summary().drift;
    if (d === null) return '—';
    const pct = Math.round(d * 100);
    return `${pct > 0 ? '+' : ''}${pct}%`;
  });
  protected readonly perWeek = computed(() => {
    const perWeek = this.summary().points / (this.days() / 7);
    return Number(perWeek.toFixed(1));
  });

  private readonly me = computed(() => this.session.user()?.id ?? null);
  private mine(assigneeId: string | undefined): boolean {
    const me = this.me();
    return !me || assigneeId === me;
  }

  protected readonly unestimated = computed(
    () =>
      this.store
        .issues()
        .filter(
          (i) =>
            i.status !== 'done' &&
            i.status !== 'canceled' &&
            i.status !== 'draft' &&
            (i.estimate ?? 0) <= 0 &&
            this.mine(i.assigneeId) &&
            (!this.projectId() || i.projectId === this.projectId()),
        ).length,
  );

  // ───────────── this week ─────────────

  private readonly weekFrom = computed(() => mondayOf(this.now(), WEEK_START_DAY[this.store.settings().weekStart] ?? 1));
  protected readonly weekLabel = computed(() => `W${format(this.weekFrom(), 'II')}`);

  protected readonly plan = computed(() => {
    const from = this.weekFrom();
    const to = addDays(from, 7).getTime();
    const rows: PlannedRow[] = [];
    let done = 0;
    let open = 0;
    for (const i of this.store.issues()) {
      if (!this.mine(i.assigneeId)) continue;
      const completed = i.status === 'done' ? Date.parse(i.completedAt ?? '') : NaN;
      const doneThisWeek = completed >= from && completed < to;
      const due = Date.parse(i.dueDate ?? '');
      const dueThisWeek = due >= from && due < to;
      const active = OPEN.has(i.status) || (dueThisWeek && i.status !== 'done' && i.status !== 'canceled');
      if (!doneThisWeek && !active) continue;
      const points = (i.estimate ?? 0) > 0 ? i.estimate! : null;
      if (doneThisWeek) done += points ?? 0;
      else open += points ?? 0;
      rows.push({ key: i.key, title: i.title, points, done: doneThisWeek });
    }
    const capacity = this.summary().tasks ? Math.round(this.summary().points / (this.days() / 7)) : 0;
    const total = done + open;
    const over = capacity ? Math.min(open, Math.max(0, total - capacity)) : 0;
    return {
      total,
      done,
      planned: open - over,
      over,
      capacity,
      scale: Math.max(1, total, capacity),
      rows: rows.sort((a, b) => Number(a.done) - Number(b.done)).slice(0, 7),
    };
  });

  // ───────────── off the curve ─────────────

  protected readonly curve = computed<CurveRow[]>(() => {
    const out: (CurveRow & { ratio: number })[] = [];
    for (const [id, ms] of this.tracked()) {
      const issue = this.store.issues().find((i) => i.id === id);
      if (!issue || issue.status === 'canceled' || !this.mine(issue.assigneeId)) continue;
      const points = issue.estimate ?? 0;
      const band = points > 0 ? this.learned().get(points)?.band : null;
      if (!band || band.hi <= 0) continue;
      const ratio = ms / band.hi;
      if (ratio < 0.85) continue;
      const done = issue.status === 'done';
      const above = ms > band.hi;
      out.push({
        key: issue.key,
        points,
        ms,
        above,
        done,
        ratio,
        text: `${above ? 'above' : 'near the top of'} ${this.rangeText(band.lo, band.hi)} · ${done ? 'Done' : 'still open'}`,
      });
    }
    return out.sort((a, b) => b.ratio - a.ratio).slice(0, 3);
  });

  protected rangeText(lo: number, hi: number): string {
    const h = (ms: number): number => Math.round(ms / 3_600_000);
    return `${h(lo)}–${h(hi)}h`;
  }

  protected dotInBand(row: ValueRow, ms: number): boolean {
    return inBand(row, ms);
  }

  /** Vertical spot of a mark inside its 26px track: spread so marks that share an hour stay visible. */
  protected dotTop(id: string): number {
    return 8 + jitter(id) * 10;
  }
}
