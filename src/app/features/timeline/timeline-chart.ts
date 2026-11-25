import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideChevronRight, LucideDynamicIcon } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { format, startOfDay } from 'date-fns';
import { TramaStore, UiStore, Viewport, isTypingTarget, statusTypeOf } from '../../core';
import type { Issue, Milestone, Project } from '../../core/contracts/domain';
import { StatusIcon } from '../../shared/status';
import { ProjectGlyph } from '../projects/project-glyph';
import { projectStatusView } from '../projects/project-model';
import {
  axisBands,
  buildScale,
  compareSpans,
  dateEndX,
  dateX,
  forecastProject,
  parseDate,
  projectSpan,
  shortDate,
  type AxisBand,
  type ForecastTask,
  type ProjectForecast,
  type SignalKind,
  type TimeScale,
  type Zoom,
} from './timeline-model';

/** Width of the sticky project column. */
const LABEL_WIDTH = 272;
/** Open tasks listed under an expanded project before "+N more". */
const MAX_TASK_ROWS = 10;
/** Closest two milestone date labels may sit, in px. */
const MIN_LABEL_GAP = 52;

const SIGNAL_TONE: Record<SignalKind, string> = {
  on_track: 'var(--tone-green)',
  at_risk: 'var(--tone-amber)',
  off_track: 'var(--tone-red)',
  not_enough_data: 'var(--muted-foreground)',
  no_target: 'var(--muted-foreground)',
  closed: 'var(--muted-foreground)',
};

interface Diamond {
  id: string;
  /** Centre of the diamond in px. */
  x: number;
  done: boolean;
  /** The date label is hidden when it would touch the previous one. */
  showLabel: boolean;
  label: string;
  tip: string;
}

interface ProjectRow {
  kind: 'project';
  id: string;
  project: Project;
  forecast: ProjectForecast;
  tone: string;
  expanded: boolean;
  openCount: number;
  closed: boolean;
  /** "On track · 12/20" style second line. */
  sub: string;
  tip: string;
  statusLabel: string;
  /** `text`: where "done/total" fits inside the bar: in the filled part, after it, or nowhere. */
  bar?: { left: number; width: number; progress: number; text: 'fill' | 'after' | 'none' };
  ghost?: { left: number; width: number };
  /** Projected end when it is before the target: a tick inside the bar. */
  early?: number;
  diamonds: Diamond[];
  dates: string;
}

interface TaskRow {
  kind: 'task';
  id: string;
  issue: Issue;
  left: number;
  width: number;
  tip: string;
}

interface MoreRow {
  kind: 'more';
  id: string;
  project: Project;
  count: number;
}

type Row = ProjectRow | TaskRow | MoreRow;

interface Band extends AxisBand {
  current: boolean;
}

/**
 * The Gantt-style chart: one row per project on a horizontal time axis, a "today" line, milestones as
 * diamonds, a projected end drawn as a dashed ghost bar and a signal (on track / at risk / off track)
 * derived from dates and recent throughput. Rows expand to show the project's open tasks.
 * Phones get a vertical list with the same signal and dates.
 */
@Component({
  selector: 'app-timeline-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon, HlmTooltip, RouterLink, ProjectGlyph, StatusIcon],
  host: { class: 'relative flex min-h-0 flex-1 flex-col' },
  template: `
    @if (isMobile()) {
      <ul class="min-h-0 flex-1 overflow-y-auto pb-4" aria-label="Projects">
        @for (row of projectRows(); track row.id) {
          <li>
            <a
              [routerLink]="['/', slug(), 'projects', row.id]"
              class="focus-visible:ring-ring flex flex-col gap-1 px-4 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset"
            >
              <span class="flex min-w-0 items-center gap-2.5">
                <app-project-glyph [project]="row.project" [size]="16" />
                <span class="min-w-0 flex-1 truncate text-[14px]">{{ row.project.name }}</span>
                <span class="text-muted-foreground shrink-0 text-xs tabular-nums">
                  {{ row.forecast.done }}/{{ row.forecast.total }}
                </span>
              </span>
              <span class="flex items-center gap-2 ps-[26px] text-xs">
                <span class="size-2 shrink-0 rounded-full" [style.background]="row.tone"></span>
                <span [style.color]="row.closed ? null : row.tone" [class.text-muted-foreground]="row.closed">
                  {{ row.forecast.label }}
                </span>
                <span class="text-muted-foreground ms-auto tabular-nums">{{ row.dates }}</span>
              </span>
              @if (!row.closed) {
                <span class="text-muted-foreground ps-[26px] text-xs leading-snug">{{ row.forecast.explanation }}</span>
              }
              @if (row.forecast.total > 0) {
                <span class="bg-foreground/10 mt-0.5 ms-[26px] block h-1 overflow-hidden rounded-full" aria-hidden="true">
                  <span class="bg-foreground/35 block h-full rounded-full" [style.width.%]="percent(row.forecast)"></span>
                </span>
              }
            </a>
          </li>
        }
      </ul>
    } @else {
      <div
        #scroller
        class="min-h-0 flex-1 overflow-auto"
        role="list"
        aria-label="Projects on a timeline"
      >
        <div class="relative" [style.width.px]="totalWidth()" [style.min-width]="'100%'">
          <!-- header: two rows of date labels -->
          <div class="bg-background border-border sticky top-0 z-30 flex border-b">
            <div
              class="bg-background text-muted-foreground sticky left-0 z-40 flex shrink-0 items-end px-4 pb-1.5 text-xs"
              [style.width.px]="labelWidth"
            >
              Projects
              <span class="ms-1.5 tabular-nums">{{ projectRows().length }}</span>
            </div>
            <div class="relative h-[46px]" [style.width.px]="scale().width" aria-hidden="true">
              @for (b of bands().upper; track b.start.getTime()) {
                <span
                  class="absolute top-1 overflow-clip text-xs"
                  [style.left.px]="b.x"
                  [style.width.px]="b.width"
                >
                  <!-- sticky: the label stays readable at the left edge while its period scrolls under the project column -->
                  <span class="text-muted-foreground sticky inline-block ps-1.5 whitespace-nowrap" [style.left.px]="labelWidth">{{ b.label }}</span>
                </span>
              }
              @for (b of bands().lower; track b.start.getTime()) {
                <span
                  class="absolute bottom-1 truncate text-center text-[11px] leading-5 tabular-nums"
                  [class]="b.current ? 'text-primary-text font-medium' : 'text-muted-foreground/80'"
                  [style.left.px]="b.x"
                  [style.width.px]="b.width"
                >{{ b.label }}</span>
              }
            </div>
          </div>

          <div class="relative">
            <!-- grid: faint period lines, quieter weekends, today -->
            <div
              class="pointer-events-none absolute inset-y-0 z-0"
              [style.left.px]="labelWidth"
              [style.width.px]="scale().width"
              aria-hidden="true"
            >
              @for (b of gridBands(); track b.start.getTime()) {
                <span
                  class="absolute inset-y-0"
                  [class]="b.quiet ? 'bg-foreground/[0.025]' : 'bg-border/60 w-px'"
                  [style.left.px]="b.x"
                  [style.width.px]="b.quiet ? b.width : null"
                ></span>
              }
              <span
                class="bg-primary absolute inset-y-0 z-[5] w-px opacity-60"
                [style.left.px]="todayX()"
                data-testid="today-line"
              ></span>
            </div>

            @for (row of rows(); track row.id) {
              @switch (row.kind) {
                @case ('project') {
                  <div
                    role="listitem"
                    class="group relative flex h-12"
                    [attr.data-row-id]="row.id"
                    [style.width.px]="totalWidth()"
                  >
                    <span
                      aria-hidden="true"
                      class="pointer-events-none absolute inset-0 z-20"
                      [class]="highlighted(row.id) ? 'bg-selected' : 'group-hover:bg-hover'"
                    ></span>
                    <div
                      class="bg-background sticky left-0 z-10 flex shrink-0 items-center ps-2 pe-3"
                      [style.width.px]="labelWidth"
                    >
                      <button
                        type="button"
                        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-6 shrink-0 items-center justify-center rounded outline-none focus-visible:ring-1 disabled:opacity-30"
                        [attr.aria-expanded]="row.openCount ? row.expanded : null"
                        [attr.aria-label]="(row.expanded ? 'Hide' : 'Show') + ' open tasks of ' + row.project.name"
                        [disabled]="!row.openCount"
                        (click)="toggle(row.id)"
                      >
                        <svg
                          [lucideIcon]="chevron"
                          [size]="14"
                          class="transition-transform"
                          [class.rotate-90]="row.expanded"
                        ></svg>
                      </button>
                      <a
                        [routerLink]="['/', slug(), 'projects', row.id]"
                        class="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded py-1 pe-1 outline-none focus-visible:ring-1"
                        [attr.aria-label]="row.project.name + ': ' + row.forecast.label + ', ' + row.forecast.done + ' of ' + row.forecast.total + ' tasks done'"
                      >
                        <app-project-glyph [project]="row.project" [size]="16" />
                        <span class="flex min-w-0 flex-1 flex-col">
                          <span class="truncate text-[13px] leading-[18px]">{{ row.project.name }}</span>
                          <span
                            class="flex min-w-0 items-center gap-1.5 text-xs leading-4"
                            [hlmTooltip]="row.tip"
                            position="right"
                          >
                            <span class="size-1.5 shrink-0 rounded-full" [style.background]="row.tone"></span>
                            <span class="text-muted-foreground truncate">{{ row.sub }}</span>
                          </span>
                        </span>
                      </a>
                    </div>
                    <!-- bar -->
                    <div
                      class="relative shrink-0 cursor-default"
                      [style.width.px]="scale().width"
                      (click)="focusRow(row.id)"
                      (dblclick)="open(row.id)"
                    >
                      @if (row.bar; as bar) {
                        <div
                          class="absolute top-[10px] h-[18px] overflow-hidden rounded"
                          [class]="row.closed ? 'bg-foreground/[0.07]' : 'bg-foreground/[0.11]'"
                          [style.left.px]="bar.left"
                          [style.width.px]="bar.width"
                          [hlmTooltip]="row.tip"
                          position="top"
                        >
                          <span
                            class="absolute inset-y-0 start-0 flex items-center justify-end"
                            [class]="row.closed ? 'bg-foreground/15' : 'bg-foreground/25'"
                            [style.width.px]="bar.progress"
                          >
                            @if (bar.text === 'fill') {
                              <span class="text-foreground/80 pe-1.5 text-[11px] tabular-nums">
                                {{ row.forecast.done }}/{{ row.forecast.total }}
                              </span>
                            }
                          </span>
                          @if (bar.text === 'after') {
                            <span
                              class="text-foreground/70 absolute inset-y-0 flex items-center ps-1.5 text-[11px] tabular-nums"
                              [style.left.px]="bar.progress"
                            >{{ row.forecast.done }}/{{ row.forecast.total }}</span>
                          }
                        </div>
                      }
                      @if (row.ghost; as g) {
                        <div
                          class="absolute top-[10px] h-[18px] rounded border border-dashed"
                          [style.left.px]="g.left"
                          [style.width.px]="g.width"
                          [style.border-color]="'color-mix(in srgb, ' + row.tone + ' 65%, transparent)'"
                          [style.background]="'color-mix(in srgb, ' + row.tone + ' 12%, transparent)'"
                          [hlmTooltip]="row.tip"
                          position="top"
                        ></div>
                      }
                      @if (row.early !== undefined) {
                        <span
                          class="absolute top-[7px] h-6 w-0.5 rounded-full"
                          [style.left.px]="row.early"
                          [style.background]="row.tone"
                          [hlmTooltip]="row.tip"
                          position="top"
                        ></span>
                      }
                      @for (m of row.diamonds; track m.id) {
                        <span
                          class="absolute top-[13px] z-[2] size-[11px] -translate-x-1/2 rotate-45 rounded-[2px] border"
                          [class]="m.done ? 'bg-foreground/70 border-foreground/70' : 'bg-background border-foreground/60'"
                          [style.left.px]="m.x"
                          [hlmTooltip]="m.tip"
                          position="top"
                        ></span>
                        @if (m.showLabel) {
                          <span
                            class="text-muted-foreground absolute top-[30px] -translate-x-1/2 text-[10px] leading-3 whitespace-nowrap tabular-nums"
                            [style.left.px]="m.x"
                            aria-hidden="true"
                          >{{ m.label }}</span>
                        }
                      }
                      @if (!row.bar) {
                        <span
                          class="text-muted-foreground absolute top-[15px] ps-2 text-xs whitespace-nowrap"
                          [style.left.px]="todayX()"
                        >No dates set</span>
                      }
                    </div>
                  </div>
                }
                @case ('task') {
                  <div
                    role="listitem"
                    class="group relative flex h-7"
                    [attr.data-row-id]="row.id"
                    [style.width.px]="totalWidth()"
                  >
                    <span
                      aria-hidden="true"
                      class="pointer-events-none absolute inset-0 z-20"
                      [class]="highlighted(row.id) ? 'bg-selected' : 'group-hover:bg-hover'"
                    ></span>
                    <div
                      class="bg-background sticky left-0 z-10 flex shrink-0 items-center ps-10 pe-3"
                      [style.width.px]="labelWidth"
                    >
                      <a
                        [routerLink]="['/', slug(), 'tasks', row.issue.key]"
                        class="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2 rounded py-0.5 outline-none focus-visible:ring-1"
                      >
                        <app-status-icon [status]="row.issue.status" [size]="13" />
                        <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ row.issue.key }}</span>
                        <span class="min-w-0 flex-1 truncate text-xs">{{ row.issue.title }}</span>
                      </a>
                    </div>
                    <div
                      class="relative shrink-0"
                      [style.width.px]="scale().width"
                      (click)="focusRow(row.issue.id)"
                      (dblclick)="openTask(row.issue)"
                    >
                      <span
                        class="bg-foreground/20 absolute top-[10px] h-2 rounded-full"
                        [style.left.px]="row.left"
                        [style.width.px]="row.width"
                        [hlmTooltip]="row.tip"
                        position="top"
                      ></span>
                    </div>
                  </div>
                }
                @case ('more') {
                  <div
                    role="listitem"
                    class="relative flex h-7"
                    [style.width.px]="totalWidth()"
                  >
                    <div
                      class="bg-background sticky left-0 z-10 flex shrink-0 items-center ps-10 pe-3"
                      [style.width.px]="labelWidth"
                    >
                      <a
                        [routerLink]="['/', slug(), 'projects', row.project.id]"
                        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded text-xs outline-none focus-visible:ring-1"
                      >+{{ row.count }} more open {{ row.count === 1 ? 'task' : 'tasks' }}</a>
                    </div>
                  </div>
                }
              }
            }
            <div class="h-6" aria-hidden="true"></div>
          </div>
        </div>
      </div>
    }
  `,
})
export class TimelineChart {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly viewport = inject(Viewport);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  /** Projects to draw (already filtered by the page). */
  readonly projects = input<readonly Project[]>([]);
  readonly zoom = input<Zoom>('month');

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly chevron = LucideChevronRight;
  protected readonly labelWidth = LABEL_WIDTH;
  protected readonly isMobile = this.viewport.isMobile;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  private readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** Today, refreshed when the page is shown; the model takes it as a parameter. */
  private readonly now = signal(new Date());

  /** Everything that does not depend on the zoom: dates, forecast, milestones, open tasks. */
  private readonly entries = computed(() => {
    const now = this.now();
    const issueStatuses = this.store.settings().statuses.issue;
    const projectStatuses = this.store.settings().statuses.project;
    const issuesBy = this.store.issuesByProject();
    const milestonesBy = this.store.milestonesByProject();
    return this.projects()
      .map((project) => {
        const issues = issuesBy.get(project.id) ?? [];
        const type = (i: Issue): string | undefined => statusTypeOf(issueStatuses, i.status);
        const tasks: ForecastTask[] = issues.map((i) => {
          const t = type(i);
          return t === 'done'
            ? { state: 'done', completedAt: i.completedAt ?? i.updatedAt }
            : t === 'canceled'
              ? { state: 'canceled' }
              : { state: 'open' };
        });
        const projectType = statusTypeOf(projectStatuses, project.status);
        const closed = projectType === 'completed' || projectType === 'canceled';
        const forecast = forecastProject({
          now,
          startDate: project.startDate,
          targetDate: project.targetDate,
          createdAt: project.createdAt,
          closed,
          tasks,
        });
        const open = issues
          .filter((i) => type(i) !== 'done' && type(i) !== 'canceled')
          .sort(
            (a, b) =>
              Number(isActive(type(b))) - Number(isActive(type(a))) ||
              a.createdAt.localeCompare(b.createdAt),
          );
        // Canceled tasks are out of every count, so a milestone is done when its other tasks are.
        const canceled = new Set(issues.filter((i) => type(i) === 'canceled'));
        return {
          project,
          closed,
          isDone: (i: Issue) => type(i) === 'done' || canceled.has(i),
          forecast,
          span: projectSpan(project, now),
          milestones: milestonesBy.get(project.id) ?? [],
          issues,
          open,
          statusLabel: projectStatusView(project.status, projectStatuses).label,
        };
      })
      .sort((a, b) => compareSpans(a.span, b.span) || a.project.name.localeCompare(b.project.name));
  });

  protected readonly scale = computed(() => {
    const dates: (Date | undefined)[] = [];
    for (const e of this.entries()) {
      dates.push(e.span?.start, e.span?.end, e.forecast.projectedEnd);
      for (const m of e.milestones) dates.push(parseDate(m.targetDate));
    }
    return buildScale(this.zoom(), dates, this.now(), this.store.weekStartsOn());
  });

  protected readonly totalWidth = computed(() => LABEL_WIDTH + this.scale().width);
  protected readonly todayX = computed(
    () => dateX(this.scale(), startOfDay(this.now())) + this.scale().pxPerDay / 2,
  );

  protected readonly bands = computed(() => {
    const scale = this.scale();
    const today = startOfDay(this.now()).getTime();
    const raw = axisBands(scale, this.store.weekStartsOn());
    const withCurrent = (bands: AxisBand[]): Band[] =>
      bands.map((b, i) => {
        const next = bands[i + 1]?.start.getTime() ?? Number.POSITIVE_INFINITY;
        return { ...b, current: b.start.getTime() <= today && today < next };
      });
    return { upper: raw.upper, lower: withCurrent(raw.lower) };
  });

  /** Period lines and weekend shading behind the rows. */
  protected readonly gridBands = computed(() => {
    const { lower } = this.bands();
    const zoom = this.zoom();
    if (zoom === 'week') {
      // One line per week start, shading for weekend days.
      const weekStart = this.store.weekStartsOn();
      return lower.filter((b) => b.quiet || b.start.getDay() === weekStart);
    }
    return lower;
  });

  protected readonly rows = computed<Row[]>(() => {
    const scale = this.scale();
    const now = this.now();
    const today = startOfDay(now);
    const out: Row[] = [];
    for (const e of this.entries()) {
      const { project, forecast, span } = e;
      const tone = SIGNAL_TONE[forecast.signal];
      const expanded = this.expanded().has(project.id) && e.open.length > 0;
      const row: ProjectRow = {
        kind: 'project',
        id: project.id,
        project,
        forecast,
        tone,
        expanded,
        openCount: e.open.length,
        closed: e.closed,
        sub: subline(e.closed, e.statusLabel, forecast),
        tip: tooltip(project, forecast, span, now, e.statusLabel),
        statusLabel: e.statusLabel,
        diamonds: [],
        dates: datesText(project, now),
      };
      if (span) {
        const left = dateX(scale, span.start);
        const width = Math.max(dateEndX(scale, span.end) - left, 6);
        const done = forecast.total ? forecast.done / forecast.total : 0;
        const progress = Math.round(width * done);
        row.bar = {
          left,
          width,
          progress,
          text:
            forecast.total === 0
              ? 'none'
              : progress >= 40
                ? 'fill'
                : width - progress >= 44
                  ? 'after'
                  : 'none',
        };
        const projected = forecast.projectedEnd;
        const barEnd = left + width;
        if (!e.closed && projected) {
          const projectedX = dateEndX(scale, projected);
          if (projectedX > barEnd + 2) row.ghost = { left: barEnd, width: projectedX - barEnd };
          else if (forecast.daysToFinish) row.early = Math.max(left, projectedX - 1);
        } else if (!e.closed && forecast.signal === 'off_track' && today > span.end) {
          // Target passed with no pace to project from: show the overrun up to today.
          const todayEnd = dateEndX(scale, today);
          if (todayEnd > barEnd + 2) row.ghost = { left: barEnd, width: todayEnd - barEnd };
        }
      }
      row.diamonds = diamonds(e.milestones, e.issues, scale, e.isDone);
      if (row.bar && row.bar.text !== 'none') {
        // Keep the "done/total" text clear of milestone diamonds.
        const textStart = row.bar.left + row.bar.progress - (row.bar.text === 'fill' ? 44 : -4);
        const textEnd = textStart + 44;
        if (row.diamonds.some((d) => d.x + 8 > textStart && d.x - 8 < textEnd)) row.bar.text = 'none';
      }
      out.push(row);
      if (expanded) {
        for (const issue of e.open.slice(0, MAX_TASK_ROWS)) {
          const start = startOfDay(parseDate(issue.startedAt ?? issue.createdAt) ?? today);
          const from = start > today ? today : start;
          const left = dateX(scale, from);
          out.push({
            kind: 'task',
            id: issue.id,
            issue,
            left,
            width: Math.max(dateEndX(scale, today) - left, 6),
            tip: `${issue.key} ${issue.title}. ${issue.startedAt ? 'Started' : 'Created'} ${shortDate(from, now)}, still open.`,
          });
        }
        if (e.open.length > MAX_TASK_ROWS) {
          out.push({ kind: 'more', id: `${project.id}:more`, project, count: e.open.length - MAX_TASK_ROWS });
        }
      }
    }
    return out;
  });

  protected readonly projectRows = computed(() =>
    this.rows().filter((r): r is ProjectRow => r.kind === 'project'),
  );

  /** How many projects are in each signal, for the page's status bar. */
  readonly summary = computed(() => {
    const counts: Record<SignalKind, number> = {
      on_track: 0,
      at_risk: 0,
      off_track: 0,
      not_enough_data: 0,
      no_target: 0,
      closed: 0,
    };
    for (const r of this.projectRows()) counts[r.forecast.signal]++;
    return counts;
  });

  constructor() {
    // Arrow keys and j/k are handled by the shell over `[data-row-id]`.
    // Left / right fold and unfold the focused project.
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTypingTarget(e.target)) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const id = this.ui.focusedRowId();
      const row = this.projectRows().find((r) => r.id === id);
      if (!row || !row.openCount || row.expanded === (e.key === 'ArrowRight')) return;
      e.preventDefault();
      this.toggle(row.id);
    };
    this.document.addEventListener('keydown', onKey);
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('keydown', onKey));

    // Start (and after a zoom change) with today in view.
    let last: string | undefined;
    effect(() => {
      const key = `${this.zoom()}:${this.projects().length > 0}:${this.isMobile()}`;
      if (key === last) return;
      last = key;
      untracked(() => afterNextRender(() => this.scrollToToday(false), { injector: this.injector }));
    });
  }

  /** Bring today to the left third of the chart. */
  scrollToToday(smooth = true): void {
    this.now.set(new Date());
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const left = Math.max(0, this.todayX() - 140);
    el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
  }

  protected percent(f: ProjectForecast): number {
    return f.total ? Math.round((f.done / f.total) * 100) : 0;
  }

  protected toggle(id: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected highlighted(id: string): boolean {
    return this.ui.focusedRowId() === id;
  }

  /** A single click on a bar's track focuses its row; a double click (below) opens the page. */
  protected focusRow(id: string): void {
    this.ui.setFocusedRow(id);
  }

  protected open(id: string): void {
    void this.router.navigate(['/', this.slug(), 'projects', id]);
  }

  protected openTask(issue: Issue): void {
    void this.router.navigate(['/', this.slug(), 'tasks', issue.key]);
  }
}

const isActive = (type: string | undefined): boolean => type === 'in_progress' || type === 'in_review';

function subline(closed: boolean, statusLabel: string, f: ProjectForecast): string {
  const progress = f.total ? ` · ${f.done}/${f.total}` : '';
  return `${closed ? statusLabel : f.label}${progress}`;
}

function datesText(p: Project, now: Date): string {
  const start = parseDate(p.startDate);
  const target = parseDate(p.targetDate);
  if (start && target) return `${shortDate(start, now)} → ${shortDate(target, now)}`;
  if (target) return `Target ${shortDate(target, now)}`;
  if (start) return `Starts ${shortDate(start, now)}`;
  return 'No dates';
}

function tooltip(
  p: Project,
  f: ProjectForecast,
  span: { start: Date; end: Date } | undefined,
  now: Date,
  statusLabel: string,
): string {
  const dates = span ? datesText(p, now) : 'No dates set';
  const progress = f.total ? `${f.done} of ${f.total} tasks done. ` : '';
  const verdict = f.signal === 'closed' ? `${statusLabel}.` : f.explanation;
  return `${p.name} · ${dates}. ${progress}${verdict}`;
}

function diamonds(
  milestones: readonly Milestone[],
  issues: readonly Issue[],
  scale: TimeScale,
  isDone: (i: Issue) => boolean,
): Diamond[] {
  const dated = milestones
    .map((m) => ({ m, date: parseDate(m.targetDate) }))
    .filter((x): x is { m: Milestone; date: Date } => !!x.date)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  let lastLabel = Number.NEGATIVE_INFINITY;
  return dated.map(({ m, date }) => {
    const x = dateX(scale, startOfDay(date)) + scale.pxPerDay / 2;
    const own = issues.filter((i) => i.milestoneIds?.includes(m.id));
    const done = own.length > 0 && own.every(isDone);
    const showLabel = x - lastLabel >= MIN_LABEL_GAP;
    if (showLabel) lastLabel = x;
    return {
      id: m.id,
      x,
      done,
      showLabel,
      label: format(date, 'd MMM'),
      tip: `${m.name} · ${format(date, 'd MMM yyyy')} · ${
        own.length ? `${own.filter(isDone).length} of ${own.length} tasks done` : 'no tasks'
      }`,
    };
  });
}
