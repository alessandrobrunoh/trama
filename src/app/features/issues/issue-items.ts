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
import { TramaStore, UiStore, Viewport, fullDate, haptic, shortDate, type Issue } from '../../core';
import { RightPaneStore } from '../../core/stores/right-pane.store';
import { Estimate } from '../../shared/estimate';
import { ProjectChip } from '../../shared/project-chip';
import { IssueKindLabel } from '../../shared/issue';
import { PriorityIcon } from '../../shared/priority-icon';
import { SwipeRow } from '../../shared/swipe-row';
import { LabelChips } from '../../shared/label-chip';
import type { IssueProp as IssuePropName } from './issue-model';
import { isClosedIssue, quietToggleStatus } from './issue-model';
import { IssueActions } from './issue-actions';
import { IssueProp } from './issue-prop';
import { NeedsYou, PreviewLink, isTaskPreviewed } from './list-preview';

/** Shared bits of row + card. */
@Directive()
abstract class IssueItemBase {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly pane = inject(RightPaneStore);
  private readonly needs = inject(NeedsYou);
  protected readonly actions = inject(IssueActions);
  /** The right pane shows this task. */
  protected readonly previewed = computed(() => isTaskPreviewed(this.pane, this.issue()));
  /** An open attention item is waiting on the current user. */
  protected readonly needsYou = computed(() => this.needs.issueIds().has(this.issue().id));
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
  /** Which date the date column shows. */
  readonly dateField = input<'updatedAt' | 'createdAt'>('updatedAt');
  /** Checkbox click or shift-click: the board decides (toggle / range). */
  readonly toggleSelect = output<MouseEvent>();

  protected readonly check = LucideCheck;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly quiet = computed(() => isClosedIssue(this.issue(), this.store.settings().statuses.issue));
  protected readonly show = computed(() => {
    const h = new Set(this.hidden());
    return {
      kind: !h.has('kind'),
      project: !h.has('project'),
      labels: !h.has('labels'),
      estimate: !h.has('estimate'),
      assignee: !h.has('assignee'),
      date: !h.has('date'),
    };
  });
  protected readonly projectId = computed(() => this.issue().projectId);
  /** Shown when the issue is estimated and the workspace still uses estimates (or the value is kept anyway). */
  protected readonly hasEstimate = computed(() => this.issue().estimate !== undefined && this.issue().estimate !== null);
  /** The estimate cell: an estimated task keeps it; others get an empty cell people can click while estimates are on. */
  protected readonly showEstimate = computed(
    () =>
      this.show().estimate &&
      (this.hasEstimate() || (this.store.estimateScale() !== 'none' && this.store.can('member'))),
  );
  protected readonly date = computed(() => shortDate(this.issue()[this.dateField()]));
  protected readonly dateTitle = computed(
    () => `${this.dateField() === 'createdAt' ? 'Created' : 'Updated'} ${fullDate(this.issue()[this.dateField()])}`,
  );

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

  /** Shift-click selects a range; the link itself previews or opens (see `PreviewLink`). */
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

  /** A single click shows the task in the right pane. */
  protected preview(): void {
    const issue = this.issue();
    this.ui.setFocusedRow(issue.id);
    this.pane.show({ kind: 'task', idOrKey: issue.key });
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
  imports: [RouterLink, PreviewLink, LucideDynamicIcon, IssueProp, ProjectChip, LabelChips, SwipeRow, PriorityIcon],
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
              <span class="ml-auto shrink-0 tabular-nums">{{ date() }}</span>
            </span>
          </span>
          @if (s.assignee) {
            <app-issue-prop class="issue-m__tap relative" [issue]="i" field="assignee" [avatarSize]="24" />
          }
        </div>
      </app-swipe-row>
    } @else {
    <div
      [attr.data-row-id]="ghost() ? null : i.id"
      class="group/row relative flex items-center gap-2.5 pr-3 pl-3 text-[13px] sm:pr-5 sm:pl-5"
      [class]="rowState()"
      [class.opacity-55]="ghost()"
      [attr.data-depth]="tree() ? depth() : null"
      (dblclick)="onDblClick($event)"
    >
      <a
        [appPreviewLink]="['/', slug(), 'tasks', i.key]"
        class="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset"
        [attr.aria-label]="i.key + ' ' + i.title"
        [attr.aria-current]="previewed() ? 'true' : null"
        (preview)="preview()"
        (click)="onLinkClick($event)"
      ></a>

      @if (selectable()) {
        <span class="relative -ml-1 flex w-4 shrink-0 justify-center">
          <button
            type="button"
            role="checkbox"
            [attr.aria-checked]="selected()"
            [attr.aria-label]="'Select ' + i.key"
            class="border-input flex size-3.5 items-center justify-center rounded-[4px] border transition-opacity focus-visible:opacity-100"
            [class]="selected() ? 'bg-primary border-primary text-primary-foreground opacity-100' : selecting() ? 'bg-background opacity-100' : 'bg-background opacity-0 group-hover/row:opacity-100'"
            (click)="onCheck($event)"
          >
            @if (selected()) {
              <svg [lucideIcon]="check" [size]="10" [strokeWidth]="3"></svg>
            }
          </button>
        </span>
      }

      @if (tree()) {
        <span class="pointer-events-none shrink-0" [style.width.px]="depth() * 20" aria-hidden="true"></span>
        <span class="relative -mr-1 flex size-5 shrink-0 items-center justify-center">
          @if (childCount() > 0) {
            <button
              type="button"
              class="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring flex size-5 items-center justify-center rounded outline-none focus-visible:ring-2"
              [attr.aria-expanded]="expanded()"
              [attr.aria-label]="(expanded() ? 'Collapse' : 'Expand') + ' sub-tasks of ' + i.key"
              (click)="onToggle($event)"
              (dblclick)="$event.stopPropagation()"
            >
              <svg [lucideIcon]="expanded() ? chevronDown : chevronRight" [size]="13"></svg>
            </button>
          }
        </span>
      }
      <app-issue-prop class="relative" [issue]="i" field="status" />
      <span class="text-muted-foreground w-[4.5rem] shrink-0 truncate font-mono text-xs max-sm:hidden">{{ i.key }}</span>
      <span class="min-w-0 flex-1 truncate" [class.text-muted-foreground]="quiet()">
        {{ i.title }}
        @if (i.duplicateOfId) {
          <span class="text-muted-foreground ml-1 text-xs">· duplicate</span>
        }
      </span>
      @if (childCount() > 0) {
        <span
          class="text-muted-foreground relative flex shrink-0 items-center gap-0.5 text-xs tabular-nums"
          [attr.aria-label]="childCount() + (childCount() === 1 ? ' sub-task' : ' sub-tasks')"
          title="Sub-tasks"
        >
          <svg [lucideIcon]="subtaskIcon" [size]="11" aria-hidden="true"></svg>{{ childCount() }}
        </span>
      }
      @if (s.labels && i.labels.length) {
        <app-label-chips class="relative shrink-0 max-lg:hidden" [ids]="i.labels" [max]="2" />
      }
      @if (showEstimate()) {
        <app-issue-prop
          class="relative max-sm:hidden"
          [class]="hasEstimate() ? '' : 'opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100'"
          [issue]="i"
          field="estimate"
        />
      }
      @if (s.project && projectId(); as pid) {
        <span class="relative flex min-w-0 shrink-0 items-center gap-1 max-lg:hidden">
          <app-project-chip [projectId]="pid" />
        </span>
      }
      @if (i.priority !== 'none') {
        <app-issue-prop class="relative" [issue]="i" field="priority" />
      }
      @if (needsYou()) {
        <span class="bg-primary size-2 shrink-0 rounded-full" role="img" aria-label="Needs you"></span>
      }
      @if (s.assignee) {
        <app-issue-prop
          class="relative"
          [class]="i.assigneeId ? '' : 'opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100'"
          [issue]="i"
          field="assignee"
        />
      }
      @if (s.date) {
        <span class="text-muted-foreground w-12 shrink-0 text-right text-xs tabular-nums max-sm:hidden" [attr.aria-label]="dateTitle()">{{ date() }}</span>
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

  protected readonly rowState = computed(
    () =>
      (this.compact() ? 'min-h-8 ' : 'min-h-10 ') +
      (this.selected() || this.previewed()
        ? 'bg-selected'
        : this.focused()
          ? 'bg-hover'
          : 'hover:bg-hover'),
  );
}

/** Board card: key + assignee, status + title, then a small property row. */
@Component({
  selector: 'app-issue-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PreviewLink, LucideDynamicIcon, IssueKindLabel, IssueProp, ProjectChip, Estimate, LabelChips],
  host: { class: 'block' },
  template: `
    @let i = issue();
    @let s = show();
    <div
      [attr.data-row-id]="i.id"
      class="group/card relative rounded-lg px-3 py-2.5 transition-colors"
      [class]="selected() || previewed() ? 'bg-selected' : focused() ? 'bg-background ring-1 ring-ring/40' : 'bg-background hover:bg-hover'"
      (dblclick)="onDblClick($event)"
    >
      <a
        [appPreviewLink]="['/', slug(), 'tasks', i.key]"
        class="focus-visible:ring-ring absolute inset-0 rounded-lg outline-none focus-visible:ring-2"
        [attr.aria-label]="i.key + ' ' + i.title"
        [attr.aria-current]="previewed() ? 'true' : null"
        (preview)="preview()"
        (click)="onLinkClick($event)"
      ></a>
      <div class="flex h-5 items-center gap-1.5">
        @if (selectable()) {
          <button
            type="button"
            role="checkbox"
            [attr.aria-checked]="selected()"
            [attr.aria-label]="'Select ' + i.key"
            class="border-input relative flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border focus-visible:opacity-100"
            [class]="selected() ? 'bg-primary border-primary text-primary-foreground opacity-100' : selecting() ? 'bg-background opacity-100' : 'bg-background opacity-0 group-hover/card:opacity-100'"
            (click)="onCheck($event)"
          >
            @if (selected()) {
              <svg [lucideIcon]="check" [size]="10" [strokeWidth]="3"></svg>
            }
          </button>
        }
        <span class="text-muted-foreground font-mono text-xs">{{ i.key }}</span>
        @if (s.kind) {
          <app-issue-kind [kind]="i.kind" [size]="13" />
        }
        <span class="flex-1"></span>
        @if (needsYou()) {
          <span class="bg-primary size-2 shrink-0 rounded-full" role="img" aria-label="Needs you"></span>
        }
        @if (s.assignee) {
          <app-issue-prop class="relative -mr-1" [issue]="i" field="assignee" [avatarSize]="18" />
        }
      </div>
      <div class="mt-1 flex items-start gap-1.5">
        @if (showStatus()) {
          <app-issue-prop class="relative -ml-1 -mt-0.5" [issue]="i" field="status" />
        }
        <span class="line-clamp-2 text-[13px] leading-snug " [class.text-muted-foreground]="quiet()">{{ i.title }}</span>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        @if (i.priority !== 'none') {
          <app-issue-prop class="relative -ml-0.5 rounded-md" [issue]="i" field="priority" />
        }
        @if (s.project && projectId(); as pid) {
          <app-project-chip [projectId]="pid" />
        }
        @if (s.labels && i.labels.length) {
          <app-label-chips class="relative" [ids]="i.labels" [max]="2" />
        }
        @if (hasEstimate() && s.estimate) {
          <app-estimate class="bg-secondary relative inline-flex h-6 items-center rounded-md px-1.5 text-[11px]" [value]="i.estimate" />
        }
        @if (s.date) {
          <span class="text-muted-foreground ml-auto text-[11px] tabular-nums" [attr.aria-label]="dateTitle()">{{ date() }}</span>
        }
      </div>
    </div>
  `,
})
export class IssueCard extends IssueItemBase {
  /** Board columns grouped by status already say it. */
  readonly showStatus = input(true);
}
