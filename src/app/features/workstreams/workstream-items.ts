// Workstream list row, board card and the draft / canceled override menu.
//
// Rows and cards are the "outcome" counterpart of issue rows: a HEXAGON status glyph (issues use
// circles) and an issue-progress ring ("3/5 issues this workstream resolves"). Every property is
// editable in place (status override, priority, accountable, target date), right-click opens the
// workstream menu, the checkbox / `x` multi-selects, and `s` `p` `a` `t` open the inline editors
// of the focused row (see WsActions intents).
import { ChangeDetectionStrategy, Component, Directive, computed, effect, inject, input, untracked, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideBan, LucideCalendar, LucideCheck, LucideDynamicIcon, LucideEllipsis, LucideFileText, LucideRotateCcw, LucideUserRound } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, UiStore, WORKSTREAM_STATUS_META, type Priority, type Workstream, type WorkstreamStatus } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { NextMilestoneChip } from '../milestones/milestone-chips';
import { Picker } from './picker';
import { WsActions } from './ws-actions';
import { WsMenu } from './ws-menu';
import { CriteriaCount, IssueProgress, PrChip, TargetDate, TeamDots, WsDatePicker } from './ws-parts';
import { priorityOptions, statusOptions, userOptions, type WsSummary } from './ws-model';

/** Which properties a row shows (display options of the list). */
export interface WsRowProps {
  priority: boolean;
  status: boolean;
  issues: boolean;
  criteria: boolean;
  prs: boolean;
  teams: boolean;
  accountable: boolean;
  targetDate: boolean;
  labels: boolean;
}

export const DEFAULT_ROW_PROPS: WsRowProps = {
  priority: true,
  status: true,
  issues: true,
  criteria: true,
  prs: true,
  teams: true,
  accountable: true,
  targetDate: true,
  labels: false,
};

export const ROW_PROP_LABELS: { key: keyof WsRowProps; label: string }[] = [
  { key: 'priority', label: 'Priority' },
  { key: 'status', label: 'Status' },
  { key: 'issues', label: 'Issues' },
  { key: 'criteria', label: 'Criteria' },
  { key: 'prs', label: 'Pull requests' },
  { key: 'teams', label: 'Teams' },
  { key: 'accountable', label: 'Accountable' },
  { key: 'targetDate', label: 'Target date' },
  { key: 'labels', label: 'Labels' },
];

/** "⋯" menu to set / clear `statusOverride` (draft / canceled). Kept for compatibility. */
@Component({
  selector: 'app-override-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmDropdownMenuImports, LucideDynamicIcon, StatusIcon],
  host: { class: 'inline-flex' },
  template: `
    @if (canEdit()) {
      <button
        hlmBtn
        variant="ghost"
        [size]="size()"
        [hlmDropdownMenuTrigger]="menu"
        aria-label="Status override"
        class="text-muted-foreground"
      >
        <svg [lucideIcon]="more" [size]="15"></svg>
      </button>
      <ng-template #menu>
        <hlm-dropdown-menu class="w-52">
          <hlm-dropdown-menu-label>Override derived status</hlm-dropdown-menu-label>
          <hlm-dropdown-menu-group>
            <button hlmDropdownMenuItem (triggered)="set('draft')">
              <app-status-icon entity="workstream" status="draft" /> Mark as draft
            </button>
            <button hlmDropdownMenuItem (triggered)="set('canceled')">
              <app-status-icon entity="workstream" status="canceled" /> Mark as canceled
            </button>
            @if (ws().statusOverride) {
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem (triggered)="set(null)">
                <svg [lucideIcon]="reset" [size]="14"></svg> Clear override
              </button>
            }
          </hlm-dropdown-menu-group>
        </hlm-dropdown-menu>
      </ng-template>
    }
  `,
})
export class OverrideMenu {
  private readonly store = inject(NablaStore);
  readonly ws = input.required<Workstream>();
  readonly size = input<'icon-xs' | 'icon-sm'>('icon-sm');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly more = LucideEllipsis;
  protected readonly reset = LucideRotateCcw;
  protected readonly ban = LucideBan;
  protected readonly file = LucideFileText;

  protected set(v: 'draft' | 'canceled' | null): void {
    void this.store.updateWorkstream(this.ws().id, { statusOverride: v });
  }
}

/** Shared behaviour of row + card: inline editors, selection, intents. */
@Directive()
abstract class WsItemBase {
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly actions = inject(WsActions);
  private readonly router = inject(Router);

  abstract readonly summary: () => WsSummary;
  readonly focused = input(false);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly selected = computed(() => this.ui.selectedSet().has(this.summary().ws.id));
  protected readonly statuses = statusOptions();
  protected readonly priorities = priorityOptions();
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly statusMeta = WORKSTREAM_STATUS_META;
  protected readonly userIcon = LucideUserRound;
  protected readonly checkIcon = LucideCheck;
  protected readonly calIcon = LucideCalendar;

  protected readonly statusPicker = viewChild<Picker>('statusPicker');
  protected readonly priorityPicker = viewChild<Picker>('priorityPicker');
  protected readonly accountablePicker = viewChild<Picker>('accountablePicker');
  protected readonly datePicker = viewChild<WsDatePicker>('datePicker');

  constructor() {
    // keyboard intents for this row (s / p / a / t on the focused row)
    effect(() => {
      const i = this.actions.intent();
      if (!i) return;
      untracked(() => {
        const id = this.summary().ws.id;
        if (i.target !== id) return;
        const pick =
          i.kind === 'status' ? this.statusPicker() : i.kind === 'priority' ? this.priorityPicker() : i.kind === 'accountable' ? this.accountablePicker() : null;
        if (pick && this.actions.consume(i.kind, id)) pick.open();
        else if (i.kind === 'date' && this.datePicker() && this.actions.consume('date', id)) this.datePicker()!.open();
      });
    });
  }

  protected list(): Workstream[] {
    return this.actions.targetsFor(this.summary().ws);
  }
  protected setStatus(v: string | undefined): void {
    this.actions.setStatus(this.list(), (v as WorkstreamStatus | undefined) ?? null);
  }
  protected setPriority(v: string | undefined): void {
    if (v) this.actions.setPriority(this.list(), v as Priority);
  }
  protected setAccountable(v: string | undefined): void {
    this.actions.setAccountable(this.list(), v ?? null);
  }
  protected setDate(d: Date | null): void {
    this.actions.setTargetDate(this.list(), d);
  }

  /** Checkbox: click toggles, shift-click selects the range from the focused row. */
  protected toggleSelect(ev: MouseEvent): void {
    ev.stopPropagation();
    const id = this.summary().ws.id;
    if (ev.shiftKey) {
      const ids = [...new Set(Array.from(document.querySelectorAll<HTMLElement>('[data-row-id]')).map((el) => el.dataset['rowId'] ?? ''))];
      const from = ids.indexOf(this.ui.focusedRowId() ?? id);
      const to = ids.indexOf(id);
      if (from >= 0 && to >= 0) {
        const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
        this.ui.toggleSelected(id, [...new Set([...this.ui.selectedRowIds(), ...range])]);
        this.ui.setFocusedRow(id);
        return;
      }
    }
    this.ui.toggleSelected(id);
    this.ui.setFocusedRow(id);
  }

  /** Click anywhere on the row (outside controls) opens it; ⌘/Ctrl-click selects. */
  protected onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement;
    if (target.closest('button, a, input, [role="menuitem"], [data-no-open]')) return;
    const w = this.summary().ws;
    if (ev.metaKey || ev.ctrlKey) {
      this.ui.toggleSelected(w.id);
      this.ui.setFocusedRow(w.id);
      return;
    }
    if (ev.shiftKey) return;
    void this.router.navigate(['/', this.slug(), 'workstreams', w.key]);
  }
}

/** One dense list row (36px): ☐ · priority · key · ⬡ status · title · PRs · issues · criteria · teams · accountable · date. */
@Component({
  selector: 'app-workstream-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmContextMenuImports,
    HlmTooltip,
    LucideDynamicIcon,
    PriorityIcon,
    KeyChip,
    StatusIcon,
    ActorAvatar,
    Picker,
    PrChip,
    TeamDots,
    IssueProgress,
    CriteriaCount,
    TargetDate,
    WsDatePicker,
    NextMilestoneChip,
    WsMenu,
  ],
  host: { class: 'block' },
  template: `
    @let s = summary();
    @let w = s.ws;
    @let p = props();
    <app-ws-menu #menu [ws]="w" />
    <div
      [attr.data-row-id]="w.id"
      class="group/row hover:bg-hover relative flex min-h-9 cursor-default items-center gap-2 border-b border-border/70 pr-4 pl-1.5 text-[13px] sm:pr-6 sm:pl-2.5"
      [class.bg-selected]="selected()"
      [class.bg-hover]="focused() && !selected()"
      [hlmContextMenuTrigger]="menu.template() ?? null"
      (contextmenu)="ui.setFocusedRow(w.id)"
      (click)="onClick($event)"
    >
      @if (focused()) {
        <span class="bg-primary pointer-events-none absolute inset-y-0 left-0 w-0.5" aria-hidden="true"></span>
      }
      <button
        type="button"
        role="checkbox"
        class="flex size-5 shrink-0 items-center justify-center rounded outline-none group-hover/row:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring max-md:hidden"
        [class.opacity-0]="!selected() && !ui.hasSelection()"
        [attr.aria-checked]="selected()"
        [attr.aria-label]="'Select ' + w.key"
        (click)="toggleSelect($event)"
      >
        <span
          class="flex size-3.5 items-center justify-center rounded-[4px] border transition-colors"
          [class]="selected() ? 'bg-primary border-primary text-primary-foreground' : 'border-border-strong bg-background'"
        >
          @if (selected()) {
            <svg [lucideIcon]="checkIcon" [size]="10" [strokeWidth]="3"></svg>
          }
        </span>
      </button>

      @if (p.priority) {
        <app-picker #priorityPicker variant="bare" label="Priority" triggerClass="size-6 justify-center" [searchable]="false" [disabled]="!canEdit()" [options]="priorities" [value]="[w.priority]" (valueChange)="setPriority($event[0])">
          <app-priority-icon [priority]="w.priority" />
        </app-picker>
      }
      <a [routerLink]="['/', slug(), 'workstreams', w.key]" tabindex="-1" class="shrink-0 outline-none" [attr.aria-label]="w.key + ' ' + w.title">
        <app-key-chip [value]="w.key" class="w-[4.75rem]" />
      </a>
      @if (p.status) {
        <app-picker
          #statusPicker
          variant="bare"
          label="Status"
          triggerClass="size-6 justify-center"
          [searchable]="false"
          [clearable]="!!w.statusOverride"
          clearLabel="Automatic (derived)"
          [disabled]="!canEdit()"
          [options]="statuses"
          [value]="[w.status]"
          (valueChange)="setStatus($event[0])"
        >
          <app-status-icon entity="workstream" [status]="w.status" [hlmTooltip]="statusTip()" position="bottom" />
        </app-picker>
      }
      <span class="flex min-w-0 flex-1 items-center gap-2">
        <span class="truncate" [class.text-muted-foreground]="w.status === 'canceled'" [class.line-through]="w.status === 'canceled'">{{ w.title }}</span>
        @if (s.openInputs) {
          <span class="text-status-needs-input bg-status-needs-input/10 shrink-0 rounded-full px-1.5 text-[11px] font-medium" [hlmTooltip]="s.openInputs + ' open question(s) need an answer'" position="bottom">{{ s.openInputs }} ?</span>
        }
        <app-next-milestone class="max-lg:hidden" [workstreamId]="w.id" />
        @if (p.labels) {
          @for (l of w.labels.slice(0, 3); track l) {
            <span class="border-border-strong text-muted-foreground hidden h-5 shrink-0 items-center rounded-full border px-1.5 text-[11px] lg:inline-flex">{{ l }}</span>
          }
        }
      </span>

      @if (p.prs) {
        <span class="hidden w-[9.5rem] shrink-0 items-center justify-end gap-1 xl:flex">
          @for (a of s.openPrs.slice(0, 2); track a.id) {
            <app-pr-chip [artifact]="a" />
          }
          @if (s.openPrs.length > 2) {
            <span class="text-muted-foreground text-xs">+{{ s.openPrs.length - 2 }}</span>
          }
        </span>
      }
      @if (p.issues) {
        <app-issue-progress class="w-12 shrink-0 max-sm:hidden" [compact]="true" [done]="s.issuesDone" [active]="s.issuesActive" [total]="s.issuesTotal" />
      }
      @if (p.criteria) {
        <span class="w-10 shrink-0 max-md:hidden"><app-criteria-count [met]="s.criteriaMet" [total]="s.criteriaTotal" /></span>
      }
      @if (p.teams) {
        <app-team-dots [ws]="w" class="w-14 shrink-0 justify-end max-lg:hidden" />
      }
      @if (p.targetDate) {
        <span class="flex w-[4.5rem] shrink-0 justify-end max-sm:hidden">
          <app-ws-date-picker #datePicker label="Target date" triggerClass="h-6 px-1" [disabled]="!canEdit()" [value]="w.targetDate" align="end" (dateChange)="setDate($event)">
            @if (w.targetDate) {
              <app-target-date [date]="w.targetDate" [done]="w.status === 'shipped' || w.status === 'canceled'" />
            } @else if (canEdit()) {
              <svg [lucideIcon]="calIcon" [size]="13" class="text-muted-foreground opacity-0 group-hover/row:opacity-70"></svg>
            }
          </app-ws-date-picker>
        </span>
      }
      @if (p.accountable) {
        <app-picker
          #accountablePicker
          variant="bare"
          label="Accountable"
          triggerClass="size-6 justify-center rounded-full"
          align="end"
          [clearable]="true"
          clearLabel="Unassign"
          [disabled]="!canEdit()"
          [options]="users()"
          [value]="w.accountableUserId ? [w.accountableUserId] : []"
          (valueChange)="setAccountable($event[0])"
        >
          @if (w.accountableUserId) {
            <app-actor-avatar [actor]="{ type: 'user', id: w.accountableUserId }" [size]="20" />
          } @else {
            <span class="border-border-strong text-muted-foreground flex size-5 items-center justify-center rounded-full border border-dashed opacity-40 group-hover/row:opacity-100">
              <svg [lucideIcon]="userIcon" [size]="11"></svg>
            </span>
          }
        </app-picker>
      }
    </div>
  `,
})
export class WorkstreamRow extends WsItemBase {
  readonly summary = input.required<WsSummary>();
  /** Visible properties (defaults to all but labels). */
  readonly props = input<WsRowProps>(DEFAULT_ROW_PROPS);

  protected readonly statusTip = computed(() => {
    const w = this.summary().ws;
    const label = WORKSTREAM_STATUS_META[w.status].label;
    return w.statusOverride ? `${label} (set manually)` : `${label} (derived)`;
  });
}

/** Board card: same signals and editors as the row. */
@Component({
  selector: 'app-workstream-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    PriorityIcon,
    KeyChip,
    StatusIcon,
    ActorAvatar,
    Picker,
    PrChip,
    TeamDots,
    IssueProgress,
    CriteriaCount,
    TargetDate,
    WsDatePicker,
    NextMilestoneChip,
    WsMenu,
  ],
  host: { class: 'block' },
  template: `
    @let s = summary();
    @let w = s.ws;
    <app-ws-menu #menu [ws]="w" />
    <div
      class="bg-card hover:border-foreground/20 group/card relative flex cursor-pointer flex-col gap-2 rounded-lg border border-border-strong p-2.5 shadow-[var(--shadow-panel)] transition-colors"
      [class.ring-1]="focused() || selected()"
      [class.ring-primary]="focused() || selected()"
      [class.bg-selected]="selected()"
      [attr.data-row-id]="w.id"
      [hlmContextMenuTrigger]="menu.template() ?? null"
      (contextmenu)="ui.setFocusedRow(w.id)"
      (click)="onClick($event)"
    >
      <div class="flex items-center gap-1.5">
        <a [routerLink]="['/', slug(), 'workstreams', w.key]" class="outline-none" [attr.aria-label]="w.key + ' ' + w.title">
          <app-key-chip [value]="w.key" />
        </a>
        <span class="ml-auto flex items-center gap-0.5">
          @if (canEdit()) {
            <button
              hlmBtn
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
              aria-label="Workstream actions"
              [hlmDropdownMenuTrigger]="menu.template() ?? null"
            >
              <svg [lucideIcon]="moreIcon" [size]="14"></svg>
            </button>
          }
          <app-picker #accountablePicker variant="bare" label="Accountable" triggerClass="size-6 justify-center rounded-full" align="end" [clearable]="true" clearLabel="Unassign" [disabled]="!canEdit()" [options]="users()" [value]="w.accountableUserId ? [w.accountableUserId] : []" (valueChange)="setAccountable($event[0])">
            @if (w.accountableUserId) {
              <app-actor-avatar [actor]="{ type: 'user', id: w.accountableUserId }" [size]="18" />
            } @else {
              <span class="border-border-strong text-muted-foreground flex size-[18px] items-center justify-center rounded-full border border-dashed">
                <svg [lucideIcon]="userIcon" [size]="10"></svg>
              </span>
            }
          </app-picker>
        </span>
      </div>
      <div class="flex items-start gap-1.5">
        <app-picker #statusPicker variant="bare" label="Status" triggerClass="size-5 justify-center -ml-0.5 mt-px" [searchable]="false" [clearable]="!!w.statusOverride" clearLabel="Automatic (derived)" [disabled]="!canEdit()" [options]="statuses" [value]="[w.status]" (valueChange)="setStatus($event[0])">
          <app-status-icon entity="workstream" [status]="w.status" />
        </app-picker>
        <span class="line-clamp-2 min-w-0 flex-1 text-[13px] leading-snug font-medium">{{ w.title }}</span>
      </div>
      @if (s.openPrs.length) {
        <div class="flex flex-wrap items-center gap-1">
          @for (a of s.openPrs.slice(0, 3); track a.id) {
            <app-pr-chip [artifact]="a" />
          }
        </div>
      }
      <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <app-picker #priorityPicker variant="bare" label="Priority" triggerClass="size-6 justify-center -ml-1" [searchable]="false" [disabled]="!canEdit()" [options]="priorities" [value]="[w.priority]" (valueChange)="setPriority($event[0])">
          <app-priority-icon [priority]="w.priority" />
        </app-picker>
        <app-issue-progress [compact]="true" [done]="s.issuesDone" [active]="s.issuesActive" [total]="s.issuesTotal" />
        <app-criteria-count [met]="s.criteriaMet" [total]="s.criteriaTotal" />
        <app-next-milestone [workstreamId]="w.id" />
        <span class="ml-auto flex items-center gap-2">
          <app-ws-date-picker #datePicker label="Target date" triggerClass="h-6 px-1" align="end" [disabled]="!canEdit()" [value]="w.targetDate" (dateChange)="setDate($event)">
            @if (w.targetDate) {
              <app-target-date [date]="w.targetDate" [done]="w.status === 'shipped' || w.status === 'canceled'" />
            }
          </app-ws-date-picker>
          <app-team-dots [ws]="w" />
        </span>
      </div>
    </div>
  `,
})
export class WorkstreamCard extends WsItemBase {
  readonly summary = input.required<WsSummary>();
  protected readonly moreIcon = LucideEllipsis;
}
