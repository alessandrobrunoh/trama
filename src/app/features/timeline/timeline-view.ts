// The Gantt rendering of a saved view (layout "timeline") for workstreams and projects.
// The view decides WHICH items appear, in which order and in which groups (filters, sort, group-by);
// this component only draws them: a left column with the item, and a horizontal time grid (weeks /
// months / quarters, today line) where each item is a bar from its start date to its target date,
// coloured by status (workstreams) or health (projects), with a progress fill, hatched red once the
// target date has passed, and its milestones as diamonds. Items with no dates sit under "No dates".
// Drag the bar to move it, its edges to change the dates, a diamond to move a milestone; click for the
// side panel (workstreams) or the project page, right-click for the menu.
// Keyboard: t = today, ← → scroll, 1 2 3 = zoom, esc closes the panel.
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { format } from 'date-fns';
import { LucideCalendarPlus, LucideChartGantt, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  TramaStore,
  Notifier,
  PROJECT_STATUS_META,
  WORKSTREAM_STATUS_META,
  isTypingTarget,
  usePageShortcuts,
  type Milestone,
  type Project,
  type Workstream,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { MilestoneActions } from '../milestones/milestone-actions';
import { MilestoneIcon } from '../milestones/milestone-icon';
import { dateOfDay, dayOf, isoOfDay, todayDay } from '../milestones/milestone-model';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { ProjectGlyph } from '../projects/project-glyph';
import { DATE_PRESETS } from '../workstreams/ws-menu';
import { issueCounts } from '../workstreams/ws-model';
import type { ViewGroup } from '../views/view-model';
import { HATCH, STATUS_TONE, ZOOMS, buildScale, mix, projectTone, type Zoom } from './timeline-model';
import { TimelinePanel } from './timeline-panel';

const LEFT_W = 288;
const HEAD_H = 48;
const ROW_H = 36;
const GROUP_H = 28;

export type TimelineEntity = 'workstream' | 'project';

/** A workstream or a project placed on the timeline. */
interface Subject {
  id: string;
  ws?: Workstream;
  pj?: Project;
}

interface Range extends Subject {
  start: number;
  /** Target day (or the day it shipped / completed); null = open-ended. */
  end: number | null;
  marks: { ms: Milestone; day: number }[];
}

interface MsMark {
  ms: Milestone;
  day: number;
  x: number;
  labelW: number;
  fraction: number;
  state: 'idle' | 'empty' | 'active' | 'done' | 'overdue';
}

interface Bar extends Subject {
  start: number;
  end: number | null;
  left: number;
  width: number;
  open: boolean;
  overdueLeft: number | null;
  overdueW: number;
  progress: number;
  tone: string;
  editable: boolean;
  marks: MsMark[];
  tip: string;
  dragging: boolean;
  title: string;
}

type Row =
  | { kind: 'group'; id: string; key: string; group: ViewGroup; count: number; collapsed: boolean }
  | { kind: 'bar'; id: string; bar: Bar }
  | { kind: 'loose-head'; id: string; count: number }
  | { kind: 'loose'; id: string; subject: Subject };

type Preview = { kind: 'item'; id: string; start: number; end: number | null } | { kind: 'ms'; id: string; day: number };

const dayLabel = (d: number): string => format(dateOfDay(d), 'MMM d');

@Component({
  selector: 'app-timeline-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    EmptyState,
    ActorAvatar,
    Kbd,
    KeyChip,
    PriorityIcon,
    ProjectGlyph,
    StatusIcon,
    MilestoneIcon,
    TimelinePanel,
  ],
  host: { class: 'relative flex min-h-0 flex-1 flex-col' },
  template: `
    <div class="flex flex-wrap items-center gap-1.5 border-b px-4 py-1.5 sm:px-6" role="toolbar" aria-label="Timeline controls">
      <span class="text-muted-foreground text-xs">{{ barCount() }} {{ entity() === 'project' ? (barCount() === 1 ? 'project' : 'projects') : barCount() === 1 ? 'workstream' : 'workstreams' }} on the timeline</span>
      <span class="flex-1"></span>
      <div class="border-border-strong inline-flex h-7 items-center rounded-md border p-0.5" role="group" aria-label="Zoom">
        @for (z of zooms; track z.id) {
          <button type="button" class="h-6 rounded px-2 text-xs transition-colors" [class]="zoom() === z.id ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'" [attr.aria-pressed]="zoom() === z.id" (click)="setZoom(z.id)">{{ z.label }}</button>
        }
      </div>
      <button hlmBtn variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" (click)="scrollToToday(true)">Today<app-kbd keys="t" class="opacity-60" /></button>
    </div>

    @if (!anyDated()) {
      <div class="text-muted-foreground bg-muted/30 flex items-start gap-2 border-b px-4 py-2 text-xs sm:px-6">
        <svg [lucideIcon]="ganttIcon" [size]="14" class="mt-px shrink-0"></svg>
        <span>{{ entity() === 'project' ? 'Projects' : 'Workstreams' }} with a start or target date appear here as bars, with their milestones as diamonds. Set dates from the {{ entity() === 'project' ? 'project' : 'workstream' }}’s properties, or schedule one below.</span>
      </div>
    }

    <div class="flex min-h-0 flex-1">
      @if (!rows().length) {
        <div class="min-w-0 flex-1">
          <app-empty-state [icon]="ganttIcon" title="Nothing to place on the timeline" description="Give items a start or target date to see them here." />
        </div>
      } @else {
        <div #scroller class="relative min-w-0 flex-1 overflow-auto" tabindex="-1">
          <div class="relative" [style.width.px]="leftW + chartW()" style="min-height: 100%">
            <!-- shading + today line -->
            <div class="pointer-events-none absolute z-0" [style.left.px]="leftW" [style.top.px]="headH" [style.width.px]="chartW()" style="bottom: 0" aria-hidden="true">
              @for (c of scale().cols; track c.start) {
                <div class="border-border/60 absolute inset-y-0 border-l" [class.bg-muted]="c.alt" [class.opacity-50]="c.alt" [style.left.px]="x(c.start)" [style.width.px]="(c.end - c.start) * px()"></div>
              }
              <div class="bg-primary/60 absolute inset-y-0 w-px" [style.left.px]="x(today)"></div>
            </div>

            <!-- header -->
            <div class="bg-background sticky top-0 z-30 flex border-b" [style.height.px]="headH">
              <div class="bg-background text-muted-foreground sticky left-0 z-40 flex shrink-0 items-end border-r px-4 pb-1.5 text-xs" [style.width.px]="leftW">
                {{ entity() === 'project' ? 'Projects' : 'Workstreams' }}<span class="ml-1.5 tabular-nums">{{ barCount() }}</span>
              </div>
              <div class="relative shrink-0" [style.width.px]="chartW()">
                @for (t of scale().tops; track t.start) {
                  <div class="text-muted-foreground absolute top-0 h-6 truncate border-l px-2 pt-1 text-xs font-medium" [style.left.px]="x(t.start)" [style.width.px]="(t.end - t.start) * px()">{{ t.label }}</div>
                }
                @for (c of scale().cols; track c.start) {
                  <div class="text-muted-foreground absolute top-6 h-6 truncate border-l px-2 pt-0.5 text-xs tabular-nums" [style.left.px]="x(c.start)" [style.width.px]="(c.end - c.start) * px()">{{ c.label }}</div>
                }
                <div class="bg-primary text-primary-foreground absolute top-6 z-10 -translate-x-1/2 rounded px-1.5 text-[11px] leading-5 font-medium tabular-nums shadow-sm" [style.left.px]="x(today)">{{ todayLabel }}</div>
              </div>
            </div>

            <!-- rows -->
            @for (r of rows(); track r.id) {
              @switch (r.kind) {
                @case ('group') {
                  <div class="relative z-[1] flex" [style.height.px]="groupH">
                    <button type="button" class="bg-muted text-foreground sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-b px-3 text-xs font-medium" [style.width.px]="leftW" [attr.aria-expanded]="!r.collapsed" (click)="toggleGroup(r.key)">
                      <span class="text-muted-foreground inline-block transition-transform" [class.-rotate-90]="r.collapsed">▾</span>
                      @if (r.group.status && entity() === 'workstream') {
                        <app-status-icon entity="workstream" [status]="r.group.status" [size]="13" />
                      } @else if (r.group.priority) {
                        <app-priority-icon [priority]="r.group.priority" />
                      } @else if (r.group.actor) {
                        <app-actor-avatar [actor]="r.group.actor" [size]="16" />
                      } @else if (r.group.color) {
                        <span class="size-2 shrink-0 rounded-full" [style.background]="r.group.color"></span>
                      }
                      <span class="min-w-0 truncate">{{ r.group.label }}</span><span class="text-muted-foreground font-normal tabular-nums">{{ r.count }}</span>
                    </button>
                    <div class="bg-muted/60 flex-1 border-b"></div>
                  </div>
                }
                @case ('bar') {
                  @let b = r.bar;
                  <div
                    class="group/tr hover:bg-hover relative z-[1] flex border-b border-border/50"
                    [class.bg-selected]="panelId() === b.id"
                    [style.height.px]="rowH"
                    [hlmContextMenuTrigger]="menu"
                    (contextmenu)="setCtx($event, b)"
                  >
                    <div class="bg-background group-hover/tr:bg-muted sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r px-3 text-[13px]" [style.width.px]="leftW">
                      @if (b.ws; as w) {
                        <app-status-icon entity="workstream" [status]="w.status" />
                        <app-key-chip [value]="w.key" class="w-[4.5rem] shrink-0" />
                        <a [routerLink]="['/', slug(), 'workstreams', w.key]" class="min-w-0 flex-1 truncate outline-none hover:underline focus-visible:underline" [class.text-muted-foreground]="w.status === 'canceled'">{{ w.title }}</a>
                      } @else if (b.pj; as p) {
                        <app-project-glyph [project]="p" [size]="16" />
                        <a [routerLink]="['/', slug(), 'projects', p.id]" class="min-w-0 flex-1 truncate outline-none hover:underline focus-visible:underline" [class.text-muted-foreground]="p.status === 'canceled'">{{ p.name }}</a>
                      }
                      <span class="text-muted-foreground w-8 shrink-0 text-right text-xs tabular-nums">{{ pct(b) }}%</span>
                      @if (ownerOf(b); as uid) {
                        <app-actor-avatar [actor]="{ type: 'user', id: uid }" [size]="18" />
                      } @else {
                        <span class="size-[18px]"></span>
                      }
                    </div>
                    <div class="relative shrink-0" [style.width.px]="chartW()">
                      <!-- the bar -->
                      <div
                        class="absolute top-1.5 h-6 rounded-md border"
                        [class]="b.editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'"
                        [class.border-dashed]="b.open"
                        [class.ring-2]="panelId() === b.id"
                        [class.ring-primary]="panelId() === b.id"
                        [class.shadow-md]="b.dragging"
                        [style.left.px]="b.left"
                        [style.width.px]="b.width"
                        [style.background]="b.open ? 'linear-gradient(to right, ' + mixed(b.tone, 20) + ', transparent)' : mixed(b.tone, 18)"
                        [style.border-color]="mixed(b.tone, 55)"
                        role="button"
                        tabindex="0"
                        [attr.aria-label]="b.tip"
                        [attr.title]="b.tip"
                        (pointerdown)="dragItem($event, b, 'move')"
                        (click)="barClick(b)"
                        (dblclick)="open(b)"
                        (keydown.enter)="barClick(b)"
                      >
                        @if (b.progress > 0) {
                          <div class="pointer-events-none absolute inset-y-0 left-0 rounded-l-[5px]" [class.rounded-r-[5px]]="b.progress >= 1" [style.width.%]="b.progress * 100" [style.background]="mixed(b.tone, 42)"></div>
                        }
                        @if (b.editable) {
                          <span class="absolute inset-y-0 left-0 w-2 cursor-ew-resize" aria-hidden="true" (pointerdown)="dragItem($event, b, 'start')"></span>
                          <span class="absolute inset-y-0 right-0 w-2 cursor-ew-resize" aria-hidden="true" (pointerdown)="dragItem($event, b, 'end')"></span>
                        }
                      </div>
                      @if (b.overdueLeft !== null) {
                        <div class="pointer-events-none absolute top-1.5 h-6 rounded-r-md border border-l-0" style="border-color: color-mix(in oklab, var(--status-blocked) 50%, transparent)" [style.left.px]="b.overdueLeft" [style.width.px]="b.overdueW" [style.background]="hatch" title="Past the target date"></div>
                      }
                      @for (m of b.marks; track m.ms.id) {
                        <button
                          type="button"
                          class="absolute top-[11px] z-10 -ml-[7px] flex size-3.5 items-center justify-center outline-none"
                          [class]="b.editable ? 'cursor-ew-resize' : 'cursor-pointer'"
                          [style.left.px]="m.x"
                          [attr.aria-label]="'Milestone ' + m.ms.name + ', ' + dayText(m.day)"
                          [attr.title]="m.ms.name + ' · ' + dayText(m.day)"
                          (pointerdown)="dragMs($event, b, m)"
                          (click)="barClick(b)"
                        >
                          <app-milestone-icon [fraction]="m.fraction" [state]="m.state" [size]="15" [backdrop]="true" />
                        </button>
                        @if (zoom() !== 'quarter' && m.labelW > 28) {
                          <span class="text-foreground/80 pointer-events-none absolute top-[10px] z-10 truncate text-[11px] leading-4" [style.left.px]="m.x + 11" [style.max-width.px]="m.labelW">{{ m.ms.name }}</span>
                        }
                      }
                    </div>
                  </div>
                }
                @case ('loose-head') {
                  <div class="relative z-[1] flex" [style.height.px]="groupH">
                    <div class="bg-muted text-foreground sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-b px-3 text-xs font-medium" [style.width.px]="leftW">
                      No dates<span class="text-muted-foreground font-normal tabular-nums">{{ r.count }}</span>
                    </div>
                    <div class="bg-muted/60 text-muted-foreground flex flex-1 items-center border-b px-3 text-xs"><span class="sticky" [style.left.px]="leftW + 12">Not on the timeline until they have a start or target date</span></div>
                  </div>
                }
                @case ('loose') {
                  <div class="group/tr hover:bg-hover relative z-[1] flex border-b border-border/50" [style.height.px]="rowH" [hlmContextMenuTrigger]="menu" (contextmenu)="setLooseCtx(r.subject)">
                    <div class="bg-background group-hover/tr:bg-muted sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r px-3 text-[13px]" [style.width.px]="leftW">
                      @if (r.subject.ws; as w) {
                        <app-status-icon entity="workstream" [status]="w.status" />
                        <app-key-chip [value]="w.key" class="w-[4.5rem] shrink-0" />
                        <a [routerLink]="['/', slug(), 'workstreams', w.key]" class="text-muted-foreground min-w-0 flex-1 truncate outline-none hover:underline focus-visible:underline">{{ w.title }}</a>
                      } @else if (r.subject.pj; as p) {
                        <app-project-glyph [project]="p" [size]="16" />
                        <a [routerLink]="['/', slug(), 'projects', p.id]" class="text-muted-foreground min-w-0 flex-1 truncate outline-none hover:underline focus-visible:underline">{{ p.name }}</a>
                      }
                      @if (ownerOfSubject(r.subject); as uid) {
                        <app-actor-avatar [actor]="{ type: 'user', id: uid }" [size]="18" />
                      }
                    </div>
                    <div class="flex shrink-0 items-center px-3" [style.width.px]="chartW()">
                      @if (canEditSubject(r.subject)) {
                        <button hlmBtn variant="outline" size="xs" class="sticky gap-1.5 text-xs" [style.left.px]="leftW + 12" (click)="schedule(r.subject)">
                          <svg [lucideIcon]="schedIcon" [size]="12"></svg>Schedule · next 2 weeks
                        </button>
                      }
                    </div>
                  </div>
                }
              }
            }
          </div>
        </div>
      }

      @if (panelWs(); as pw) {
        <aside class="bg-background flex w-[400px] max-w-full shrink-0 flex-col border-l max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:shadow-xl" aria-label="Workstream details">
          <app-timeline-panel class="min-h-0 flex-1" [ws]="pw" (closed)="panelId.set(null)" />
        </aside>
      }
    </div>

    <ng-template #menu>
      @let c = ctx();
      @if (c) {
        <hlm-dropdown-menu class="w-56">
          <hlm-dropdown-menu-group>
            <button hlmDropdownMenuItem (triggered)="open(c.subject)">{{ c.subject.pj ? 'Open project' : 'Open workstream' }}</button>
            @if (c.subject.ws) {
              <button hlmDropdownMenuItem (triggered)="panelId.set(c.subject.id)">Show details</button>
            }
          </hlm-dropdown-menu-group>
          @if (canEditSubject(c.subject)) {
            <hlm-dropdown-menu-separator />
            <hlm-dropdown-menu-group>
              <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="startSub">Set start date<hlm-dropdown-menu-item-sub-indicator /></button>
              <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="targetSub">Set target date<hlm-dropdown-menu-item-sub-indicator /></button>
              <button hlmDropdownMenuItem (triggered)="addMilestone(c.subject, c.day)">Add milestone on {{ dayText(c.day) }}</button>
            </hlm-dropdown-menu-group>
          }
        </hlm-dropdown-menu>
      }
    </ng-template>
    <ng-template #startSub>
      <hlm-dropdown-menu-sub class="w-48">
        @for (d of presets; track d.label) {
          <button hlmDropdownMenuItem (triggered)="setDates(ctx()!.subject, { start: dayOfDate(d.at()) })">{{ d.label }}</button>
        }
        @if (startOf(ctx()?.subject)) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="setDates(ctx()!.subject, { start: null })"><span class="text-muted-foreground">Clear start date</span></button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>
    <ng-template #targetSub>
      <hlm-dropdown-menu-sub class="w-48">
        @for (d of presets; track d.label) {
          <button hlmDropdownMenuItem (triggered)="setDates(ctx()!.subject, { end: dayOfDate(d.at()) })">{{ d.label }}</button>
        }
        @if (targetOf(ctx()?.subject)) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="setDates(ctx()!.subject, { end: null })"><span class="text-muted-foreground">Clear target date</span></button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>
  `,
})
export class TimelineView {
  private readonly store = inject(TramaStore);
  private readonly router = inject(Router);
  private readonly notify = inject(Notifier);
  private readonly info = inject(MilestoneInfo);
  private readonly msActions = inject(MilestoneActions);

  /** What the groups hold. */
  readonly entity = input.required<TimelineEntity>();
  /** Items already filtered, sorted and grouped by the view. */
  readonly groups = input.required<readonly ViewGroup[]>();
  /** Show a collapsible header per group (the view has a group-by). */
  readonly grouped = input(false);

  protected readonly leftW = LEFT_W;
  protected readonly headH = HEAD_H;
  protected readonly rowH = ROW_H;
  protected readonly groupH = GROUP_H;
  protected readonly zooms = ZOOMS;
  protected readonly hatch = HATCH;
  protected readonly presets = DATE_PRESETS;
  protected readonly ganttIcon = LucideChartGantt;
  protected readonly schedIcon = LucideCalendarPlus;
  protected readonly today = todayDay();
  protected readonly todayLabel = format(new Date(), 'MMM d');
  protected readonly mixed = mix;

  protected readonly zoom = signal<Zoom>('week');
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly panelId = signal<string | null>(null);
  protected readonly preview = signal<Preview | null>(null);
  protected readonly ctx = signal<{ subject: Subject; day: number } | null>(null);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private suppressClick = false;
  private didScroll = false;
  private stopDrag: (() => void) | null = null;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly px = computed(() => ZOOMS.find((z) => z.id === this.zoom())!.pxPerDay);
  protected readonly panelWs = computed(() => (this.entity() === 'workstream' ? this.store.getWorkstream(this.panelId()) : undefined));

  // ───────── data ─────────

  /** Every distinct item of the view, in view order. */
  private readonly subjects = computed<Subject[]>(() => {
    const seen = new Set<string>();
    const out: Subject[] = [];
    const project = this.entity() === 'project';
    for (const g of this.groups()) {
      for (const item of g.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(project ? { id: item.id, pj: item as Project } : { id: item.id, ws: item as Workstream });
      }
    }
    return out;
  });

  protected readonly anyDated = computed(() => this.subjects().some((s) => !!this.startOf(s) || !!this.targetOf(s)));

  private readonly ranges = computed<Range[]>(() => {
    const byWs = this.store.milestonesByWorkstream();
    const byProject = this.store.milestonesByProject();
    const out = new Map<string, Range>();
    for (const s of this.subjects()) {
      if (!this.startOf(s) && !this.targetOf(s)) continue;
      const ws = s.ws;
      const pj = s.pj;
      const created = ws?.createdAt ?? pj?.createdAt ?? '';
      const start = dayOf(this.startOf(s) ?? created);
      let end: number | null = null;
      const target = this.targetOf(s);
      if (target) end = dayOf(target);
      else if (ws?.status === 'shipped') end = dayOf(ws.shippedAt ?? ws.updatedAt);
      else if (pj?.status === 'completed') end = dayOf(pj.completedAt ?? pj.updatedAt);
      const list = (ws ? byWs.get(ws.id) : pj ? byProject.get(pj.id) : undefined) ?? [];
      const marks = list.filter((m) => m.targetDate).map((ms) => ({ ms, day: dayOf(ms.targetDate!) }));
      out.set(s.id, { ...s, start, end, marks });
    }
    return [...out.values()];
  });

  private readonly loose = computed(() => this.subjects().filter((s) => !this.startOf(s) && !this.targetOf(s)));

  protected readonly scale = computed(() => {
    let lo = this.today - 30;
    let hi = this.today + 90;
    for (const r of this.ranges()) {
      lo = Math.min(lo, r.start, ...r.marks.map((m) => m.day));
      hi = Math.max(hi, r.end ?? r.start + 14, ...r.marks.map((m) => m.day));
    }
    return buildScale(this.zoom(), lo - 14, hi + 30, this.store.settings().weekStart);
  });
  protected readonly chartW = computed(() => (this.scale().endDay - this.scale().startDay) * this.px());

  protected x(day: number): number {
    return (day - this.scale().startDay) * this.px();
  }

  private readonly bars = computed<Map<string, Bar>>(() => {
    const p = this.preview();
    const px = this.px();
    const today = this.today;
    const stats = this.info.stats();
    const states = this.info.states();
    const out = new Map<string, Bar>();
    for (const r of this.ranges()) {
      let start = r.start;
      let end = r.end;
      if (p?.kind === 'item' && p.id === r.id) {
        start = p.start;
        end = p.end;
      }
      const visEnd = Math.max(start, end ?? Math.max(today, start + 14));
      const left = this.x(start);
      const width = Math.max(10, this.x(visEnd) - left);
      const ws = r.ws;
      const pj = r.pj;
      const finished = ws ? ws.status === 'shipped' || ws.status === 'canceled' : !!pj && (pj.status === 'completed' || pj.status === 'canceled');
      const progress = this.progressOf(r);
      const marks = r.marks
        .map((m) => {
          const day = p?.kind === 'ms' && p.id === m.ms.id ? p.day : m.day;
          const st = stats.get(m.ms.id);
          return { ms: m.ms, day, x: this.x(day), labelW: 140, fraction: st?.fraction ?? 0, state: states.get(m.ms.id) ?? 'idle' } as MsMark;
        })
        .sort((a, b) => a.x - b.x);
      marks.forEach((m, i) => (m.labelW = Math.min(140, (marks[i + 1] ? marks[i + 1].x - m.x : 140) - 16)));
      const range = end === null ? `${dayLabel(start)} → no target date` : `${dayLabel(start)} → ${dayLabel(end)}`;
      const title = ws ? ws.title : pj!.name;
      const label = ws ? `${ws.key} · ${ws.title} · ${WORKSTREAM_STATUS_META[ws.status].label}` : `${pj!.name} · ${PROJECT_STATUS_META[pj!.status].label}`;
      out.set(r.id, {
        id: r.id,
        ws,
        pj,
        title,
        start,
        end,
        left,
        width,
        open: end === null,
        overdueLeft: end !== null && end < today && !finished ? this.x(end) : null,
        overdueW: end !== null ? Math.max(0, (today - end) * px) : 0,
        progress,
        tone: ws ? STATUS_TONE[ws.status] : projectTone(pj!),
        editable: this.canEditSubject(r),
        marks,
        tip: `${label} · ${range} · ${Math.round(progress * 100)}%`,
        dragging: !!p && ((p.kind === 'item' && p.id === r.id) || (p.kind === 'ms' && marks.some((m) => m.ms.id === p.id))),
      });
    }
    return out;
  });
  protected readonly barCount = computed(() => this.bars().size + this.loose().length);

  protected readonly rows = computed<Row[]>(() => {
    const out: Row[] = [];
    const bars = this.bars();
    const collapsed = this.collapsed();
    const grouped = this.grouped();
    for (const g of this.groups()) {
      const mine = g.items.map((i) => bars.get(i.id)).filter((b): b is Bar => !!b);
      if (!mine.length) continue;
      const isCollapsed = grouped && collapsed.has(g.key);
      if (grouped) out.push({ kind: 'group', id: 'g:' + g.key, key: g.key, group: g, count: mine.length, collapsed: isCollapsed });
      if (!isCollapsed) for (const bar of mine) out.push({ kind: 'bar', id: g.key + ':' + bar.id, bar });
    }
    const loose = this.loose();
    if (loose.length) {
      out.push({ kind: 'loose-head', id: 'loose-head', count: loose.length });
      for (const subject of loose) out.push({ kind: 'loose', id: 'l:' + subject.id, subject });
    }
    return out;
  });

  constructor() {
    afterNextRender(() => this.initialScroll());
    effect(() => {
      // the grid appears once data is there
      if (this.scroller() && !this.didScroll) this.initialScroll();
    });
    inject(DestroyRef).onDestroy(() => this.stopDrag?.());
    usePageShortcuts([
      { keys: 't', label: 'Scroll to today', run: () => this.scrollToToday(true) },
      { keys: 'left', label: 'Scroll back', run: () => this.scrollBy(-1) },
      { keys: 'right', label: 'Scroll forward', run: () => this.scrollBy(1) },
      { keys: '1', label: 'Week zoom', run: () => this.setZoom('week') },
      { keys: '2', label: 'Month zoom', run: () => this.setZoom('month') },
      { keys: '3', label: 'Quarter zoom', run: () => this.setZoom('quarter') },
      { keys: 'esc', label: 'Close details', when: () => !!this.panelId() && !isTypingTarget(globalThis.document?.activeElement ?? null), run: () => this.panelId.set(null) },
    ]);
  }

  // ───────── per-entity accessors ─────────

  protected startOf(s: Subject | null | undefined): string | undefined {
    return s?.ws?.startDate ?? s?.pj?.startDate;
  }
  protected targetOf(s: Subject | null | undefined): string | undefined {
    return s?.ws?.targetDate ?? s?.pj?.targetDate;
  }
  protected ownerOf(b: Bar): string | undefined {
    return this.ownerOfSubject(b);
  }
  protected ownerOfSubject(s: Subject): string | undefined {
    return s.ws?.accountableUserId ?? s.pj?.leadId;
  }
  protected canEditSubject(s: Subject): boolean {
    if (s.ws) return this.store.canEditTeamWork(s.ws.ownerTeamId);
    return this.store.allowed('manageProjects');
  }
  protected dayOfDate(d: Date): number {
    return dayOf(d);
  }

  /** Done / total issues (or criteria) as a 0..1 fraction. */
  private progressOf(r: Subject): number {
    const ws = r.ws;
    if (ws) {
      if (ws.status === 'shipped') return 1;
      const c = issueCounts(this.store.issuesByWorkstream().get(ws.id) ?? []);
      const criteria = ws.acceptanceCriteria;
      return c.issuesTotal ? c.issuesDone / c.issuesTotal : criteria.length ? criteria.filter((k) => k.state === 'met').length / criteria.length : 0;
    }
    const pj = r.pj!;
    if (pj.status === 'completed') return 1;
    const c = issueCounts(this.store.issuesByProject().get(pj.id) ?? []);
    return c.issuesTotal ? c.issuesDone / c.issuesTotal : 0;
  }

  // ───────── scrolling / zoom ─────────

  private initialScroll(): void {
    const el = this.scroller()?.nativeElement;
    if (!el || this.didScroll) return;
    this.didScroll = true;
    queueMicrotask(() => this.scrollToToday(false));
  }

  protected scrollToToday(smooth: boolean): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const left = this.x(this.today) - 0.3 * Math.max(200, el.clientWidth - LEFT_W);
    el.scrollTo({ left: Math.max(0, left), behavior: smooth ? 'smooth' : 'auto' });
  }

  private scrollBy(dir: 1 | -1): void {
    this.scroller()?.nativeElement.scrollBy({ left: dir * 7 * this.px() * 2, behavior: 'smooth' });
  }

  protected setZoom(z: Zoom): void {
    if (z === this.zoom()) return;
    const el = this.scroller()?.nativeElement;
    // keep the centre of the view on the same date
    let centre: number | null = null;
    if (el) centre = this.scale().startDay + (el.scrollLeft + (el.clientWidth - LEFT_W) / 2) / this.px();
    this.zoom.set(z);
    if (el && centre !== null) {
      const c = centre;
      requestAnimationFrame(() => el.scrollTo({ left: Math.max(0, this.x(c) - (el.clientWidth - LEFT_W) / 2), behavior: 'auto' }));
    }
  }

  protected toggleGroup(key: string): void {
    this.collapsed.update((s) => {
      const n = new Set(s);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  }

  // ───────── helpers ─────────

  protected pct(b: Bar): number {
    return Math.round(b.progress * 100);
  }
  protected dayText(day: number): string {
    return dayLabel(day);
  }
  protected open(s: Subject): void {
    void this.router.navigate(s.ws ? ['/', this.slug(), 'workstreams', s.ws.key] : ['/', this.slug(), 'projects', s.id]);
  }
  /** Workstreams open their side panel; projects have a page of their own. */
  protected barClick(b: Bar): void {
    if (this.suppressClick) return;
    if (b.pj) {
      this.open(b);
      return;
    }
    this.panelId.update((id) => (id === b.id ? null : b.id));
  }

  /** Calendar day under a pointer position (for the context menu). */
  private dayAt(ev: MouseEvent): number {
    const el = this.scroller()?.nativeElement;
    if (!el) return this.today;
    const rect = el.getBoundingClientRect();
    return this.scale().startDay + Math.floor((ev.clientX - rect.left + el.scrollLeft - LEFT_W) / this.px());
  }
  protected setCtx(ev: MouseEvent, s: Subject): void {
    this.ctx.set({ subject: s, day: this.dayAt(ev) });
  }
  protected setLooseCtx(s: Subject): void {
    this.ctx.set({ subject: s, day: this.today });
  }

  // ───────── editing ─────────

  /** Patch one item's dates (`null` clears a date) and offer Undo. */
  private writeDates(s: Subject, patch: { startDate?: string | null; targetDate?: string | null }, toast: { title: string; description?: string }): void {
    const before = { startDate: this.startOf(s) ?? null, targetDate: this.targetOf(s) ?? null };
    const write = (p: { startDate?: string | null; targetDate?: string | null }): void => {
      if (s.ws) void this.store.updateWorkstream(s.id, p);
      else void this.store.updateProject(s.id, p);
    };
    write(patch);
    this.notify.success(toast.title, { description: toast.description, action: { label: 'Undo', run: () => write(before) } });
  }

  private name(s: Subject): string {
    return s.ws ? s.ws.key : s.pj!.name;
  }

  /** Context-menu presets: `start` / `end` are day numbers, `null` clears. */
  protected setDates(s: Subject, d: { start?: number | null; end?: number | null }): void {
    const patch: { startDate?: string | null; targetDate?: string | null } = {};
    if (d.start !== undefined) patch.startDate = d.start === null ? null : isoOfDay(d.start);
    if (d.end !== undefined) patch.targetDate = d.end === null ? null : isoOfDay(d.end);
    this.writeDates(s, patch, { title: d.start !== undefined ? (d.start === null ? 'Start date cleared' : 'Start date updated') : d.end === null ? 'Target date cleared' : 'Target date updated' });
  }

  protected schedule(s: Subject): void {
    this.writeDates(s, { startDate: isoOfDay(this.today), targetDate: isoOfDay(this.today + 14) }, {
      title: `${this.name(s)} scheduled`,
      description: `${dayLabel(this.today)} → ${dayLabel(this.today + 14)}`,
    });
  }

  protected async addMilestone(s: Subject, day: number): Promise<void> {
    // Milestones belong to the project (of the workstream, when this is one).
    const project = s.pj ?? this.store.getProject(s.ws?.projectId);
    if (!project) {
      this.notify.info(`${this.name(s)} is not in a project`, { description: 'Milestones belong to a project. Add the workstream to one first.' });
      return;
    }
    const n = (this.store.milestonesByProject().get(project.id)?.length ?? 0) + 1;
    const ms = await this.msActions.create(project.id, `Milestone ${n}`, isoOfDay(day));
    if (ms) {
      if (s.ws) this.panelId.set(s.id);
      this.notify.success(`Milestone added to ${project.name}`, { description: `On ${dayLabel(day)}. Rename it from the project page.` });
    }
  }

  /** Drag a bar (`move`) or one of its edges. */
  protected dragItem(ev: PointerEvent, b: Bar, mode: 'move' | 'start' | 'end'): void {
    if (!b.editable) return;
    if (mode !== 'move') ev.stopPropagation();
    const base = { start: b.start, end: b.end, visEnd: Math.max(b.start, b.end ?? Math.max(this.today, b.start + 14)) };
    this.beginDrag(
      ev,
      (d) => {
        if (mode === 'move') return { kind: 'item', id: b.id, start: base.start + d, end: base.end === null ? null : base.end + d };
        if (mode === 'start') return { kind: 'item', id: b.id, start: Math.min(base.start + d, base.visEnd - 1), end: base.end };
        return { kind: 'item', id: b.id, start: base.start, end: Math.max(base.visEnd + d, base.start + 1) };
      },
      (p) => {
        if (p.kind !== 'item') return;
        const patch: { startDate?: string; targetDate?: string } = {};
        if (mode !== 'end' && p.start !== base.start) patch.startDate = isoOfDay(p.start);
        if (mode === 'end' && p.end !== null) patch.targetDate = isoOfDay(p.end);
        if (mode === 'move' && p.end !== null && this.targetOf(b)) patch.targetDate = isoOfDay(p.end);
        if (!Object.keys(patch).length) return;
        this.writeDates(b, patch, {
          title: `${this.name(b)} rescheduled`,
          description: `${dayLabel(p.start)} → ${p.end === null ? 'no target date' : dayLabel(p.end)}`,
        });
      },
    );
  }

  /** Drag a milestone diamond to change its date. */
  protected dragMs(ev: PointerEvent, b: Bar, m: MsMark): void {
    if (!b.editable) return;
    ev.stopPropagation();
    const base = m.day;
    this.beginDrag(
      ev,
      (d) => ({ kind: 'ms', id: m.ms.id, day: base + d }),
      (p) => {
        if (p.kind !== 'ms' || p.day === base) return;
        const before = m.ms.targetDate ?? null;
        this.msActions.setDay(m.ms, p.day);
        this.notify.success(`${m.ms.name} moved to ${dayLabel(p.day)}`, {
          action: { label: 'Undo', run: () => void this.store.updateMilestone(m.ms.id, { targetDate: before }) },
        });
      },
    );
  }

  private beginDrag(ev: PointerEvent, apply: (days: number) => Preview, commit: (final: Preview) => void): void {
    if (ev.button !== 0) return;
    ev.preventDefault();
    this.stopDrag?.();
    const startX = ev.clientX;
    let moved = false;
    let last: Preview | null = null;
    const doc = globalThis.document;
    const onMove = (e: PointerEvent): void => {
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < 4) return;
      moved = true;
      last = apply(Math.round(dx / this.px()));
      this.preview.set(last);
    };
    const finish = (ok: boolean): void => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('keydown', onKey, true);
      this.stopDrag = null;
      this.preview.set(null);
      if (moved) {
        this.suppressClick = true;
        setTimeout(() => (this.suppressClick = false), 0);
        if (ok && last) commit(last);
      }
    };
    const onUp = (): void => finish(true);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      finish(false);
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('keydown', onKey, true);
    this.stopDrag = () => finish(false);
  }
}
