// Issue list row and board card. The whole row/card is a link (an absolutely positioned <a>);
// property glyphs sit above it and open inline pickers.
import { ChangeDetectionStrategy, Component, Directive, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideBuilding2,
  LucideCheck,
  LucideDynamicIcon,
  LucideFlag,
  LucideRotateCcw,
  LucideUserPlus,
  LucideUserRoundX,
} from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, Viewport, fullDate, haptic, issueProjectIds, shortDate, type Issue } from '../../core';
import { EntityChip } from '../../shared/entity-chip';
import { Estimate } from '../../shared/estimate';
import { ProjectChip } from '../../shared/project-chip';
import { IssueKindLabel } from '../../shared/issue';
import { PriorityIcon } from '../../shared/priority-icon';
import { SwipeRow } from '../../shared/swipe-row';
import { LabelChips } from '../../shared/label-chip';
import type { IssueProp as IssuePropName } from './issue-model';
import { isClosedIssue } from './issue-model';
import { describeDemand } from '../customers/customer-model';
import { IssueActions } from './issue-actions';
import { IssueProp } from './issue-prop';

/** Shared bits of row + card. */
@Directive()
abstract class IssueItemBase {
  protected readonly store = inject(NablaStore);
  readonly issue = input.required<Issue>();
  readonly focused = input(false);
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
  protected readonly buildingIcon = LucideBuilding2;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly quiet = computed(() => isClosedIssue(this.issue()));
  protected readonly demand = computed(() => this.store.demand().get(this.issue().id));
  protected readonly customerCount = computed(() => this.demand()?.customerCount ?? 0);
  protected readonly demandText = computed(() => {
    const d = this.demand();
    return d ? describeDemand(d) : '';
  });
  protected readonly show = computed(() => {
    const h = new Set(this.hidden());
    return { kind: !h.has('kind'), workstreams: !h.has('workstreams'), project: !h.has('project'), labels: !h.has('labels'), team: !h.has('team'), assignee: !h.has('assignee'), date: !h.has('date') };
  });
  protected readonly team = computed(() => {
    const id = this.issue().teamId;
    return id ? this.store.getTeam(id) : undefined;
  });
  protected readonly wsIds = computed(() => this.issue().workstreamIds.filter((id) => this.store.workstreamById().has(id)));
  protected readonly wsShown = computed(() => this.wsIds().slice(0, 2));
  protected readonly wsMore = computed(() => {
    const rest = this.wsIds().slice(2);
    return rest.length ? { n: rest.length, keys: rest.map((id) => this.store.getWorkstream(id)?.key ?? '').join(', ') } : null;
  });
  /** Projects of the issue: its own, then those of its workstreams (same meaning as the project filter). */
  protected readonly projectIds = computed(() => issueProjectIds(this.issue(), this.store.workstreamById()));
  protected readonly projectMore = computed(() => {
    const rest = this.projectIds().slice(1);
    return rest.length ? { n: rest.length, names: rest.map((id) => this.store.getProject(id)?.name ?? '').join(', ') } : null;
  });
  /** Shown when the issue is estimated and the workspace still uses estimates (or the value is kept anyway). */
  protected readonly hasEstimate = computed(() => this.issue().estimate !== undefined && this.issue().estimate !== null);
  protected readonly date = computed(() => shortDate(this.issue()[this.dateField()]));
  protected readonly dateTitle = computed(
    () => `${this.dateField() === 'createdAt' ? 'Created' : 'Updated'} ${fullDate(this.issue()[this.dateField()])}`,
  );

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
}

/** One dense list row: ☐ · priority · type · key · status · title · workstreams · team · assignee · date. */
@Component({
  selector: 'app-issue-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmTooltip, IssueKindLabel, IssueProp, ProjectChip, EntityChip, Estimate, LabelChips, SwipeRow, PriorityIcon],
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
          class="issue-m relative flex items-center gap-1 border-b border-border/60 pl-1 pr-3"
          [class.bg-selected]="selected()"
          [attr.data-row-id]="i.id"
          (pointerdown)="pressStart($event)"
          (pointermove)="pressMove($event)"
          (pointerup)="pressEnd()"
          (pointercancel)="pressEnd()"
        >
          <a
            [routerLink]="['/', slug(), 'issues', i.key]"
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
                class="border-border-strong flex size-5 items-center justify-center rounded-full border"
                [class]="selected() ? 'bg-primary border-primary text-primary-foreground' : 'bg-background'"
              >
                @if (selected()) {
                  <svg [lucideIcon]="check" [size]="12" [strokeWidth]="3"></svg>
                }
              </span>
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
              @if (wsShown()[0]; as id) {
                <app-entity-chip class="min-w-0" type="workstream" [ref]="id" compact />
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
      [attr.data-row-id]="i.id"
      class="group/row relative flex items-center gap-2 border-b border-border/60 pr-3 pl-1.5 text-[13px] sm:pr-5 sm:pl-2.5"
      [class]="rowState()"
    >
      <a
        [routerLink]="['/', slug(), 'issues', i.key]"
        class="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-1 focus-visible:ring-inset"
        [attr.aria-label]="i.key + ' ' + i.title"
        (click)="onLinkClick($event)"
      ></a>

      @if (selectable()) {
        <span class="relative flex w-5 shrink-0 justify-center">
          <button
            type="button"
            role="checkbox"
            [attr.aria-checked]="selected()"
            [attr.aria-label]="'Select ' + i.key"
            class="border-border-strong flex size-3.5 items-center justify-center rounded-[4px] border transition-opacity focus-visible:opacity-100"
            [class]="selected() ? 'bg-primary border-primary text-primary-foreground opacity-100' : selecting() ? 'bg-background opacity-100' : 'bg-background opacity-0 group-hover/row:opacity-100'"
            (click)="onCheck($event)"
          >
            @if (selected()) {
              <svg [lucideIcon]="check" [size]="10" [strokeWidth]="3"></svg>
            }
          </button>
        </span>
      } @else {
        <span class="w-1.5 shrink-0"></span>
      }

      <app-issue-prop class="relative" [issue]="i" field="priority" />
      @if (s.kind) {
        <app-issue-kind [kind]="i.kind" class="max-sm:hidden" />
      }
      <span class="text-muted-foreground w-[4.5rem] shrink-0 truncate font-mono text-xs max-sm:hidden">{{ i.key }}</span>
      <app-issue-prop class="relative" [issue]="i" field="status" />
      <span class="min-w-0 flex-1 truncate" [class.text-muted-foreground]="quiet()">
        {{ i.title }}
        @if (i.duplicateOfId) {
          <span class="text-muted-foreground ml-1 text-xs">· duplicate</span>
        }
      </span>
      @if (customerCount()) {
        <span
          class="relative hidden shrink-0 items-center gap-0.5 text-xs tabular-nums sm:inline-flex"
          [class]="demand()?.importantCount ? 'text-tone-amber' : 'text-muted-foreground'"
          [hlmTooltip]="demandText()"
          [attr.aria-label]="demandText()"
        ><svg [lucideIcon]="buildingIcon" [size]="11"></svg>{{ customerCount() }}</span>
      }

      @if (hasEstimate()) {
        <app-estimate class="relative text-xs max-sm:hidden" [value]="i.estimate" />
      }
      @if (s.workstreams && wsIds().length) {
        <span class="relative flex shrink-0 items-center gap-1 max-md:hidden">
          @for (id of wsShown(); track id) {
            <app-entity-chip type="workstream" [ref]="id" compact />
          }
          @if (wsMore(); as m) {
            <span class="text-muted-foreground border-border-strong rounded-full border px-1.5 text-[11px] leading-5" [hlmTooltip]="m.keys">+{{ m.n }}</span>
          }
        </span>
      }
      @if (s.project && projectIds().length) {
        <span class="relative flex min-w-0 shrink-0 items-center gap-1 max-lg:hidden">
          <app-project-chip [projectId]="projectIds()[0]" />
          @if (projectMore(); as m) {
            <span class="text-muted-foreground border-border-strong rounded-full border px-1.5 text-[11px] leading-5" [hlmTooltip]="m.names">+{{ m.n }}</span>
          }
        </span>
      }
      @if (s.labels && i.labels.length) {
        <app-label-chips class="relative shrink-0 max-lg:hidden" [ids]="i.labels" [max]="2" />
      }
      @if (s.team && team(); as t) {
        <span class="text-muted-foreground w-12 shrink-0 truncate text-right font-mono text-[11px] max-md:hidden">{{ t.key }}</span>
      }
      @if (s.assignee) {
        <app-issue-prop class="relative" [issue]="i" field="assignee" />
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
  protected readonly vp = inject(Viewport);
  protected readonly actions = inject(IssueActions);
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
    this.actions.setStatus([this.issue().id], this.quiet() ? 'todo' : 'done');
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
      (this.selected() ? 'bg-selected' : this.focused() ? 'bg-hover' : 'hover:bg-hover'),
  );
}

/** Board card: key + assignee, status + title, then a small property row. */
@Component({
  selector: 'app-issue-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, LucideDynamicIcon, HlmTooltip, IssueKindLabel, IssueProp, ProjectChip, EntityChip, Estimate, LabelChips],
  host: { class: 'block' },
  template: `
    @let i = issue();
    @let s = show();
    <div
      [attr.data-row-id]="i.id"
      class="group/card relative rounded-lg border px-3 py-2.5 shadow-xs transition-colors"
      [class]="selected() ? 'border-primary/60 bg-selected' : focused() ? 'bg-card border-border-strong' : 'bg-card border-border hover:border-border-strong'"
    >
      <a
        [routerLink]="['/', slug(), 'issues', i.key]"
        class="focus-visible:ring-ring absolute inset-0 rounded-lg outline-none focus-visible:ring-2"
        [attr.aria-label]="i.key + ' ' + i.title"
        (click)="onLinkClick($event)"
      ></a>
      <div class="flex h-5 items-center gap-1.5">
        @if (selectable()) {
          <button
            type="button"
            role="checkbox"
            [attr.aria-checked]="selected()"
            [attr.aria-label]="'Select ' + i.key"
            class="border-border-strong relative size-3.5 items-center justify-center rounded-[4px] border"
            [class]="selected() ? 'bg-primary border-primary text-primary-foreground flex' : selecting() ? 'bg-background flex' : 'bg-background hidden group-hover/card:flex'"
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
        @if (s.assignee) {
          <app-issue-prop class="relative -mr-1" [issue]="i" field="assignee" [avatarSize]="18" />
        }
      </div>
      <div class="mt-1 flex items-start gap-1.5">
        @if (showStatus()) {
          <app-issue-prop class="relative -ml-1 -mt-0.5" [issue]="i" field="status" />
        }
        <span class="line-clamp-2 text-[13px] leading-snug font-medium" [class.text-muted-foreground]="quiet()">{{ i.title }}</span>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-1.5">
        <app-issue-prop class="border-border relative -ml-0.5 rounded-md border" [issue]="i" field="priority" />
        @if (s.workstreams) {
          @for (id of wsShown(); track id) {
            <app-entity-chip class="relative" type="workstream" [ref]="id" compact />
          }
          @if (wsMore(); as m) {
            <span class="text-muted-foreground border-border-strong relative rounded-full border px-1.5 text-[11px] leading-5" [hlmTooltip]="m.keys">+{{ m.n }}</span>
          }
        }
        @if (s.project && projectIds().length) {
          <app-project-chip [projectId]="projectIds()[0]" />
          @if (projectMore(); as m) {
            <span class="text-muted-foreground border-border-strong relative rounded-full border px-1.5 text-[11px] leading-5" [hlmTooltip]="m.names">+{{ m.n }}</span>
          }
        }
        @if (s.labels && i.labels.length) {
          <app-label-chips class="relative" [ids]="i.labels" [max]="2" />
        }
        @if (hasEstimate()) {
          <app-estimate class="border-border relative inline-flex h-6 items-center rounded-md border px-1.5 text-[11px]" [value]="i.estimate" />
        }
        @if (s.team && team(); as t) {
          <span class="text-muted-foreground border-border inline-flex h-6 items-center rounded-md border px-1.5 font-mono text-[11px]">{{ t.key }}</span>
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
