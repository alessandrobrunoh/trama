// Flow layout of the task table: a kanban turned sideways that shows time.
// Columns are the workspace's statuses; each task is a row with a track through the statuses it has been in,
// every segment as long as the stay (see issue-flow-model.ts). The board owns filters, sort, group, selection
// and the context menu; this file only draws the rows and forwards what the user does.
import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  TemplateRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  LucideCheck,
  LucideChevronDown,
  LucideChevronRight,
  LucideCornerDownRight,
  LucideDynamicIcon,
} from '@lucide/angular';
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { TramaStore, UiStore, fullDate, type Issue, type IssueStatus, type StatusEntry } from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { ActorAvatar } from '../../shared/actor-avatar';
import { StatusIcon } from '../../shared/status';
import {
  IDLE_DAYS,
  SCALE_CAP_DAYS,
  buildTrack,
  columnIndex,
  formatSpan,
  idleLabel,
  layoutStays,
  linkSegments,
  type FlowGeometry,
  type FlowLink,
  type FlowSegment,
  type FlowTrack,
} from './issue-flow-model';
import type { IssueTreeRow } from './issue-tree';
import { PreviewLink, isTaskPreviewed } from './list-preview';

/** Width of one status column, px. */
const COL = 128;
const GEO: FlowGeometry = { colWidth: COL, pad: 6, minLen: 10 };
/** Height of a row's drawing, px. */
const DRAW_H = 40;
/** Room after the last column for the "idle 9d" flag of a task that sits there. */
const TRAIL = 88;
const BAR_H = 8;
const FALLBACK_COLOR = 'var(--muted-foreground)';

export interface FlowGroup {
  key: string;
  items: readonly IssueTreeRow[];
  /** Real matches (context rows are not counted). */
  count: number;
}

interface Tip {
  index: number;
  x: number;
  y: number;
}

/** One task: its label on the left (sticky while the chart scrolls) and its track across the status columns. */
@Component({
  selector: 'app-flow-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PreviewLink, HlmContextMenuImports, ActorAvatar, StatusIcon, LucideDynamicIcon],
  host: { class: 'block w-max min-w-full', '(mouseenter)': 'onEnter($event)' },
  template: `
    @let i = row().issue;
    <div
      class="group/row relative flex h-10 items-stretch text-[13px] max-md:h-11"
      [class.opacity-55]="row().ghost"
      [attr.data-row-id]="row().ghost ? null : i.id"
      [attr.data-depth]="depth()"
      [hlmContextMenuTrigger]="menu()"
      [hlmContextMenuTriggerData]="{ $implicit: i }"
      [disabled]="!canEdit() || row().ghost"
      (pointermove)="onMove($event)"
      (pointerleave)="tip.set(null)"
    >
      <a
        [appPreviewLink]="['/', slug(), 'tasks', i.key]"
        class="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset"
        [attr.aria-label]="summary()"
        [attr.aria-current]="previewed() ? 'true' : null"
        (preview)="preview()"
        (click)="onLinkClick($event)"
      ></a>

      <!-- label: sticky while the chart scrolls sideways; clicks fall through to the link above -->
      <div
        class="bg-background pointer-events-none sticky left-0 z-[2] flex shrink-0 items-center gap-1.5 pr-2 pl-3 sm:pl-5"
        style="width: var(--flow-label)"
      >
        <span class="pointer-events-none absolute inset-0" [class]="state()"></span>
        @if (selectable()) {
          <span class="pointer-events-auto relative -ml-1 flex w-4 shrink-0 justify-center max-sm:hidden">
            <button
              type="button"
              role="checkbox"
              [attr.aria-checked]="selected()"
              [attr.aria-label]="'Select ' + i.key"
              class="border-input flex size-3.5 items-center justify-center rounded-[4px] border transition-opacity focus-visible:opacity-100"
              [class]="
                selected()
                  ? 'bg-primary border-primary text-primary-foreground opacity-100'
                  : selecting()
                    ? 'bg-background opacity-100'
                    : 'bg-background opacity-0 group-hover/row:opacity-100'
              "
              (click)="onCheck($event)"
            >
              @if (selected()) {
                <svg [lucideIcon]="check" [size]="10" [strokeWidth]="3"></svg>
              }
            </button>
          </span>
        }
        @if (nested()) {
          <span class="pointer-events-none shrink-0" [style.width.px]="row().depth * 14" aria-hidden="true"></span>
          <span class="pointer-events-auto relative -mr-0.5 flex size-5 shrink-0 items-center justify-center">
            @if (row().childCount > 0) {
              <button
                type="button"
                class="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring flex size-5 items-center justify-center rounded outline-none focus-visible:ring-2"
                [attr.aria-expanded]="row().expanded"
                [attr.aria-label]="(row().expanded ? 'Collapse' : 'Expand') + ' sub-tasks of ' + i.key"
                (click)="onToggle($event)"
                (dblclick)="$event.stopPropagation()"
              >
                <svg [lucideIcon]="row().expanded ? chevronDown : chevronRight" [size]="13"></svg>
              </button>
            }
          </span>
        }
        <span class="relative flex min-w-0 flex-1 items-center gap-2 max-sm:flex-col max-sm:items-start max-sm:gap-0">
          <span
            class="text-muted-foreground shrink-0 font-mono text-xs max-sm:order-2 max-sm:text-[10px] max-sm:leading-3 sm:w-[4.25rem] sm:truncate"
            >{{ i.key }}</span
          >
          <span class="min-w-0 max-w-full truncate max-sm:leading-4" [class.text-muted-foreground]="track().closed">{{
            i.title
          }}</span>
        </span>
        @if (row().childCount > 0 && !row().expanded) {
          <span
            class="text-muted-foreground relative flex shrink-0 items-center gap-0.5 text-xs tabular-nums"
            [attr.aria-label]="row().childCount + (row().childCount === 1 ? ' sub-task' : ' sub-tasks')"
          >
            <svg [lucideIcon]="subtaskIcon" [size]="11" aria-hidden="true"></svg>{{ row().childCount }}
          </span>
        }
        @if (i.assigneeId) {
          <app-actor-avatar class="relative" [actor]="{ type: 'user', id: i.assigneeId }" [size]="18" />
        } @else {
          <span class="size-[18px] shrink-0" aria-hidden="true"></span>
        }
      </div>

      <!-- track: one segment per stay, laid over the column hairlines -->
      <div
        #trackEl
        class="pointer-events-none relative shrink-0"
        [class]="state()"
        [style.width.px]="trackWidth()"
        [style.background-image]="'linear-gradient(to right, var(--border) 1px, transparent 1px)'"
        [style.background-size]="colWidth + 'px 100%'"
        aria-hidden="true"
      >
        <svg
          class="absolute left-0 top-1/2 -translate-y-1/2 overflow-visible"
          [attr.width]="trackWidth()"
          [attr.height]="drawHeight"
        >
          @for (l of links(); track $index) {
            <path
              [attr.d]="linkPath(l)"
              fill="none"
              stroke="var(--muted-foreground)"
              stroke-opacity="0.5"
              stroke-width="1.5"
              stroke-linecap="round"
              [attr.stroke-dasharray]="l.backward ? '3 3' : null"
            />
          }
          @for (s of segments(); track $index; let last = $last) {
            @let c = color(s.column);
            @if (s.terminal) {
              <circle [attr.cx]="s.x + 7" [attr.cy]="cy(s.lane)" r="7" [attr.fill]="c" [attr.fill-opacity]="tip()?.index === $index ? 0.85 : 1" />
              @if (track().closed === 'canceled') {
                <path
                  [attr.d]="'M' + (s.x + 4.5) + ' ' + (cy(s.lane) - 2.5) + 'l5 5m0 -5l-5 5'"
                  stroke="var(--background)"
                  stroke-width="1.6"
                  stroke-linecap="round"
                  fill="none"
                />
              } @else {
                <path
                  [attr.d]="'M' + (s.x + 4) + ' ' + (cy(s.lane) + 0.2) + 'l2.2 2.4l3.8 -4.6'"
                  stroke="var(--background)"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  fill="none"
                />
              }
            } @else {
              <rect
                [attr.x]="s.x"
                [attr.y]="cy(s.lane) - barH / 2"
                [attr.width]="s.width"
                [attr.height]="barH"
                rx="4"
                [attr.fill]="c"
                [attr.fill-opacity]="tip()?.index === $index ? 0.9 : last ? 1 : 0.5"
              />
              @if (last) {
                <circle
                  [attr.cx]="s.x + s.width"
                  [attr.cy]="cy(s.lane)"
                  r="8.5"
                  fill="none"
                  [attr.stroke]="c"
                  stroke-opacity="0.35"
                  stroke-width="2"
                />
                <circle
                  [attr.cx]="s.x + s.width"
                  [attr.cy]="cy(s.lane)"
                  r="4.5"
                  [attr.fill]="c"
                  stroke="var(--background)"
                  stroke-width="1.5"
                />
              }
            }
          }
        </svg>
        @if (idle(); as label) {
          <span
            class="idle-flag absolute top-1/2 -translate-y-1/2 rounded-full px-1.5 py-px text-[11px] leading-4 font-medium whitespace-nowrap tabular-nums"
            [style.left.px]="idleLeft()"
            >{{ label }}</span
          >
        }
        @if (track().stays.length === 0) {
          <span class="text-muted-foreground absolute top-1/2 left-2 -translate-y-1/2 text-xs">No status history</span>
        }
      </div>
    </div>

    @if (tip(); as t) {
      @if (segments()[t.index]; as s) {
        <div
          class="bg-popover text-popover-foreground border-border pointer-events-none fixed z-50 w-max max-w-64 rounded-md border px-2.5 py-2 text-xs shadow-md"
          [style.left.px]="tipLeft(t)"
          [style.top.px]="t.y"
          style="transform: translateY(calc(-100% - 12px))"
          role="tooltip"
        >
          <div class="flex items-center gap-1.5 font-medium">
            <app-status-icon entity="issue" [status]="statusId(s.column)" [size]="13" />
            {{ statusName(s.column) }}
          </div>
          <dl class="text-muted-foreground mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <dt>Entered</dt>
            <dd class="text-popover-foreground text-right tabular-nums">{{ enteredOn(s) }}</dd>
            <dt>Time</dt>
            <dd class="text-popover-foreground text-right tabular-nums">{{ timeText(s) }}</dd>
          </dl>
          @if (!track().fromHistory) {
            <div class="text-muted-foreground mt-1.5 border-t border-border pt-1.5">Estimated from the task's dates</div>
          }
        </div>
      }
    }
  `,
  styles: `
    .idle-flag {
      color: var(--tone-amber);
      background: color-mix(in oklab, var(--tone-amber) 16%, transparent);
    }
  `,
})
export class FlowRow {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly pane = inject(RightPaneStore);

  readonly row = input.required<IssueTreeRow>();
  readonly track = input.required<FlowTrack>();
  readonly statuses = input.required<readonly StatusEntry<IssueStatus>[]>();
  readonly menu = input.required<TemplateRef<unknown>>();
  readonly nested = input(false);
  readonly selected = input(false);
  readonly selectable = input(false);
  readonly selecting = input(false);
  readonly canEdit = input(false);
  readonly toggleExpand = output<void>();
  readonly toggleSelect = output<MouseEvent>();

  protected readonly colWidth = COL;
  protected readonly drawHeight = DRAW_H;
  protected readonly barH = BAR_H;
  protected readonly trackWidth = computed(() => FlowRow.trackWidthFor(this.statuses().length));
  protected readonly check = LucideCheck;
  protected readonly chevronDown = LucideChevronDown;
  protected readonly chevronRight = LucideChevronRight;
  protected readonly subtaskIcon = LucideCornerDownRight;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly tip = signal<Tip | null>(null);

  protected readonly previewed = computed(() => isTaskPreviewed(this.pane, this.row().issue));
  private readonly focused = computed(() => this.ui.focusedRowId() === this.row().issue.id);
  protected readonly state = computed(() =>
    this.selected() || this.previewed()
      ? 'bg-selected'
      : this.focused()
        ? 'bg-hover'
        : 'group-hover/row:bg-hover',
  );
  protected readonly depth = computed(() => (this.nested() ? this.row().depth : null));

  protected readonly segments = computed<FlowSegment[]>(() => layoutStays(this.track().stays, GEO));
  protected readonly links = computed(() => linkSegments(this.segments()));
  /** Rows where the task came back to a status draw their two lanes apart. */
  private readonly lanes = computed(() => this.segments().some((s) => s.lane > 0));
  protected readonly idle = computed(() => idleLabel(this.track()));
  protected readonly idleLeft = computed(() => {
    const last = this.segments()[this.segments().length - 1];
    return last ? last.x + last.width + 16 : 0;
  });
  protected readonly summary = computed(() => {
    const i = this.row().issue;
    const path = this.track()
      .stays.map((s) => `${this.statusName(s.column)}${s.terminal ? '' : ' ' + formatSpan(s.durationMs)}`)
      .join(', then ');
    const idle = this.idle();
    return `${i.key} ${i.title}${path ? '. ' + path : ''}${idle ? '. ' + idle : ''}`;
  });

  /** Width of a track: every status column plus room after the last for the idle flag. */
  static trackWidthFor(columns: number): number {
    return columns * COL + TRAIL;
  }

  protected statusId(column: number): string {
    return this.statuses()[column]?.id ?? '';
  }

  protected statusName(column: number): string {
    return this.statuses()[column]?.name ?? '';
  }

  protected color(column: number): string {
    return this.statuses()[column]?.color ?? FALLBACK_COLOR;
  }

  /** Vertical centre of a lane inside the drawing. */
  protected cy(lane: number): number {
    if (!this.lanes()) return DRAW_H / 2;
    return lane === 0 ? 13 : 27;
  }

  protected linkPath(l: FlowLink): string {
    const y1 = this.cy(l.fromLane);
    const y2 = this.cy(l.toLane);
    if (l.backward) {
      const dip = Math.max(y1, y2) + 12;
      return `M${l.from} ${y1} C${l.from + 14} ${dip} ${l.to - 14} ${dip} ${l.to} ${y2}`;
    }
    if (y1 === y2) return `M${l.from} ${y1} H${l.to}`;
    const mid = (l.from + l.to) / 2;
    return `M${l.from} ${y1} C${mid} ${y1} ${mid} ${y2} ${l.to} ${y2}`;
  }

  protected enteredOn(s: FlowSegment): string {
    return fullDate(new Date(s.enteredAt).toISOString());
  }

  protected timeText(s: FlowSegment): string {
    if (s.terminal) return 'Final status';
    return s.leftAt === null ? `${formatSpan(s.durationMs)} so far` : formatSpan(s.durationMs);
  }

  protected tipLeft(t: Tip): number {
    return Math.max(8, Math.min(t.x + 14, (globalThis.innerWidth ?? 1024) - 272));
  }

  // ───────────────────────── pointer and keyboard ─────────────────────────

  private readonly trackEl = viewChild<ElementRef<HTMLElement>>('trackEl');

  /** Which segment is under the pointer: the track is a drawing, so it is hit-tested here. */
  protected onMove(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    const el = this.trackEl()?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top - (rect.height - DRAW_H) / 2;
    let best = -1;
    let bestDy = Number.POSITIVE_INFINITY;
    this.segments().forEach((s, index) => {
      const w = s.terminal ? 14 : s.width;
      if (px < s.x - 3 || px > s.x + w + 3) return;
      const dy = Math.abs(py - this.cy(s.lane));
      if (dy < bestDy) {
        best = index;
        bestDy = dy;
      }
    });
    this.tip.set(best >= 0 && bestDy <= 14 ? { index: best, x: e.clientX, y: e.clientY } : null);
  }

  protected onEnter(e: MouseEvent): void {
    // Moving over rows during a drag must not change the keyboard action target.
    if (e.buttons === 0 && !this.row().ghost) this.ui.setFocusedRow(this.row().issue.id);
  }

  /** A single click shows the task in the right pane (a double click or Enter opens it: see `PreviewLink`). */
  protected preview(): void {
    const issue: Issue = this.row().issue;
    this.ui.setFocusedRow(issue.id);
    this.pane.show({ kind: 'task', idOrKey: issue.key });
  }

  protected onLinkClick(e: MouseEvent): void {
    if (e.shiftKey && this.selectable()) {
      e.preventDefault();
      this.toggleSelect.emit(e);
    }
  }

  protected onCheck(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.toggleSelect.emit(e);
  }

  protected onToggle(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.toggleExpand.emit();
  }
}

/** The Flow layout: legend, status header, and the rows in sections when grouped. */
@Component({
  selector: 'app-issue-flow',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, FlowRow, StatusIcon, LucideDynamicIcon],
  host: { class: 'flex min-h-0 min-w-0 flex-1 flex-col' },
  styles: `
    /* Width of the sticky task label; narrower on phones so the chart keeps room. */
    :host {
      --flow-label: 22rem;
    }
    @media (max-width: 639px) {
      :host {
        --flow-label: 11.5rem;
      }
    }
    .idle-flag {
      color: var(--tone-amber);
      background: color-mix(in oklab, var(--tone-amber) 16%, transparent);
    }
  `,
  template: `
    <!-- How to read it -->
    <div
      class="text-meta flex shrink-0 items-center gap-x-4 gap-y-1.5 px-4 pb-2 sm:flex-wrap sm:px-6 max-sm:overflow-x-auto max-sm:whitespace-nowrap"
      role="note"
      aria-label="How to read the Flow layout"
    >
      <span>Each row is a task moving through the statuses, left to right.</span>
      <span class="flex shrink-0 items-center gap-1.5">
        <svg width="38" height="10" viewBox="0 0 38 10" aria-hidden="true">
          <rect x="0" y="3" width="8" height="4" rx="2" fill="currentColor" fill-opacity="0.5" />
          <rect x="12" y="3" width="26" height="4" rx="2" fill="currentColor" fill-opacity="0.5" />
        </svg>
        Length is time in status (full at {{ capDays }}d)
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-opacity="0.4" stroke-width="1.5" />
          <circle cx="8" cy="8" r="3.6" fill="currentColor" stroke="var(--background)" stroke-width="1.2" />
        </svg>
        Now
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path d="M4.8 8.2l2.2 2.4l4.2 -4.8" stroke="var(--background)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none" />
        </svg>
        Finished
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        <span class="idle-flag rounded-full px-1.5 py-px text-[11px] leading-4 font-medium">idle {{ idleDays }}d</span>
        Open {{ idleDays }}d or more in one status
      </span>
      <span class="flex shrink-0 items-center gap-1.5">
        <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden="true">
          <path d="M1 3 C8 12 18 12 25 3" fill="none" stroke="currentColor" stroke-opacity="0.6" stroke-width="1.5" stroke-dasharray="3 3" stroke-linecap="round" />
        </svg>
        Moved back
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto" role="list" aria-label="Tasks by status over time">
      <div class="w-max min-w-full pb-6">
        <!-- status header -->
        <div class="bg-background sticky top-0 z-[4] flex h-8 w-max min-w-full items-stretch text-xs">
          <div
            class="bg-background text-muted-foreground sticky left-0 z-[5] flex shrink-0 items-center pl-3 sm:pl-5"
            style="width: var(--flow-label)"
          >
            Task
          </div>
          <div
            class="relative flex shrink-0"
            [style.width.px]="trackWidth()"
            [style.background-image]="'linear-gradient(to right, var(--border) 1px, transparent 1px)'"
            [style.background-size]="colWidth + 'px 100%'"
          >
            @for (s of statuses(); track s.id; let n = $index) {
              <div class="text-muted-foreground flex shrink-0 items-center gap-1.5 px-2" [style.width.px]="colWidth">
                <app-status-icon entity="issue" [status]="s.id" [size]="13" />
                <span class="truncate">{{ s.name }}</span>
                <span class="tabular-nums opacity-70">{{ counts()[n] }}</span>
              </div>
            }
          </div>
          <span class="bg-border pointer-events-none absolute inset-x-0 bottom-0 h-px" aria-hidden="true"></span>
        </div>

        @for (g of groups(); track g.key) {
          <section>
            @if (grouped()) {
              <div class="bg-background sticky left-0 z-[3] mt-1 flex min-h-8 w-fit items-center">
                <button
                  type="button"
                  class="text-muted-foreground flex min-h-8 min-w-0 items-center gap-2 px-4 text-left text-[13px] outline-none focus-visible:underline sm:px-5"
                  [attr.aria-expanded]="!collapsed().has(g.key)"
                  (click)="toggleGroup(g.key)"
                >
                  <svg [lucideIcon]="collapsed().has(g.key) ? right : down" [size]="13" class="shrink-0"></svg>
                  <ng-container *ngTemplateOutlet="groupLabel(); context: { $implicit: g.key }" />
                  <span class="text-muted-foreground text-xs tabular-nums">{{ g.count }}</span>
                </button>
              </div>
            }
            @if (!collapsed().has(g.key)) {
              @for (r of g.items; track r.id) {
                <app-flow-row
                  [row]="r"
                  [track]="tracks().get(r.issue.id)!"
                  [statuses]="statuses()"
                  [menu]="menu()"
                  [nested]="nested()"
                  [selected]="selected().has(r.issue.id)"
                  [selectable]="selectable() && !r.ghost"
                  [selecting]="selecting()"
                  [canEdit]="canEdit()"
                  (toggleExpand)="toggleExpand.emit(r.id)"
                  (toggleSelect)="toggleSelect.emit({ issue: r.issue, event: $event })"
                />
              }
            }
          </section>
        }
      </div>
    </div>
  `,
})
export class IssueFlow {
  private readonly store = inject(TramaStore);

  readonly groups = input.required<readonly FlowGroup[]>();
  /** Sections with a header; false for a single list. */
  readonly grouped = input(true);
  readonly statuses = input.required<readonly StatusEntry<IssueStatus>[]>();
  readonly nested = input(false);
  readonly selected = input<ReadonlySet<string>>(new Set());
  readonly selectable = input(false);
  readonly selecting = input(false);
  readonly canEdit = input(false);
  /** The board's right-click menu and group label, drawn by the board so both layouts stay in step. */
  readonly menu = input.required<TemplateRef<unknown>>();
  readonly groupLabel = input.required<TemplateRef<{ $implicit: string }>>();
  readonly toggleExpand = output<string>();
  readonly toggleSelect = output<{ issue: Issue; event: MouseEvent }>();

  protected readonly colWidth = COL;
  protected readonly capDays = SCALE_CAP_DAYS;
  protected readonly idleDays = IDLE_DAYS;
  protected readonly down = LucideChevronDown;
  protected readonly right = LucideChevronRight;
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected readonly trackWidth = computed(() => FlowRow.trackWidthFor(this.statuses().length));

  /** Every task's track, computed once per change of tasks or events (not per row render). */
  protected readonly tracks = computed(() => {
    const columns = this.statuses();
    const events = this.store.eventsBySubject();
    const now = Date.now();
    const map = new Map<string, FlowTrack>();
    for (const g of this.groups()) {
      for (const r of g.items) {
        if (!map.has(r.issue.id)) map.set(r.issue.id, buildTrack(r.issue, events.get(`issue:${r.issue.id}`) ?? [], columns, now));
      }
    }
    return map;
  });

  /** Tasks in each status right now, for the header. */
  protected readonly counts = computed(() => {
    const columns = this.statuses();
    const out = columns.map(() => 0);
    const seen = new Set<string>();
    for (const g of this.groups()) {
      for (const r of g.items) {
        if (r.ghost || seen.has(r.issue.id)) continue;
        seen.add(r.issue.id);
        const n = columnIndex(columns, r.issue.status);
        if (n >= 0) out[n]++;
      }
    }
    return out;
  });

  protected toggleGroup(key: string): void {
    this.collapsed.update((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
}
