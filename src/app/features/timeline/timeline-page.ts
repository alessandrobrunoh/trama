// `/:slug/timeline` — Linear-style roadmap. Left: workstreams (hexagon status, key, title,
// accountable, progress). Right: a horizontal time grid (weeks / months / quarters with month or
// year headers, alternating column shading, a today line and pill). Each workstream is a bar from
// its start date to its target date coloured by status, with a progress fill, hatched red once the
// target date has passed, and its milestones as diamonds. Drag the bar to move it, its edges to
// change the dates, a diamond to move a milestone; click for the side panel, right-click for the menu.
// Keyboard: t = today, ← → scroll, 1 2 3 = zoom, esc closes the panel.
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { format } from 'date-fns';
import { LucideCalendarPlus, LucideChartGantt, LucideDynamicIcon, LucideLayers, LucideUserRound, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { NablaStore, Notifier, WORKSTREAM_STATUS_META, isTypingTarget, usePageShortcuts, type Milestone, type Team, type Workstream, type WorkstreamStatus } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { KeyChip } from '../../shared/key-chip';
import { PageHeader } from '../../shared/page-header';
import { StatusIcon } from '../../shared/status';
import { MilestoneActions } from '../milestones/milestone-actions';
import { MilestoneIcon } from '../milestones/milestone-icon';
import { dateOfDay, dayOf, isoOfDay, todayDay } from '../milestones/milestone-model';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { Picker } from '../workstreams/picker';
import { WsActions } from '../workstreams/ws-actions';
import { DATE_PRESETS } from '../workstreams/ws-menu';
import { issueCounts, statusOptions, teamOptions, userOptions } from '../workstreams/ws-model';
import { HATCH, STATUS_TONE, ZOOMS, buildScale, mix, type Zoom } from './timeline-model';
import { TimelinePanel } from './timeline-panel';

const LEFT_W = 288;
const HEAD_H = 48;
const ROW_H = 36;
const GROUP_H = 28;

interface Range {
  ws: Workstream;
  start: number;
  /** Target day (or the day it shipped); null = open-ended. */
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

interface Bar {
  ws: Workstream;
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
}

type Row =
  | { kind: 'group'; id: string; team: Team; count: number; collapsed: boolean }
  | { kind: 'bar'; id: string; bar: Bar }
  | { kind: 'loose-head'; id: string; count: number }
  | { kind: 'loose'; id: string; ws: Workstream };

type Preview = { kind: 'ws'; id: string; start: number; end: number | null } | { kind: 'ms'; id: string; day: number };

const dayLabel = (d: number): string => format(dateOfDay(d), 'MMM d');

@Component({
  selector: 'app-timeline-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    PageHeader,
    EmptyState,
    ActorAvatar,
    Kbd,
    KeyChip,
    StatusIcon,
    Picker,
    MilestoneIcon,
    TimelinePanel,
  ],
  host: { class: 'relative flex h-full min-h-0 flex-col' },
  template: `
    <app-page-header title="Timeline" description="Workstreams and milestones on a calendar" />

    <div class="flex flex-wrap items-center gap-1.5 border-b px-4 py-1.5 sm:px-6" role="toolbar" aria-label="Timeline controls">
      <app-picker variant="chip" label="Team" [multiple]="true" [icon]="teamIcon" [options]="teams()" [value]="teamFilter()" (valueChange)="teamFilter.set($event)" />
      <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statuses" [value]="statusFilter()" (valueChange)="statusFilter.set($event)" />
      <app-picker variant="chip" label="Accountable" [multiple]="true" [icon]="userIcon" [options]="users()" [value]="userFilter()" (valueChange)="userFilter.set($event)" />
      @if (filtered()) {
        <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 gap-1 px-2 text-xs font-normal" (click)="clearFilters()">
          <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
        </button>
      }
      <span class="flex-1"></span>
      <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 gap-1.5 px-2 text-xs font-normal" [class.bg-accent]="groupByTeam()" [attr.aria-pressed]="groupByTeam()" (click)="groupByTeam.update((v) => !v)">
        <svg [lucideIcon]="groupIcon" [size]="13"></svg>Group by team
      </button>
      <div class="border-border-strong inline-flex h-7 items-center rounded-md border p-0.5" role="group" aria-label="Zoom">
        @for (z of zooms; track z.id; let i = $index) {
          <button type="button" class="h-6 rounded px-2 text-xs transition-colors" [class]="zoom() === z.id ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:text-foreground'" [attr.aria-pressed]="zoom() === z.id" (click)="setZoom(z.id)">{{ z.label }}</button>
        }
      </div>
      <button hlmBtn variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" (click)="scrollToToday(true)">Today<app-kbd keys="t" class="opacity-60" /></button>
    </div>

    @if (!anyDated()) {
      <div class="text-muted-foreground flex items-start gap-2 border-b bg-muted/30 px-4 py-2 text-xs sm:px-6">
        <svg [lucideIcon]="ganttIcon" [size]="14" class="mt-px shrink-0"></svg>
        <span>Workstreams with a start or target date appear here as bars, with their milestones as diamonds. Set dates from a workstream’s properties, or schedule one below.</span>
      </div>
    }

    <div class="flex min-h-0 flex-1">
      @if (!rows().length) {
        <div class="min-w-0 flex-1">
          <app-empty-state [icon]="ganttIcon" [title]="filtered() ? 'No workstreams match these filters' : 'No workstreams yet'" [description]="filtered() ? 'Try removing a filter.' : 'Create a workstream and give it a target date to see it here.'">
            @if (filtered()) {
              <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
            }
          </app-empty-state>
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
                Workstreams<span class="ml-1.5 tabular-nums">{{ barCount() }}</span>
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
                    <button type="button" class="bg-muted text-foreground sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-b px-3 text-xs font-medium" [style.width.px]="leftW" [attr.aria-expanded]="!r.collapsed" (click)="toggleGroup(r.id)">
                      <span class="text-muted-foreground inline-block transition-transform" [class.-rotate-90]="r.collapsed">▾</span>
                      <app-actor-avatar [actor]="{ type: 'team', id: r.team.id }" [size]="16" />
                      {{ r.team.name }}<span class="text-muted-foreground font-normal tabular-nums">{{ r.count }}</span>
                    </button>
                    <div class="bg-muted/60 flex-1 border-b"></div>
                  </div>
                }
                @case ('bar') {
                  @let b = r.bar;
                  <div
                    class="group/tr hover:bg-hover relative z-[1] flex border-b border-border/50"
                    [class.bg-selected]="panelId() === b.ws.id"
                    [style.height.px]="rowH"
                    [hlmContextMenuTrigger]="menu"
                    (contextmenu)="setCtx($event, b.ws)"
                  >
                    <div class="bg-background group-hover/tr:bg-muted sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r px-3 text-[13px]" [style.width.px]="leftW">
                      <app-status-icon entity="workstream" [status]="b.ws.status" />
                      <app-key-chip [value]="b.ws.key" class="w-[4.5rem] shrink-0" />
                      <a [routerLink]="['/', slug(), 'workstreams', b.ws.key]" class="min-w-0 flex-1 truncate outline-none hover:underline focus-visible:underline" [class.text-muted-foreground]="b.ws.status === 'canceled'">{{ b.ws.title }}</a>
                      <span class="text-muted-foreground w-8 shrink-0 text-right text-xs tabular-nums">{{ pct(b) }}%</span>
                      @if (b.ws.accountableUserId) {
                        <app-actor-avatar [actor]="{ type: 'user', id: b.ws.accountableUserId }" [size]="18" />
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
                        [class.ring-2]="panelId() === b.ws.id"
                        [class.ring-primary]="panelId() === b.ws.id"
                        [class.shadow-md]="b.dragging"
                        [style.left.px]="b.left"
                        [style.width.px]="b.width"
                        [style.background]="b.open ? 'linear-gradient(to right, ' + mixed(b.tone, 20) + ', transparent)' : mixed(b.tone, 18)"
                        [style.border-color]="mixed(b.tone, 55)"
                        role="button"
                        tabindex="0"
                        [attr.aria-label]="b.tip"
                        [attr.title]="b.tip"
                        (pointerdown)="dragWs($event, b, 'move')"
                        (click)="barClick(b.ws)"
                        (dblclick)="open(b.ws)"
                        (keydown.enter)="barClick(b.ws)"
                      >
                        @if (b.progress > 0) {
                          <div class="pointer-events-none absolute inset-y-0 left-0 rounded-l-[5px]" [class.rounded-r-[5px]]="b.progress >= 1" [style.width.%]="b.progress * 100" [style.background]="mixed(b.tone, 42)"></div>
                        }
                        @if (b.editable) {
                          <span class="absolute inset-y-0 left-0 w-2 cursor-ew-resize" aria-hidden="true" (pointerdown)="dragWs($event, b, 'start')"></span>
                          <span class="absolute inset-y-0 right-0 w-2 cursor-ew-resize" aria-hidden="true" (pointerdown)="dragWs($event, b, 'end')"></span>
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
                          (click)="barClick(b.ws)"
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
                  <div class="group/tr hover:bg-hover relative z-[1] flex border-b border-border/50" [style.height.px]="rowH" [hlmContextMenuTrigger]="menu" (contextmenu)="setCtx($event, r.ws)">
                    <div class="bg-background group-hover/tr:bg-muted sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r px-3 text-[13px]" [style.width.px]="leftW">
                      <app-status-icon entity="workstream" [status]="r.ws.status" />
                      <app-key-chip [value]="r.ws.key" class="w-[4.5rem] shrink-0" />
                      <a [routerLink]="['/', slug(), 'workstreams', r.ws.key]" class="text-muted-foreground min-w-0 flex-1 truncate outline-none hover:underline focus-visible:underline">{{ r.ws.title }}</a>
                      @if (r.ws.accountableUserId) {
                        <app-actor-avatar [actor]="{ type: 'user', id: r.ws.accountableUserId }" [size]="18" />
                      }
                    </div>
                    <div class="flex shrink-0 items-center px-3" [style.width.px]="chartW()">
                      @if (canEditWs(r.ws)) {
                        <button hlmBtn variant="outline" size="xs" class="sticky gap-1.5 text-xs" [style.left.px]="leftW + 12" (click)="schedule(r.ws)">
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
            <button hlmDropdownMenuItem (triggered)="open(c.ws)">Open workstream</button>
            <button hlmDropdownMenuItem (triggered)="panelId.set(c.ws.id)">Show details</button>
          </hlm-dropdown-menu-group>
          @if (canEditWs(c.ws)) {
            <hlm-dropdown-menu-separator />
            <hlm-dropdown-menu-group>
              <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="startSub">Set start date<hlm-dropdown-menu-item-sub-indicator /></button>
              <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="targetSub">Set target date<hlm-dropdown-menu-item-sub-indicator /></button>
              <button hlmDropdownMenuItem (triggered)="addMilestone(c.ws, c.day)">Add milestone on {{ dayText(c.day) }}</button>
            </hlm-dropdown-menu-group>
          }
        </hlm-dropdown-menu>
      }
    </ng-template>
    <ng-template #startSub>
      <hlm-dropdown-menu-sub class="w-48">
        @for (d of presets; track d.label) {
          <button hlmDropdownMenuItem (triggered)="setStart(ctx()!.ws, d.at())">{{ d.label }}</button>
        }
        @if (ctx()?.ws?.startDate) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="setStart(ctx()!.ws, null)"><span class="text-muted-foreground">Clear start date</span></button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>
    <ng-template #targetSub>
      <hlm-dropdown-menu-sub class="w-48">
        @for (d of presets; track d.label) {
          <button hlmDropdownMenuItem (triggered)="actions.setTargetDate([ctx()!.ws], d.at())">{{ d.label }}</button>
        }
        @if (ctx()?.ws?.targetDate) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="actions.setTargetDate([ctx()!.ws], null)"><span class="text-muted-foreground">Clear target date</span></button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>
  `,
})
export class TimelinePage {
  private readonly store = inject(NablaStore);
  private readonly router = inject(Router);
  private readonly notify = inject(Notifier);
  private readonly info = inject(MilestoneInfo);
  private readonly msActions = inject(MilestoneActions);
  protected readonly actions = inject(WsActions);

  protected readonly leftW = LEFT_W;
  protected readonly headH = HEAD_H;
  protected readonly rowH = ROW_H;
  protected readonly groupH = GROUP_H;
  protected readonly zooms = ZOOMS;
  protected readonly hatch = HATCH;
  protected readonly presets = DATE_PRESETS;
  protected readonly statuses = statusOptions();
  protected readonly teamIcon = LucideLayers;
  protected readonly userIcon = LucideUserRound;
  protected readonly groupIcon = LucideLayers;
  protected readonly ganttIcon = LucideChartGantt;
  protected readonly schedIcon = LucideCalendarPlus;
  protected readonly xIcon = LucideX;
  protected readonly today = todayDay();
  protected readonly todayLabel = format(new Date(), 'MMM d');
  protected readonly mixed = mix;

  protected readonly zoom = signal<Zoom>('week');
  protected readonly teamFilter = signal<string[]>([]);
  protected readonly statusFilter = signal<string[]>([]);
  protected readonly userFilter = signal<string[]>([]);
  protected readonly groupByTeam = signal(false);
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());
  protected readonly panelId = signal<string | null>(null);
  protected readonly preview = signal<Preview | null>(null);
  protected readonly ctx = signal<{ ws: Workstream; day: number } | null>(null);

  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private suppressClick = false;
  private didScroll = false;
  private stopDrag: (() => void) | null = null;

  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly filtered = computed(() => this.teamFilter().length + this.statusFilter().length + this.userFilter().length > 0);
  protected readonly px = computed(() => ZOOMS.find((z) => z.id === this.zoom())!.pxPerDay);
  protected readonly panelWs = computed(() => this.store.getWorkstream(this.panelId()));

  // ───────── data ─────────

  private readonly visible = computed(() => {
    const teams = this.teamFilter();
    const statuses = this.statusFilter();
    const users = this.userFilter();
    return this.store.workstreams().filter(
      (w) =>
        (!teams.length || teams.includes(w.ownerTeamId)) &&
        (!statuses.length || statuses.includes(w.status)) &&
        (!users.length || (!!w.accountableUserId && users.includes(w.accountableUserId))),
    );
  });
  protected readonly anyDated = computed(() => this.store.workstreams().some((w) => w.startDate || w.targetDate));

  private readonly ranges = computed<Range[]>(() => {
    const byWs = this.store.milestonesByWorkstream();
    return this.visible()
      .filter((w) => w.startDate || w.targetDate)
      .map((ws) => {
        const start = dayOf(ws.startDate ?? ws.createdAt);
        const end = ws.targetDate ? dayOf(ws.targetDate) : ws.status === 'shipped' ? dayOf(ws.shippedAt ?? ws.updatedAt) : null;
        const marks = (byWs.get(ws.id) ?? []).filter((m) => m.targetDate).map((ms) => ({ ms, day: dayOf(ms.targetDate!) }));
        return { ws, start, end, marks };
      })
      .sort((a, b) => a.start - b.start || a.ws.number - b.ws.number);
  });
  private readonly loose = computed(() => this.visible().filter((w) => !w.startDate && !w.targetDate));

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

  private readonly bars = computed<Bar[]>(() => {
    const p = this.preview();
    const px = this.px();
    const today = this.today;
    const stats = this.info.stats();
    const states = this.info.states();
    return this.ranges().map((r) => {
      const ws = r.ws;
      let start = r.start;
      let end = r.end;
      if (p?.kind === 'ws' && p.id === ws.id) {
        start = p.start;
        end = p.end;
      }
      const visEnd = Math.max(start, end ?? Math.max(today, start + 14));
      const left = this.x(start);
      const width = Math.max(10, this.x(visEnd) - left);
      const finished = ws.status === 'shipped' || ws.status === 'canceled';
      const c = issueCounts(this.store.issuesByWorkstream().get(ws.id) ?? []);
      const criteria = ws.acceptanceCriteria;
      const progress = ws.status === 'shipped' ? 1 : c.issuesTotal ? c.issuesDone / c.issuesTotal : criteria.length ? criteria.filter((k) => k.state === 'met').length / criteria.length : 0;
      const marks = r.marks
        .map((m) => {
          const day = p?.kind === 'ms' && p.id === m.ms.id ? p.day : m.day;
          const st = stats.get(m.ms.id);
          return { ms: m.ms, day, x: this.x(day), labelW: 140, fraction: st?.fraction ?? 0, state: states.get(m.ms.id) ?? 'idle' } as MsMark;
        })
        .sort((a, b) => a.x - b.x);
      marks.forEach((m, i) => (m.labelW = Math.min(140, (marks[i + 1] ? marks[i + 1].x - m.x : 140) - 16)));
      const range = end === null ? `${dayLabel(start)} → no target date` : `${dayLabel(start)} → ${dayLabel(end)}`;
      return {
        ws,
        start,
        end,
        left,
        width,
        open: end === null,
        overdueLeft: end !== null && end < today && !finished ? this.x(end) : null,
        overdueW: end !== null ? Math.max(0, (today - end) * px) : 0,
        progress,
        tone: STATUS_TONE[ws.status],
        editable: this.store.canEditTeamWork(ws.ownerTeamId),
        marks,
        tip: `${ws.key} · ${ws.title} · ${WORKSTREAM_STATUS_META[ws.status].label} · ${range} · ${Math.round(progress * 100)}%`,
        dragging: !!p && ((p.kind === 'ws' && p.id === ws.id) || (p.kind === 'ms' && marks.some((m) => m.ms.id === p.id))),
      };
    });
  });
  protected readonly barCount = computed(() => this.bars().length + this.loose().length);

  protected readonly rows = computed<Row[]>(() => {
    const out: Row[] = [];
    const bars = this.bars();
    if (this.groupByTeam()) {
      const collapsed = this.collapsed();
      for (const team of this.store.teams()) {
        const mine = bars.filter((b) => b.ws.ownerTeamId === team.id);
        if (!mine.length) continue;
        const isCollapsed = collapsed.has(team.id);
        out.push({ kind: 'group', id: 'g:' + team.id, team, count: mine.length, collapsed: isCollapsed });
        if (!isCollapsed) for (const bar of mine) out.push({ kind: 'bar', id: bar.ws.id, bar });
      }
    } else for (const bar of bars) out.push({ kind: 'bar', id: bar.ws.id, bar });
    const loose = this.loose();
    if (loose.length) {
      out.push({ kind: 'loose-head', id: 'loose-head', count: loose.length });
      for (const ws of loose) out.push({ kind: 'loose', id: 'l:' + ws.id, ws });
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

  protected toggleGroup(id: string): void {
    const teamId = id.slice(2);
    this.collapsed.update((s) => {
      const n = new Set(s);
      if (!n.delete(teamId)) n.add(teamId);
      return n;
    });
  }

  protected clearFilters(): void {
    this.teamFilter.set([]);
    this.statusFilter.set([]);
    this.userFilter.set([]);
  }

  // ───────── helpers ─────────

  protected pct(b: Bar): number {
    return Math.round(b.progress * 100);
  }
  protected dayText(day: number): string {
    return dayLabel(day);
  }
  protected canEditWs(ws: Workstream): boolean {
    return this.store.canEditTeamWork(ws.ownerTeamId);
  }
  protected open(ws: Workstream): void {
    void this.router.navigate(['/', this.slug(), 'workstreams', ws.key]);
  }
  protected barClick(ws: Workstream): void {
    if (this.suppressClick) return;
    this.panelId.update((id) => (id === ws.id ? null : ws.id));
  }

  /** Calendar day under a pointer position (for the context menu). */
  protected setCtx(ev: MouseEvent, ws: Workstream): void {
    const el = this.scroller()?.nativeElement;
    let day = this.today;
    if (el) {
      const rect = el.getBoundingClientRect();
      day = this.scale().startDay + Math.floor((ev.clientX - rect.left + el.scrollLeft - LEFT_W) / this.px());
    }
    this.ctx.set({ ws, day });
  }

  // ───────── editing ─────────

  protected setStart(ws: Workstream, d: Date | null): void {
    const before = ws.startDate ?? null;
    const iso = d ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString() : null;
    void this.store.updateWorkstream(ws.id, { startDate: iso });
    this.notify.success(d ? 'Start date updated' : 'Start date cleared', { action: { label: 'Undo', run: () => void this.store.updateWorkstream(ws.id, { startDate: before }) } });
  }

  protected schedule(ws: Workstream): void {
    const patch = { startDate: isoOfDay(this.today), targetDate: isoOfDay(this.today + 14) };
    void this.store.updateWorkstream(ws.id, patch);
    this.notify.success(`${ws.key} scheduled`, {
      description: `${dayLabel(this.today)} → ${dayLabel(this.today + 14)}`,
      action: { label: 'Undo', run: () => void this.store.updateWorkstream(ws.id, { startDate: null, targetDate: null }) },
    });
  }

  protected async addMilestone(ws: Workstream, day: number): Promise<void> {
    const n = (this.store.milestonesByWorkstream().get(ws.id)?.length ?? 0) + 1;
    const ms = await this.msActions.create(ws.id, `Milestone ${n}`, isoOfDay(day));
    if (ms) {
      this.panelId.set(ws.id);
      this.notify.success(`Milestone added to ${ws.key}`, { description: `On ${dayLabel(day)}. Rename it in the details panel.` });
    }
  }

  /** Drag a bar (`move`) or one of its edges. */
  protected dragWs(ev: PointerEvent, b: Bar, mode: 'move' | 'start' | 'end'): void {
    if (!b.editable) return;
    if (mode !== 'move') ev.stopPropagation();
    const base = { start: b.start, end: b.end, visEnd: Math.max(b.start, b.end ?? Math.max(this.today, b.start + 14)) };
    this.beginDrag(
      ev,
      (d) => {
        if (mode === 'move') return { kind: 'ws', id: b.ws.id, start: base.start + d, end: base.end === null ? null : base.end + d };
        if (mode === 'start') return { kind: 'ws', id: b.ws.id, start: Math.min(base.start + d, base.visEnd - 1), end: base.end };
        return { kind: 'ws', id: b.ws.id, start: base.start, end: Math.max(base.visEnd + d, base.start + 1) };
      },
      (p) => {
        if (p.kind !== 'ws') return;
        const ws = b.ws;
        const before = { startDate: ws.startDate ?? null, targetDate: ws.targetDate ?? null };
        const patch: { startDate?: string; targetDate?: string } = {};
        if (mode !== 'end' && p.start !== base.start) patch.startDate = isoOfDay(p.start);
        if (mode === 'end' && p.end !== null) patch.targetDate = isoOfDay(p.end);
        if (mode === 'move' && p.end !== null && ws.targetDate) patch.targetDate = isoOfDay(p.end);
        if (!Object.keys(patch).length) return;
        void this.store.updateWorkstream(ws.id, patch);
        this.notify.success(`${ws.key} rescheduled`, {
          description: `${dayLabel(p.start)} → ${p.end === null ? 'no target date' : dayLabel(p.end)}`,
          action: { label: 'Undo', run: () => void this.store.updateWorkstream(ws.id, before) },
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
