// Small inline property menus for dense rows: click the glyph, pick a value (Linear-style).
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LucideCheck, LucideDynamicIcon } from '@lucide/angular';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  PRIORITIES,
  PRIORITY_META,
  type IssueStatus,
  type Priority,
} from '../../core';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';

/** Issue status glyph (circle) that opens a status menu. */
@Component({
  selector: 'app-issue-status-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDropdownMenuImports, HlmTooltip, LucideDynamicIcon, StatusIcon],
  host: { class: 'inline-flex' },
  template: `
    <button
      type="button"
      class="hover:bg-accent focus-visible:ring-ring/50 -m-1 inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:cursor-default disabled:hover:bg-transparent"
      [hlmDropdownMenuTrigger]="menu"
      align="start"
      [disabled]="disabled()"
      [hlmTooltip]="'Status: ' + label()"
      position="top"
      [attr.aria-label]="'Change status (' + label() + ')'"
      (click)="$event.stopPropagation()"
    >
      <app-status-icon entity="issue" [status]="status()" />
    </button>
    <ng-template #menu>
      <hlm-dropdown-menu class="w-48">
        <hlm-dropdown-menu-label>Status</hlm-dropdown-menu-label>
        @for (s of statuses; track s) {
          <button hlmDropdownMenuItem (triggered)="pick(s)">
            <app-status-icon entity="issue" [status]="s" />
            <span class="flex-1">{{ meta[s].label }}</span>
            @if (s === status()) {
              <svg [lucideIcon]="check" [size]="14" class="text-muted-foreground"></svg>
            }
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class IssueStatusMenu {
  readonly status = input.required<IssueStatus>();
  readonly disabled = input(false);
  readonly changed = output<IssueStatus>();

  protected readonly statuses = ISSUE_STATUSES;
  protected readonly meta = ISSUE_STATUS_META;
  protected readonly check = LucideCheck;
  protected readonly label = computed(() => ISSUE_STATUS_META[this.status()].label);

  protected pick(s: IssueStatus): void {
    if (s !== this.status()) this.changed.emit(s);
  }
}

/** Priority glyph that opens a priority menu. */
@Component({
  selector: 'app-priority-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmDropdownMenuImports, HlmTooltip, LucideDynamicIcon, PriorityIcon],
  host: { class: 'inline-flex' },
  template: `
    <button
      type="button"
      class="hover:bg-accent focus-visible:ring-ring/50 -m-1 inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2 disabled:cursor-default disabled:hover:bg-transparent"
      [hlmDropdownMenuTrigger]="menu"
      align="start"
      [disabled]="disabled()"
      [hlmTooltip]="'Priority: ' + label()"
      position="top"
      [attr.aria-label]="'Change priority (' + label() + ')'"
      (click)="$event.stopPropagation()"
    >
      <app-priority-icon [priority]="priority()" />
    </button>
    <ng-template #menu>
      <hlm-dropdown-menu class="w-44">
        <hlm-dropdown-menu-label>Priority</hlm-dropdown-menu-label>
        @for (p of priorities; track p) {
          <button hlmDropdownMenuItem (triggered)="pick(p)">
            <app-priority-icon [priority]="p" />
            <span class="flex-1">{{ meta[p].label }}</span>
            @if (p === priority()) {
              <svg [lucideIcon]="check" [size]="14" class="text-muted-foreground"></svg>
            }
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class PriorityMenu {
  readonly priority = input.required<Priority>();
  readonly disabled = input(false);
  readonly changed = output<Priority>();

  protected readonly priorities = PRIORITIES;
  protected readonly meta = PRIORITY_META;
  protected readonly check = LucideCheck;
  protected readonly label = computed(() => PRIORITY_META[this.priority()].label);

  protected pick(p: Priority): void {
    if (p !== this.priority()) this.changed.emit(p);
  }
}
