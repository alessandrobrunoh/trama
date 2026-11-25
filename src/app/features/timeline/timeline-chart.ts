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
import {
  LucideChartGantt,
  LucideChevronDown,
  LucideCornerDownRight,
  LucideDynamicIcon,
  LucideLink,
} from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { addDays, format, startOfDay, startOfWeek } from 'date-fns';
import { TramaStore, UiStore, Viewport, isTypingTarget, statusTypeOf } from '../../core';
import { resolveStatusEntry, type Issue, type Milestone, type Project } from '../../core/contracts/domain';
import { usePageShortcuts } from '../../core/keyboard/keyboard-shortcuts.service';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { ProjectGlyph } from '../projects/project-glyph';
import {
  STATUS_TONE,
  buildScale,
  compareSpans,
  dateEndX,
  dateX,
  forecastProject,
  frameBands,
  mix,
  parseDate,
  projectSpan,
  shortDate,
  taskSpan,
  type AxisBand,
  type ForecastTask,
  type ProjectForecast,
  type ProjectSpan,
  type SignalKind,
  type TimeScale,
  type Zoom,
} from './timeline-model';

/** Width of the sticky task column. */
const LABEL_WIDTH = 280;
/** Bars at least this wide carry the task title; narrower ones put it after the bar. */
const TITLE_INSIDE_MIN = 140;
/** Bars at least this wide have room for the thread link inside. */
const LINK_INSIDE_MIN = 100;
/** Bars at least this wide have room for the assignee. */
const AVATAR_MIN = 40;
/** Deepest indent of sub-tasks, in levels. */
const MAX_DEPTH = 3;

export type TimelineGroup = 'milestone' | 'project';

type IssueStatuses = Parameters<typeof resolveStatusEntry>[0];

const SIGNAL_TONE: Record<SignalKind, string> = {
  on_track: 'var(--tone-green)',
  at_risk: 'var(--tone-amber)',
  off_track: 'var(--tone-red)',
  not_enough_data: 'var(--muted-foreground)',
  no_target: 'var(--muted-foreground)',
  closed: 'var(--muted-foreground)',
};

/** A vertical line through a group: where its milestone or project is due, or is projected to end. */
interface Marker {
  kind: 'deadline' | 'projected';
  /** Left edge in px on the axis. */
  x: number;
  tag: string;
  color: string;
}

interface TaskRow {
  id: string;
  issue: Issue;
  depth: number;
  /** Left padding of the task cell, in px. */
  pad: number;
  color: string;
  fill: string;
  bar: {
    left: number;
    width: number;
    title: boolean;
    avatar: boolean;
    link: 'inside' | 'after' | 'none';
  };
  tip: string;
}

interface GroupRow {
  id: string;
  label: string;
  color: string;
  collapsed: boolean;
  /** Forecast verdict of a project group, in its signal colour. */
  verdict?: { text: string; color: string };
  due?: { text: string; x: number };
  markers: Marker[];
  tasks: TaskRow[];
}

interface Entry {
  project: Project;
  closed: boolean;
  forecast: ProjectForecast;
  span: ProjectSpan | undefined;
  milestones: readonly Milestone[];
  statusLabel: string;
}

interface MobileRow {
  id: string;
  project: Project;
  forecast: ProjectForecast;
  tone: string;
  closed: boolean;
  dates: string;
}

interface Item {
  issue: Issue;
  span: ProjectSpan;
}

interface Band extends AxisBand {
  current: boolean;
}

/**
 * The timeline (v3 · 09): tasks as bars on a horizontal time axis, grouped under their milestone (or project) with the
 * group's deadline drawn through it, sub-tasks indented under their parent, a "today" line and quieter weekends.
 * A task is placed from when work started to its due date (see `taskSpan`); tasks with no dates are left out and
 * counted. In project grouping each project also shows where it is heading at the current pace (projected end and
 * on track / at risk / off track signal). Phones get a vertical list of projects with the same signal and dates.
 */
@Component({
  selector: 'app-timeline-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ActorAvatar, EmptyState, HlmTooltip, LucideDynamicIcon, ProjectGlyph, RouterLink],
  host: {
    class: 'relative flex min-h-0 flex-1 flex-col',
    '(window:resize)': 'measure()',
  },
  template: `
    @if (isMobile()) {
      @if (mobileRows().length === 0) {
        <app-empty-state
          class="m-auto"
          [icon]="ganttIcon"
          title="Nothing to plan yet"
          description="Create a project with a start and a target date to see it here."
        />
      } @else {
        <ul class="min-h-0 flex-1 overflow-y-auto pb-4" aria-label="Projects">
          @for (row of mobileRows(); track row.id) {
            <li class="border-border border-b">
              <a
                [routerLink]="['/', slug(), 'projects', row.id]"
                class="focus-visible:ring-ring flex flex-col gap-1 px-4 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset"
              >
                <span class="flex min-w-0 items-center gap-2.5">
                  <app-project-glyph [project]="row.project" [size]="16" />
                  <span class="min-w-0 flex-1 truncate text-[14px]">{{ row.project.name }}</span>
                  <span class="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
                    {{ row.forecast.done }}/{{ row.forecast.total }}
                  </span>
                </span>
                <span class="flex items-center gap-2 ps-[26px] font-mono text-[11px]">
                  <span class="size-[7px] shrink-0" [style.background]="row.tone"></span>
                  <span [style.color]="row.closed ? null : row.tone" [class.text-muted-foreground]="row.closed">
                    {{ row.forecast.label }}
                  </span>
                  <span class="text-faint ms-auto tabular-nums">{{ row.dates }}</span>
                </span>
                @if (!row.closed) {
                  <span class="text-muted-foreground ps-[26px] text-xs leading-snug">{{ row.forecast.explanation }}</span>
                }
                @if (row.forecast.total > 0) {
                  <span class="bg-secondary mt-0.5 ms-[26px] block h-1 overflow-hidden" aria-hidden="true">
                    <span class="bg-status-done block h-full" [style.width.%]="percent(row.forecast)"></span>
                  </span>
                }
              </a>
            </li>
          }
        </ul>
      }
    } @else if (groups().length === 0) {
      <app-empty-state
        class="m-auto"
        [icon]="ganttIcon"
        title="Nothing to plan yet"
        [description]="
          undated() > 0
            ? undated() + ' open ' + (undated() === 1 ? 'task has' : 'tasks have') + ' no dates yet. Give a task a due date, or start it, to see it here.'
            : 'Give a task a due date, or start it, to see it here.'
        "
      />
    } @else {
      <div
        #scroller
        class="min-h-0 flex-1 overflow-auto"
        role="list"
        aria-label="Tasks on a timeline"
        (scroll)="measure()"
      >
        <div class="relative flex min-h-full flex-col" [style.width.px]="totalWidth()" [style.min-width]="'100%'">
          <!-- header: weeks (or months) over days (or weeks) -->
          <div class="bg-background sticky top-0 z-30 shrink-0">
            <div class="border-border flex h-7 border-b">
              <div
                class="bg-background border-border text-faint sticky left-0 z-40 flex shrink-0 items-center border-r px-4 font-mono text-[10px]"
                [style.width.px]="labelWidth"
              >
                TASK
              </div>
              <div class="relative shrink-0" [style.width.px]="scale().width" aria-hidden="true">
                @for (b of bands().upper; track b.start.getTime()) {
                  <span
                    class="border-border absolute inset-y-0 overflow-clip border-r"
                    [style.left.px]="b.x"
                    [style.width.px]="b.width"
                  >
                    <!-- sticky: the label stays readable at the left edge while its period scrolls under the task column -->
                    <span class="sticky inline-flex h-full items-center gap-2 px-2 font-mono whitespace-nowrap" [style.left.px]="labelWidth">
                      <span class="text-foreground text-[10.5px]">{{ b.label }}</span>
                      @if (b.sub) {
                        <span class="text-faint text-[10px]">{{ b.sub }}</span>
                      }
                    </span>
                  </span>
                }
              </div>
            </div>
            <div class="border-border flex h-6 border-b">
              <div
                class="bg-background border-border sticky left-0 z-40 shrink-0 border-r"
                [style.width.px]="labelWidth"
              ></div>
              <div class="relative shrink-0" [style.width.px]="scale().width" aria-hidden="true">
                @for (b of bands().lower; track b.start.getTime()) {
                  <span
                    class="absolute inset-y-0 flex items-center justify-center gap-[3px] font-mono"
                    [class.bg-red]="b.current && daily()"
                    [style.left.px]="b.x"
                    [style.width.px]="b.width"
                  >
                    @if (b.sub) {
                      <span class="text-[9px]" [class]="b.current ? 'text-white/70' : 'text-faint'">{{ b.sub }}</span>
                    }
                    <span
                      class="text-[10px]"
                      [class]="
                        b.current ? (daily() ? 'text-white' : 'text-red') : b.quiet ? 'text-faint' : 'text-muted-foreground'
                      "
                      >{{ b.label }}</span
                    >
                  </span>
                }
              </div>
            </div>
          </div>

          <div class="relative flex-1">
            <!-- weekends -->
            <div
              class="pointer-events-none absolute inset-y-0 z-0"
              [style.left.px]="labelWidth"
              [style.width.px]="scale().width"
              aria-hidden="true"
            >
              @for (b of weekends(); track b.start.getTime()) {
                <span
                  class="bg-foreground/[0.03] absolute inset-y-0"
                  [style.left.px]="b.x"
                  [style.width.px]="b.width"
                ></span>
              }
            </div>
            <!-- today -->
            <span
              class="bg-red pointer-events-none absolute inset-y-0 z-[6] w-px"
              [style.left.px]="labelWidth + todayX()"
              data-testid="today-line"
              aria-hidden="true"
            ></span>

            @for (g of groups(); track g.id) {
              <div role="group" class="relative" [style.width.px]="totalWidth()" [attr.aria-label]="g.label">
                @for (m of g.markers; track m.kind) {
                  <span
                    class="pointer-events-none absolute inset-y-0 z-[5] w-px"
                    [class]="m.kind === 'projected' ? 'border-l border-dashed' : ''"
                    [style.left.px]="labelWidth + m.x"
                    [style.background]="m.kind === 'deadline' ? mixed(m.color, 53) : null"
                    [style.border-color]="m.kind === 'projected' ? mixed(m.color, 70) : null"
                    aria-hidden="true"
                  ></span>
                }

                <!-- group header -->
                <div
                  class="group relative flex h-[34px] cursor-default"
                  [attr.data-row-id]="g.id"
                  (click)="focusRow(g.id)"
                  (dblclick)="toggle(g.id)"
                >
                  <span
                    aria-hidden="true"
                    class="pointer-events-none absolute inset-0 z-20"
                    [class]="highlighted(g.id) ? 'bg-selected' : 'group-hover:bg-hover'"
                  ></span>
                  <div
                    class="bg-card border-border sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-b px-4"
                    [style.width.px]="labelWidth"
                  >
                    <button
                      type="button"
                      class="text-faint hover:text-foreground focus-visible:ring-ring flex size-3 shrink-0 items-center justify-center outline-none focus-visible:ring-1"
                      [attr.aria-expanded]="!g.collapsed"
                      [attr.aria-label]="(g.collapsed ? 'Show' : 'Hide') + ' tasks of ' + g.label"
                      (click)="toggle(g.id); $event.stopPropagation()"
                    >
                      <svg [lucideIcon]="chevron" [size]="12" class="transition-transform" [class.-rotate-90]="g.collapsed"></svg>
                    </button>
                    <span class="size-[9px] shrink-0" [style.background]="g.color" aria-hidden="true"></span>
                    <span class="text-foreground min-w-0 truncate text-[13px] font-semibold">{{ g.label }}</span>
                    <span class="flex-1"></span>
                    @if (g.verdict; as v) {
                      <span class="shrink-0 font-mono text-[10px] whitespace-nowrap" [style.color]="v.color">{{ v.text }}</span>
                    }
                    @if (g.due) {
                      <span class="text-faint shrink-0 font-mono text-[10px] whitespace-nowrap">{{ dueText(g) }}</span>
                    }
                  </div>
                  <div class="bg-card/80 border-border relative shrink-0 border-b" [style.width.px]="scale().width">
                    @for (m of g.markers; track m.kind) {
                      <span
                        class="absolute top-1/2 -translate-y-1/2 px-1.5 py-0.5 font-mono text-[9.5px] leading-[13px] whitespace-nowrap"
                        [style.left.px]="m.x + 5"
                        [style.background]="mixed(m.color, 15)"
                        [style.color]="m.color"
                        >{{ m.tag }}</span
                      >
                    }
                  </div>
                </div>

                @if (!g.collapsed) {
                  @for (row of g.tasks; track row.id) {
                    <div
                      role="listitem"
                      class="group relative flex"
                      [class]="row.depth ? 'h-[30px]' : 'h-10'"
                      [attr.data-row-id]="row.id"
                    >
                      <span
                        aria-hidden="true"
                        class="pointer-events-none absolute inset-0 z-20"
                        [class]="highlighted(row.id) ? 'bg-selected' : 'group-hover:bg-hover'"
                      ></span>
                      <div
                        class="bg-background border-border sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r border-b pe-4"
                        [style.width.px]="labelWidth"
                        [style.padding-left.px]="row.pad"
                      >
                        @if (row.depth) {
                          <svg [lucideIcon]="subIcon" [size]="12" class="text-faint shrink-0"></svg>
                        }
                        <span class="size-[7px] shrink-0" [style.background]="row.color" aria-hidden="true"></span>
                        <a
                          [routerLink]="['/', slug(), 'tasks', row.issue.key]"
                          class="focus-visible:ring-ring min-w-0 flex-1 truncate outline-none focus-visible:ring-1"
                          [class]="row.depth ? 'text-foreground/80 text-xs' : 'text-foreground text-[13px]'"
                          >{{ row.issue.title }}</a
                        >
                        <span class="text-faint shrink-0 font-mono text-[9.5px]">{{ row.issue.key }}</span>
                      </div>
                      <div
                        class="border-border relative shrink-0 border-b"
                        [style.width.px]="scale().width"
                        (click)="focusRow(row.id)"
                        (dblclick)="openTask(row.issue)"
                      >
                        @let vis = visible(row);
                        <div
                          class="absolute flex items-center overflow-hidden border-l-[3px]"
                          [class]="row.depth ? 'top-[9px] h-3' : 'top-2 h-6 gap-1.5 px-2'"
                          [style.padding-left.px]="row.depth ? null : vis.pad + 8"
                          [style.left.px]="row.bar.left"
                          [style.width.px]="row.bar.width"
                          [style.background]="row.fill"
                          [style.border-color]="row.color"
                          [hlmTooltip]="row.tip"
                          position="top"
                        >
                          @if (row.bar.avatar && vis.title) {
                            <app-actor-avatar
                              class="[&_*]:rounded-none!"
                              [actor]="{ type: 'user', id: row.issue.assigneeId }"
                              [size]="16"
                            />
                          }
                          @if (vis.title) {
                            <span class="text-foreground min-w-0 flex-1 truncate text-[11.5px]">{{ row.issue.title }}</span>
                          } @else {
                            <span class="flex-1"></span>
                          }
                          @if (row.bar.link === 'inside') {
                            <svg [lucideIcon]="linkIcon" [size]="12" class="text-delta-line shrink-0"></svg>
                          }
                        </div>
                        @if (row.bar.link === 'after' || (!vis.title && !row.depth)) {
                          <span
                            class="absolute top-0 flex h-full items-center gap-2 whitespace-nowrap"
                            [style.left.px]="row.bar.left + row.bar.width + 7"
                          >
                            @if (row.bar.link === 'after') {
                              <svg [lucideIcon]="linkIcon" [size]="12" class="text-delta-line shrink-0"></svg>
                            }
                            @if (!vis.title && !row.depth) {
                              <span class="text-muted-foreground text-[11.5px]">{{ row.issue.title }}</span>
                            }
                          </span>
                        }
                      </div>
                    </div>
                  }
                }
              </div>
            }
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
  readonly group = input<TimelineGroup>('milestone');
  /** Also draw closed tasks (done, canceled). */
  readonly showClosed = input(false);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  protected readonly chevron = LucideChevronDown;
  protected readonly subIcon = LucideCornerDownRight;
  protected readonly linkIcon = LucideLink;
  protected readonly ganttIcon = LucideChartGantt;
  protected readonly labelWidth = LABEL_WIDTH;
  protected readonly isMobile = this.viewport.isMobile;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  private readonly collapsed = signal<ReadonlySet<string>>(new Set());
  /** Today, refreshed when the page is shown; the model takes it as a parameter. */
  private readonly now = signal(new Date());
  /** The part of the axis in view, in px on the axis. Unmeasured until the chart is on screen. */
  private readonly view = signal({ left: 0, right: Number.POSITIVE_INFINITY });

  /** Projects with their forecast: drives the project groups, the summary and the phone list. */
  private readonly entries = computed<Entry[]>(() => {
    const now = this.now();
    const issueStatuses = this.store.settings().statuses.issue;
    const projectStatuses = this.store.settings().statuses.project;
    const issuesBy = this.store.issuesByProject();
    const milestonesBy = this.store.milestonesByProject();
    return this.projects()
      .map((project) => {
        const issues = issuesBy.get(project.id) ?? [];
        const tasks: ForecastTask[] = issues.map((i) => {
          const t = statusTypeOf(issueStatuses, i.status);
          return t === 'done'
            ? { state: 'done', completedAt: i.completedAt ?? i.updatedAt }
            : t === 'canceled'
              ? { state: 'canceled' }
              : { state: 'open' };
        });
        const projectType = statusTypeOf(projectStatuses, project.status);
        const closed = projectType === 'completed' || projectType === 'canceled';
        return {
          project,
          closed,
          forecast: forecastProject({
            now,
            startDate: project.startDate,
            targetDate: project.targetDate,
            createdAt: project.createdAt,
            closed,
            tasks,
          }),
          span: projectSpan(project, now),
          milestones: milestonesBy.get(project.id) ?? [],
          statusLabel: resolveStatusEntry(projectStatuses, project.status)?.name ?? project.status,
        };
      })
      .sort((a, b) => compareSpans(a.span, b.span) || a.project.name.localeCompare(b.project.name));
  });

  /** Tasks that have a place on the axis, and how many open ones have not. */
  private readonly placed = computed(() => {
    const now = this.now();
    const types = this.store.settings().statuses.issue;
    const inScope = new Set(this.projects().map((p) => p.id));
    const showClosed = this.showClosed();
    const items: Item[] = [];
    let undated = 0;
    for (const issue of this.store.issues()) {
      if (issue.projectId && !inScope.has(issue.projectId)) continue;
      const type = statusTypeOf(types, issue.status);
      const open = type !== 'done' && type !== 'canceled';
      if (!open && !showClosed) continue;
      const span = taskSpan(
        { startedAt: issue.startedAt, dueDate: issue.dueDate, completedAt: issue.completedAt, open },
        now,
      );
      if (span) items.push({ issue, span });
      else undated++;
    }
    return { items, undated };
  });

  /** Open tasks left out because they have no dates. */
  readonly undated = computed(() => this.placed().undated);

  protected readonly scale = computed(() => {
    const dates: (Date | undefined)[] = [];
    for (const { span } of this.placed().items) dates.push(span.start, span.end);
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
  /** Days under the week bands; quarter zoom has weeks under months instead. */
  protected readonly daily = computed(() => this.zoom() !== 'quarter');

  protected readonly bands = computed(() => {
    const scale = this.scale();
    const today = startOfDay(this.now()).getTime();
    const raw = frameBands(scale, this.store.weekStartsOn());
    const lower: Band[] = raw.lower.map((b, i) => {
      const next = raw.lower[i + 1]?.start.getTime() ?? Number.POSITIVE_INFINITY;
      return { ...b, current: b.start.getTime() <= today && today < next };
    });
    return { upper: raw.upper, lower };
  });

  protected readonly weekends = computed(() => this.bands().lower.filter((b) => b.quiet));

  /** The groups with their tasks, in axis order. */
  protected readonly groups = computed<GroupRow[]>(() => {
    const scale = this.scale();
    const now = this.now();
    const byMilestone = this.group() === 'milestone';
    const collapsed = this.collapsed();
    const issueStatuses = this.store.settings().statuses.issue;
    const milestones = new Map<string, Milestone>();
    for (const e of this.entries()) for (const m of e.milestones) milestones.set(m.id, m);
    const entryOf = new Map(this.entries().map((e) => [e.project.id, e]));

    const keyOf = (i: Issue): string =>
      byMilestone ? (i.milestoneIds.find((id) => milestones.has(id)) ?? '') : (i.projectId ?? '');
    const buckets = new Map<string, Item[]>();
    for (const item of this.placed().items) {
      const k = keyOf(item.issue);
      const list = buckets.get(k);
      if (list) list.push(item);
      else buckets.set(k, [item]);
    }

    const dueAt = (date: Date | undefined): { text: string; x: number } | undefined =>
      date ? { text: `due ${shortDay(date, now)}`, x: dateEndX(scale, startOfDay(date)) } : undefined;

    const out: { sort: [number, number, string]; group: GroupRow }[] = [];
    for (const [key, items] of buckets) {
      const id = `g:${key}`;
      const tasks = this.arrange(items, scale, now, issueStatuses);
      const base = { id, collapsed: collapsed.has(id), tasks };
      const m = byMilestone ? milestones.get(key) : undefined;
      const e = byMilestone ? undefined : entryOf.get(key);
      if (m) {
        const target = parseDate(m.targetDate);
        const due = dueAt(target);
        const all = this.store.issuesByMilestone().get(m.id) ?? [];
        const states = all.map((i) => statusTypeOf(issueStatuses, i.status));
        const finished = all.length > 0 && states.every((t) => t === 'done' || t === 'canceled');
        const active = states.some((t) => t === 'in_progress' || t === 'in_review');
        out.push({
          sort: [target ? target.getTime() : Number.POSITIVE_INFINITY, m.sortOrder, m.name],
          group: {
            ...base,
            label: m.name,
            color: finished ? 'var(--status-done)' : active ? 'var(--status-in-progress)' : 'var(--faint)',
            due,
            markers: due
              ? [{ kind: 'deadline', x: due.x, tag: `${shortName(m.name)} ${due.text}`, color: 'var(--status-in-progress)' }]
              : [],
          },
        });
      } else if (e) {
        const target = parseDate(e.project.targetDate);
        const due = dueAt(target);
        const tone = SIGNAL_TONE[e.forecast.signal];
        const markers: Marker[] = due
          ? [{ kind: 'deadline', x: due.x, tag: `target ${shortDay(target!, now)}`, color: 'var(--status-in-progress)' }]
          : [];
        const end = e.forecast.projectedEnd;
        if (end && !e.closed) {
          markers.push({
            kind: 'projected',
            x: dateEndX(scale, startOfDay(end)),
            tag: `ends ~${shortDay(end, now)}`,
            color: tone,
          });
        }
        out.push({
          sort: [e.span ? e.span.start.getTime() : Number.POSITIVE_INFINITY, 0, e.project.name],
          group: {
            ...base,
            label: e.project.name,
            color: e.project.color,
            verdict: {
              text: e.closed ? e.statusLabel : e.forecast.label,
              color: e.closed ? 'var(--muted-foreground)' : tone,
            },
            due,
            markers,
          },
        });
      } else {
        out.push({
          sort: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, '￿'],
          group: {
            ...base,
            label: byMilestone ? 'No milestone' : 'No project',
            color: 'var(--border-strong)',
            markers: [],
          },
        });
      }
    }
    return out
      .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2].localeCompare(b.sort[2]))
      .map((x) => x.group);
  });

  protected readonly mobileRows = computed<MobileRow[]>(() =>
    this.entries().map((e) => ({
      id: e.project.id,
      project: e.project,
      forecast: e.forecast,
      tone: SIGNAL_TONE[e.forecast.signal],
      closed: e.closed,
      dates: datesText(e.project, this.now()),
    })),
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
    for (const e of this.entries()) counts[e.forecast.signal]++;
    return counts;
  });

  /** "Nov 23 – Dec 20": the days in view. */
  readonly rangeLabel = computed(() => {
    const scale = this.scale();
    const { left, right } = this.view();
    const today = startOfDay(this.now());
    const clamp = (n: number): number => Math.min(scale.days - 1, Math.max(0, n));
    const measured = Number.isFinite(right);
    const first = measured ? addDays(scale.origin, clamp(Math.floor(left / scale.pxPerDay))) : today;
    const last = measured
      ? addDays(scale.origin, clamp(Math.floor((right - 1) / scale.pxPerDay)))
      : addDays(today, 27);
    const sameYear = first.getFullYear() === today.getFullYear() && last.getFullYear() === today.getFullYear();
    return `${format(first, 'MMM d')} – ${format(last, sameYear ? 'MMM d' : 'MMM d, yyyy')}`;
  });

  constructor() {
    usePageShortcuts([{ keys: 't', label: 'Jump to today', run: () => this.scrollToToday() }]);

    // Arrow keys and j/k are handled by the shell over `[data-row-id]`. Left / right fold and unfold the focused group.
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTypingTarget(e.target)) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const id = this.ui.focusedRowId();
      const g = this.groups().find((x) => x.id === id);
      if (!g || g.collapsed === (e.key === 'ArrowLeft')) return;
      e.preventDefault();
      this.toggle(g.id);
    };
    this.document.addEventListener('keydown', onKey);
    inject(DestroyRef).onDestroy(() => this.document.removeEventListener('keydown', onKey));

    // Start (and after a zoom change) with the current week in view.
    let last: string | undefined;
    effect(() => {
      const key = `${this.zoom()}:${this.groups().length > 0}:${this.isMobile()}`;
      if (key === last) return;
      last = key;
      untracked(() => afterNextRender(() => this.scrollToToday(false), { injector: this.injector }));
    });
  }

  /** Bring the week of today to the left edge. */
  scrollToToday(smooth = true): void {
    this.now.set(new Date());
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const scale = this.scale();
    const week = startOfWeek(startOfDay(this.now()), { weekStartsOn: this.store.weekStartsOn() });
    const left = Math.max(0, dateX(scale, scale.zoom === 'quarter' ? addDays(week, -14) : week));
    el.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
    this.measure();
  }

  /** Scroll one window (whole weeks) back or forward. */
  page(direction: -1 | 1): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const scale = this.scale();
    const weeks = Math.max(1, Math.floor((el.clientWidth - LABEL_WIDTH) / scale.pxPerDay / 7));
    el.scrollBy({ left: direction * weeks * 7 * scale.pxPerDay, behavior: 'smooth' });
  }

  /**
   * The part of a bar that is on screen: a bar that started before the window keeps its title in view
   * (padded past the hidden part), and one with too little showing puts its title after the bar instead.
   */
  protected visible(row: TaskRow): { pad: number; title: boolean } {
    const v = this.view();
    const start = Math.max(row.bar.left, v.left);
    const end = Math.min(row.bar.left + row.bar.width, v.right);
    return { pad: Math.max(0, start - row.bar.left), title: row.bar.title && end - start >= TITLE_INSIDE_MIN };
  }

  /** Remember which part of the axis is in view. */
  protected measure(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const next = { left: el.scrollLeft, right: el.scrollLeft + el.clientWidth - LABEL_WIDTH };
    const cur = this.view();
    if (cur.left !== next.left || cur.right !== next.right) this.view.set(next);
  }

  protected percent(f: ProjectForecast): number {
    return f.total ? Math.round((f.done / f.total) * 100) : 0;
  }

  protected mixed(color: string, percent: number): string {
    return mix(color, percent);
  }

  /** "due Dec 12", with an arrow when the date is off screen. */
  protected dueText(g: GroupRow): string {
    if (!g.due) return '';
    const { left, right } = this.view();
    return `${g.due.text}${g.due.x > right ? ' →' : g.due.x < left ? ' ←' : ''}`;
  }

  protected toggle(id: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected highlighted(id: string): boolean {
    return this.ui.focusedRowId() === id;
  }

  /** A click on a row focuses it; a double click on a task opens it. */
  protected focusRow(id: string): void {
    this.ui.setFocusedRow(id);
  }

  protected openTask(issue: Issue): void {
    void this.router.navigate(['/', this.slug(), 'tasks', issue.key]);
  }

  /** A group's tasks as rows: roots by start, each followed by its sub-tasks that are in the same group. */
  private arrange(items: readonly Item[], scale: TimeScale, now: Date, statuses: IssueStatuses): TaskRow[] {
    const byId = new Map(items.map((it) => [it.issue.id, it]));
    const kids = new Map<string, Item[]>();
    const roots: Item[] = [];
    for (const it of items) {
      const parent = it.issue.parentId;
      if (parent && parent !== it.issue.id && byId.has(parent)) {
        const list = kids.get(parent);
        if (list) list.push(it);
        else kids.set(parent, [it]);
      } else roots.push(it);
    }
    const order = (a: Item, b: Item): number =>
      a.span.start.getTime() - b.span.start.getTime() || a.issue.number - b.issue.number;
    const rows: TaskRow[] = [];
    const seen = new Set<string>();
    const walk = (it: Item, depth: number): void => {
      if (seen.has(it.issue.id)) return;
      seen.add(it.issue.id);
      rows.push(this.taskRow(it, depth, scale, now, statuses));
      for (const child of (kids.get(it.issue.id) ?? []).sort(order)) walk(child, Math.min(depth + 1, MAX_DEPTH));
    };
    for (const root of roots.sort(order)) walk(root, 0);
    // Parents that point at each other have no root: show them flat rather than not at all.
    for (const it of [...items].sort(order)) walk(it, 0);
    return rows;
  }

  private taskRow(it: Item, depth: number, scale: TimeScale, now: Date, statuses: IssueStatuses): TaskRow {
    const { issue, span } = it;
    const color = resolveStatusEntry(statuses, issue.status)?.color ?? STATUS_TONE[issue.status] ?? STATUS_TONE['todo'];
    const left = dateX(scale, span.start);
    const gap = scale.pxPerDay >= 24 ? 5 : 1;
    const width = Math.max(dateEndX(scale, span.end) - left - gap, 6);
    const sub = depth > 0;
    const when =
      span.start.getTime() === span.end.getTime()
        ? shortDate(span.start, now)
        : `${shortDate(span.start, now)} → ${shortDate(span.end, now)}`;
    return {
      id: issue.id,
      issue,
      depth,
      pad: depth === 0 ? 16 : 36 + (depth - 1) * 12,
      color,
      fill: mix(color, 18),
      bar: {
        left,
        width,
        title: !sub && width >= TITLE_INSIDE_MIN,
        avatar: !sub && !!issue.assigneeId && width >= AVATAR_MIN,
        link: !issue.threadUrl ? 'none' : !sub && width >= LINK_INSIDE_MIN ? 'inside' : 'after',
      },
      tip: `${issue.key} ${issue.title} · ${when}`,
    };
  }
}

/** "Dec 12", with the year when it is not the current one. */
function shortDay(date: Date, now: Date): string {
  return format(date, date.getFullYear() === now.getFullYear() ? 'MMM d' : 'MMM d, yyyy');
}

/** "v1.2 · Records" becomes "v1.2". */
function shortName(name: string): string {
  const head = name.split(' · ')[0] ?? name;
  return head.length > 14 ? `${head.slice(0, 13)}…` : head;
}

function datesText(p: Project, now: Date): string {
  const start = parseDate(p.startDate);
  const target = parseDate(p.targetDate);
  if (start && target) return `${shortDate(start, now)} → ${shortDate(target, now)}`;
  if (target) return `Target ${shortDate(target, now)}`;
  if (start) return `Starts ${shortDate(start, now)}`;
  return 'No dates';
}
