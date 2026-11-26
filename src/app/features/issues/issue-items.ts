// Issue list row and board card. The whole row/card is a link (an absolutely positioned <a>);
// property glyphs sit above it and open inline pickers.
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Directive,
  ElementRef,
  NgZone,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideCheck,
  LucideChevronDown,
  LucideChevronRight,
  LucideCornerDownRight,
  LucideDynamicIcon,
  LucideFlag,
  LucideRotateCcw,
  LucideUserPlus,
  LucideUserRoundX,
} from '@lucide/angular';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { TramaStore, UiStore, Viewport, fullDate, haptic, shortDate, type Issue } from '../../core';
import { PriorityIcon } from '../../shared/priority-icon';
import { SwipeRow } from '../../shared/swipe-row';
import { V3Source, V3Thread, sourceRef } from '../../shared/v3';
import type { IssueProp as IssuePropName } from './issue-model';
import { isClosedIssue, quietToggleStatus } from './issue-model';
import { IssueActions } from './issue-actions';
import { IssueCell } from './issue-cells';
import { IssueProp } from './issue-prop';
import { TaskChildren } from './task-children';

/** Shared bits of row + card. */
@Directive()
abstract class IssueItemBase {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  protected readonly actions = inject(IssueActions);
  readonly issue = input.required<Issue>();
  // Keep focus consumption in the item: a hover must not recheck every binding on the board.
  protected readonly focused = computed(() => this.ui.focusedRowId() === this.issue().id);
  readonly selected = input(false);
  /** Show selection checkboxes (on hover, or always while something is selected). */
  readonly selectable = input(false);
  /** Some row is selected: checkboxes stay visible. */
  readonly selecting = input(false);
  /** Properties hidden through display options. */
  readonly hidden = input<readonly IssuePropName[]>([]);
  /** Which date the date column shows: the due date, or when the task was last updated / created. */
  readonly dateField = input<'dueDate' | 'updatedAt' | 'createdAt'>('dueDate');
  /** Checkbox click or shift-click: the board decides (toggle / range). */
  readonly toggleSelect = output<MouseEvent>();

  protected readonly check = LucideCheck;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly quiet = computed(() => isClosedIssue(this.issue(), this.store.settings().statuses.issue));
  protected readonly show = computed(() => {
    const h = new Set(this.hidden());
    return {
      estimate: !h.has('estimate'),
      assignee: !h.has('assignee'),
      date: !h.has('date'),
    };
  });
  /** Shown when the issue is estimated and the workspace still uses estimates (or the value is kept anyway). */
  protected readonly hasEstimate = computed(() => this.issue().estimate !== undefined && this.issue().estimate !== null);
  /** The estimate cell: an estimated task keeps it; others get an empty cell people can click while estimates are on. */
  protected readonly showEstimate = computed(
    () =>
      this.show().estimate &&
      (this.hasEstimate() || (this.store.estimateScale() !== 'none' && this.store.can('member'))),
  );
  protected readonly date = computed(() => shortDate(this.issue()[this.dateField()]) || '—');
  protected readonly dateTitle = computed(() => {
    const field = this.dateField();
    const iso = this.issue()[field];
    const what = field === 'dueDate' ? 'Due' : field === 'createdAt' ? 'Created' : 'Updated';
    return iso ? `${what} ${fullDate(iso)}` : 'No due date';
  });
  /** A due date in the past on a task that is still open. */
  protected readonly overdue = computed(() => {
    const due = this.issue().dueDate;
    return this.dateField() === 'dueDate' && !!due && !this.quiet() && differenceInCalendarDays(parseISO(due), new Date()) < 0;
  });
  private readonly children = inject(TaskChildren);
  /** Sub-tasks of the task (all of them, wherever they sit) and how many are finished. */
  protected readonly subTotal = computed(() => this.children.of(this.issue().id).length);
  protected readonly subDone = computed(() => {
    const entries = this.store.settings().statuses.issue;
    return this.children.of(this.issue().id).filter((c) => isClosedIssue(c, entries)).length;
  });
  /** Where the source chip links to (the GitHub / GitLab / Jira item), when it came from one. */
  protected readonly sourceUrl = computed(() => sourceRef(this.issue()).url);

  constructor() {
    const element = inject(ElementRef<HTMLElement>).nativeElement;
    const enter = (event: MouseEvent): void => {
      // Moving over other cards during a drag must not change the keyboard action target.
      if (event.buttons === 0) this.ui.setFocusedRow(this.issue().id);
    };
    // A template listener also marks the owning board dirty, even with OnPush.
    inject(NgZone).runOutsideAngular(() => element.addEventListener('mouseenter', enter));
    inject(DestroyRef).onDestroy(() => element.removeEventListener('mouseenter', enter));
  }

  /** Shift-click selects a range; a plain click follows the link. */
  protected onLinkClick(e: MouseEvent): void {
    if (e.shiftKey && this.selectable()) {
      e.preventDefault();
      this.toggleSelect.emit(e);
    }
  }

  /**
   * Double click opens the task page. The row link handles its own clicks; this covers the parts of the
   * row that sit above it (chips, estimate, spacing). Pickers and buttons keep their own double clicks.
   */
  protected onDblClick(e: MouseEvent): void {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if ((e.target as HTMLElement | null)?.closest('a, button, input, textarea, [role="checkbox"]')) return;
    this.actions.open(this.issue());
  }

  protected onCheck(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.toggleSelect.emit(e);
  }
}

/** One dense list row: ☐ · priority · type · key · status · title · project · assignee · date. */
@Component({
  selector: 'app-issue-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    LucideDynamicIcon,
    IssueProp,
    IssueCell,
    SwipeRow,
    PriorityIcon,
    V3Source,
    V3Thread,
  ],
  host: { class: 'block' },
  template: `
    @let i = issue();
    @let s = show();
    @if (vp.isMobile()) {
      <!-- Phone row: two lines, 44px+ targets, swipe actions that mirror the tappable pickers. -->
      <app-swipe-row
        [disabled]="!canEdit()"
        [startWidth]="canEdit() ? 104 : 0"
        [endWidth]="canEdit() ? 176 : 0"
        (startCommit)="toggleMe()"
        (endCommit)="toggleDone()"
      >
        <button swipeStart type="button" class="swipe-action swipe-action--blue" (click)="toggleMe()">
          <svg [lucideIcon]="mine() ? unassignIcon : assignIcon" [size]="20" aria-hidden="true"></svg>
          <span>{{ mine() ? 'Unassign' : 'Assign me' }}</span>
        </button>
        <button swipeEnd type="button" class="swipe-action swipe-action--grey" (click)="actions.openPrompt('priority', [i.id])">
          <svg [lucideIcon]="flagIcon" [size]="20" aria-hidden="true"></svg>
          <span>Priority</span>
        </button>
        <button swipeEnd type="button" class="swipe-action swipe-action--green" (click)="toggleDone()">
          <svg [lucideIcon]="quiet() ? reopenIcon : check" [size]="20" aria-hidden="true"></svg>
          <span>{{ quiet() ? 'Reopen' : 'Done' }}</span>
        </button>
        <div
          class="issue-m relative flex items-center gap-1 pl-1 pr-3"
          [class.bg-selected]="selected()"
          [class.opacity-55]="ghost()"
          [style.padding-left.px]="tree() ? 4 + depth() * 16 : null"
          [attr.data-row-id]="ghost() ? null : i.id"
          (pointerdown)="pressStart($event)"
          (pointermove)="pressMove($event)"
          (pointerup)="pressEnd()"
          (pointercancel)="pressEnd()"
        >
          <a
            [routerLink]="['/', slug(), 'tasks', i.key]"
            class="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset"
            [attr.aria-label]="i.key + ' ' + i.title"
            (click)="onPressedLinkClick($event)"
          ></a>
          @if (selectable() && selecting()) {
            <button
              type="button"
              role="checkbox"
              class="issue-m__check relative"
              [attr.aria-checked]="selected()"
              [attr.aria-label]="'Select ' + i.key"
              (click)="onCheck($event)"
            >
              <span
                class="border-input flex size-5 items-center justify-center rounded-full border"
                [class]="selected() ? 'bg-primary border-primary text-primary-foreground' : 'bg-background'"
              >
                @if (selected()) {
                  <svg [lucideIcon]="check" [size]="12" [strokeWidth]="3"></svg>
                }
              </span>
            </button>
          }
          @if (tree() && childCount() > 0) {
            <button
              type="button"
              class="text-muted-foreground issue-m__tap relative flex items-center justify-center"
              [attr.aria-expanded]="expanded()"
              [attr.aria-label]="(expanded() ? 'Collapse' : 'Expand') + ' sub-tasks of ' + i.key"
              (click)="onToggle($event)"
            >
              <svg [lucideIcon]="expanded() ? chevronDown : chevronRight" [size]="16"></svg>
            </button>
          }
          <app-issue-prop class="issue-m__tap relative" [issue]="i" field="status" [size]="20" />
          <span class="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5 py-2.5">
            <span class="line-clamp-2 text-[15px] leading-snug" [class.text-muted-foreground]="quiet()">{{ i.title }}</span>
            <span class="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
              <span class="font-mono">{{ i.key }}</span>
              @if (i.priority !== 'none') {
                <app-priority-icon [priority]="i.priority" />
              }
              @if (date() !== '—') {
                <span class="ml-auto shrink-0 tabular-nums" [class.text-red]="overdue()">{{ date() }}</span>
              }
            </span>
          </span>
          @if (s.assignee) {
            <app-issue-prop class="issue-m__tap relative" [issue]="i" field="assignee" [avatarSize]="24" />
          }
        </div>
      </app-swipe-row>
    } @else {
    <!-- v3 row: ☐ · priority · key · title … sub-tasks · thread · source · status · avatar · EST · due.
         A sub-task (depth > 0) sits on a darker band, indented, with ↳ and its own done state. -->
    <div
      [attr.data-row-id]="ghost() ? null : i.id"
      class="group/row border-border relative flex items-center border-b px-4"
      [class]="rowState()"
      [class.opacity-55]="ghost()"
      [style.padding-left.px]="subtask() ? 54 + (depth() - 1) * 20 : null"
      [attr.data-depth]="tree() ? depth() : null"
      (dblclick)="onDblClick($event)"
    >
      <a
        [routerLink]="['/', slug(), 'tasks', i.key]"
        class="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset"
        [attr.aria-label]="i.key + ' ' + i.title"
        (click)="onLinkClick($event)"
      ></a>

      @if (subtask()) {
        <svg
          [lucideIcon]="subtaskIcon"
          [size]="13"
          class="text-faint pointer-events-none shrink-0"
          aria-hidden="true"
        ></svg>
      }
      @if (selectable()) {
        <button
          type="button"
          role="checkbox"
          [attr.aria-checked]="selected()"
          [attr.aria-label]="'Select ' + i.key"
          class="focus-visible:ring-ring relative flex size-3.5 shrink-0 items-center justify-center border outline-none focus-visible:ring-1"
          [class]="checkTone()"
          (click)="onCheck($event)"
        >
          @if (selected()) {
            <svg [lucideIcon]="check" [size]="10" [strokeWidth]="3"></svg>
          }
        </button>
      } @else {
        <span class="size-3.5 shrink-0" aria-hidden="true"></span>
      }

      @if (!subtask() && i.priority !== 'none') {
        <app-issue-cell class="relative" [issue]="i" field="priority" />
      }
      <span class="text-faint shrink-0 font-mono text-[11px] max-sm:hidden">{{ i.key }}</span>
      <span
        class="min-w-0 truncate"
        [class]="subtask() ? 'text-[13px]' : 'text-[13.5px]'"
        [class.text-muted-foreground]="quiet()"
      >
        {{ i.title }}
      </span>
      <span class="min-w-0 flex-1"></span>

      @if (!subtask()) {
        <!-- the sub-task count is also the expand / collapse control -->
        <button
          type="button"
          class="relative flex shrink-0 items-center gap-[5px] font-mono text-[11px] tabular-nums outline-none focus-visible:underline max-sm:hidden"
          [class]="subTotal() > 0 ? (expanded() ? 'text-foreground' : 'text-faint hover:text-foreground') : 'text-faint'"
          [disabled]="!tree() || childCount() === 0"
          [attr.aria-expanded]="tree() && childCount() > 0 ? expanded() : null"
          [attr.aria-label]="subTotal() + (subTotal() === 1 ? ' sub-task' : ' sub-tasks') + (tree() && childCount() > 0 ? (expanded() ? ', collapse' : ', expand') : '')"
          (click)="onToggle($event)"
          (dblclick)="$event.stopPropagation()"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12h-8" /><path d="M21 6H8" /><path d="M21 18h-8" /><path d="M3 6v4c0 1.1.9 2 2 2h3" /><path d="M3 10v6c0 1.1.9 2 2 2h3" />
          </svg>
          {{ subTotal() > 0 ? subDone() + '/' + subTotal() : '–' }}
        </button>
      }
      @if (i.threadUrl) {
        <a
          class="relative max-lg:hidden"
          [href]="i.threadUrl"
          target="_blank"
          rel="noopener noreferrer"
          title="Open the thread"
          (click)="$event.stopPropagation()"
        >
          <v3-thread [issue]="i" />
        </a>
      } @else {
        <v3-thread class="max-lg:hidden" [issue]="i" />
      }
      @if (!subtask()) {
        @if (sourceUrl(); as href) {
          <a
            class="relative max-xl:hidden"
            [href]="href"
            target="_blank"
            rel="noopener noreferrer"
            title="Open in the source tracker"
            (click)="$event.stopPropagation()"
          >
            <v3-source [issue]="i" />
          </a>
        } @else {
          <v3-source class="max-xl:hidden" [issue]="i" />
        }
      }
      @if (subtask() && showEstimate()) {
        <app-issue-cell class="relative max-lg:hidden" [issue]="i" field="estimate" />
      }
      <app-issue-cell class="relative" [issue]="i" field="status" />
      @if (s.assignee) {
        <app-issue-cell
          class="relative"
          [class]="i.assigneeId ? '' : 'invisible'"
          [issue]="i"
          field="assignee"
        />
      }
      @if (!subtask() && showEstimate()) {
        <app-issue-cell class="relative max-lg:hidden" [issue]="i" field="estimate" />
      }
      @if (s.date && !subtask()) {
        <span
          class="min-w-12 shrink-0 text-right font-mono text-[11px] tabular-nums max-sm:hidden"
          [class]="overdue() ? 'text-red' : 'text-muted-foreground'"
          [attr.aria-label]="dateTitle()"
          [attr.title]="dateTitle()"
          >{{ date() }}</span
        >
      }
    </div>
    }
  `,
})
export class IssueRow extends IssueItemBase {
  readonly compact = input(false);
  /** The list shows sub-tasks as a tree: reserve the indent and the expand control. */
  readonly tree = input(false);
  /** Nesting level (0 = top level). */
  readonly depth = input(0);
  /** Sub-tasks shown under this row. */
  readonly childCount = input(0);
  readonly expanded = input(false);
  /** Context row for a matching sub-task (its parent did not match the filters): dimmed. */
  readonly ghost = input(false);
  /** The expand / collapse control was used. */
  readonly toggleExpand = output<void>();
  protected readonly chevronDown = LucideChevronDown;
  protected readonly chevronRight = LucideChevronRight;
  protected readonly subtaskIcon = LucideCornerDownRight;

  protected onToggle(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.toggleExpand.emit();
  }
  protected readonly vp = inject(Viewport);
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly mine = computed(() => this.issue().assigneeId === this.store.me()?.id);
  protected readonly assignIcon = LucideUserPlus;
  protected readonly unassignIcon = LucideUserRoundX;
  protected readonly flagIcon = LucideFlag;
  protected readonly reopenIcon = LucideRotateCcw;

  protected toggleMe(): void {
    this.actions.toggleAssignMe([this.issue().id]);
  }

  protected toggleDone(): void {
    this.actions.setStatus(
      [this.issue().id],
      quietToggleStatus(this.store.settings().statuses.issue, this.quiet()),
    );
  }

  // Long press selects the row (touch has no hover checkbox).
  private press: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private pressed = false;

  protected pressStart(ev: PointerEvent): void {
    if (!this.selectable() || ev.pointerType === 'mouse') return;
    this.pressEnd();
    this.pressed = false;
    this.press = {
      x: ev.clientX,
      y: ev.clientY,
      timer: setTimeout(() => {
        this.pressed = true;
        haptic('success');
        this.toggleSelect.emit(new MouseEvent('click'));
        // The finger lifts after this: swallow the click it produces so the issue does not open.
        const swallow = (e: Event): void => {
          e.preventDefault();
          e.stopPropagation();
        };
        document.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => document.removeEventListener('click', swallow, true), 1500);
      }, 480),
    };
  }

  protected pressMove(ev: PointerEvent): void {
    const p = this.press;
    if (p && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 8) this.pressEnd();
  }

  protected pressEnd(): void {
    if (this.press) clearTimeout(this.press.timer);
    this.press = null;
  }

  protected onPressedLinkClick(e: MouseEvent): void {
    if (this.pressed) {
      // the lift after a long press must not open the issue
      e.preventDefault();
      this.pressed = false;
      return;
    }
    if (this.selecting()) {
      e.preventDefault();
      this.toggleSelect.emit(e);
    }
  }

  /** A sub-task row: nested under its parent in the tree. */
  protected readonly subtask = computed(() => this.tree() && this.depth() > 0);
  protected readonly rowState = computed(
    () =>
      (this.subtask()
        ? 'min-h-[38px] gap-2.5 text-[13px] '
        : (this.compact() ? 'min-h-8 ' : 'min-h-10 ') + 'gap-3 text-[13.5px] ') +
      (this.selected()
        ? 'bg-delta-line/8'
        : (this.subtask() ? 'bg-card/60 ' : '') + (this.focused() ? 'bg-hover' : 'hover:bg-hover')),
  );
  /** The 14px check: blue when selected; on a sub-task it also shows green when the task is done. */
  protected readonly checkTone = computed(() => {
    if (this.selected()) return 'border-delta-line bg-delta-line text-white';
    if (this.subtask() && this.quiet()) return 'border-status-done bg-status-done text-background';
    return 'border-faint hover:border-muted-foreground';
  });
}

/**
 * v3 board card: key + priority bars, the title, then thread · sub-tasks … avatar. Hairline box on the
 * card fill; selected = blue tint. While it is dragged the board draws it tilted with a blue outline.
 */
@Component({
  selector: 'app-issue-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, IssueCell, V3Thread],
  host: { class: 'block' },
  template: `
    @let i = issue();
    @let s = show();
    <div
      [attr.data-row-id]="i.id"
      class="group/card relative flex flex-col gap-2.5 border p-[11px] transition-colors"
      [class]="
        selected()
          ? 'border-delta-line/60 bg-delta-line/8'
          : focused()
            ? 'bg-card border-ring/40'
            : 'bg-card border-border hover:bg-hover'
      "
      (dblclick)="onDblClick($event)"
    >
      <a
        [routerLink]="['/', slug(), 'tasks', i.key]"
        class="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-1"
        [attr.aria-label]="i.key + ' ' + i.title"
        (click)="onLinkClick($event)"
      ></a>
      @if (selectable()) {
        <!-- sits on the card's corner so the key keeps the design's left edge -->
        <button
          type="button"
          role="checkbox"
          [attr.aria-checked]="selected()"
          [attr.aria-label]="'Select ' + i.key"
          class="focus-visible:ring-ring absolute -top-[5px] -left-[5px] z-[1] flex size-3.5 items-center justify-center border outline-none focus-visible:opacity-100 focus-visible:ring-1"
          [class]="
            selected()
              ? 'border-delta-line bg-delta-line text-white opacity-100'
              : selecting()
                ? 'border-faint bg-background opacity-100'
                : 'border-faint bg-background opacity-0 group-hover/card:opacity-100'
          "
          (click)="onCheck($event)"
        >
          @if (selected()) {
            <svg [lucideIcon]="check" [size]="10" [strokeWidth]="3"></svg>
          }
        </button>
      }
      <div class="flex min-h-[14px] items-center gap-2">
        <span class="text-faint font-mono text-[10.5px] leading-[14px]">{{ i.key }}</span>
        <span class="flex-1"></span>
        <app-issue-cell class="relative" [issue]="i" field="priority" [showLabel]="false" />
      </div>
      <span
        class="line-clamp-3 text-[13.5px] leading-[18px]"
        [class.text-muted-foreground]="quiet()"
        >{{ i.title }}</span
      >
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        @if (i.threadUrl) {
          <a
            class="relative"
            [href]="i.threadUrl"
            target="_blank"
            rel="noopener noreferrer"
            title="Open the thread"
            (click)="$event.stopPropagation()"
          >
            <v3-thread [issue]="i" label="Thread" />
          </a>
        } @else {
          <v3-thread [issue]="i" />
        }
        @if (subTotal() > 0) {
          <span
            class="text-faint flex items-center gap-1 font-mono text-[10.5px] tabular-nums"
            [attr.aria-label]="subDone() + ' of ' + subTotal() + ' sub-tasks done'"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 12h-8" /><path d="M21 6H8" /><path d="M21 18h-8" /><path d="M3 6v4c0 1.1.9 2 2 2h3" /><path d="M3 10v6c0 1.1.9 2 2 2h3" />
            </svg>
            {{ subDone() }}/{{ subTotal() }}
          </span>
        }
        @if (showStatus()) {
          <app-issue-cell class="relative" [issue]="i" field="status" />
        }
        <span class="flex-1"></span>
        @if (s.assignee && i.assigneeId) {
          <app-issue-cell class="relative" [issue]="i" field="assignee" />
        }
      </div>
    </div>
  `,
})
export class IssueCard extends IssueItemBase {
  /** Board columns grouped by status already say it. */
  readonly showStatus = input(true);
}
