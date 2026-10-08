// Floating bar shown while workstream rows are multi-selected: status, priority, accountable,
// target date, copy and delete for the whole selection (bulk edits toast with Undo).
import { ChangeDetectionStrategy, Component, computed, effect, inject, untracked, viewChild } from '@angular/core';
import { LucideCalendar, LucideCopy, LucideDynamicIcon, LucideTrash2, LucideUserRound, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, UiStore, type Priority, type WorkstreamStatus } from '../../core';
import { Kbd } from '../../shared/kbd';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { Picker, type PickOption } from './picker';

const AUTO = '__auto';
import { WsActions } from './ws-actions';
import { WsDatePicker } from './ws-parts';
import { priorityOptions, statusOptions, userOptions } from './ws-model';

@Component({
  selector: 'app-ws-bulk-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmTooltip, LucideDynamicIcon, Kbd, Picker, PriorityIcon, StatusIcon, WsDatePicker],
  host: { class: 'contents' },
  template: `
    @if (selected().length) {
      <div
        class="bg-popover text-popover-foreground fixed bottom-5 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-1 overflow-x-auto rounded-lg border border-border-strong p-1 text-[13px] shadow-[var(--shadow-menu)]"
        role="toolbar"
        aria-label="Bulk actions"
      >
        <span class="flex items-center gap-1.5 pr-1.5 pl-2 whitespace-nowrap">
          <span class="bg-primary text-primary-foreground rounded px-1.5 text-xs font-medium tabular-nums">{{ selected().length }}</span>
          selected
        </span>
        <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground" hlmTooltip="Clear selection (Esc)" aria-label="Clear selection" (click)="ui.clearSelected()">
          <svg [lucideIcon]="xIcon" [size]="13"></svg>
        </button>
        @if (canEdit()) {
          <span class="bg-border mx-1 h-5 w-px shrink-0"></span>
          <app-picker #statusPicker variant="bare" label="Set status" triggerClass="h-7 gap-1.5 px-2" [searchable]="false" [options]="statuses" [value]="[]" (valueChange)="setStatus($event[0])">
            <app-status-icon entity="workstream" status="working" />Status<app-kbd keys="s" class="opacity-60" />
          </app-picker>
          <app-picker #priorityPicker variant="bare" label="Set priority" triggerClass="h-7 gap-1.5 px-2" [searchable]="false" [options]="priorities" [value]="[]" (valueChange)="setPriority($event[0])">
            <app-priority-icon priority="high" />Priority<app-kbd keys="p" class="opacity-60" />
          </app-picker>
          <app-picker #accountablePicker variant="bare" label="Set accountable" triggerClass="h-7 gap-1.5 px-2" [options]="users()" [value]="[]" (valueChange)="setAccountable($event[0])">
            <svg [lucideIcon]="userIcon" [size]="14" class="text-muted-foreground"></svg>Accountable<app-kbd keys="a" class="opacity-60" />
          </app-picker>
          <app-ws-date-picker #datePicker label="Set target date" triggerClass="h-7 gap-1.5 px-2" (dateChange)="actions.setTargetDate(selected(), $event)">
            <svg [lucideIcon]="calIcon" [size]="14" class="text-muted-foreground"></svg>Date
          </app-ws-date-picker>
        }
        <span class="bg-border mx-1 h-5 w-px shrink-0"></span>
        <button hlmBtn variant="ghost" size="sm" class="h-7 gap-1.5 px-2 font-normal" (click)="actions.copyKey(selected())">
          <svg [lucideIcon]="copyIcon" [size]="14" class="text-muted-foreground"></svg>Copy keys
        </button>
        @if (canEdit()) {
          <button hlmBtn variant="ghost" size="sm" class="text-destructive hover:text-destructive h-7 gap-1.5 px-2 font-normal" (click)="actions.confirmDelete(selected())">
            <svg [lucideIcon]="trashIcon" [size]="14"></svg>Delete
          </button>
        }
      </div>
    }
  `,
})
export class WsBulkBar {
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly actions = inject(WsActions);

  protected readonly selected = computed(() => this.actions.selected());
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly statuses: PickOption[] = [{ value: AUTO, label: 'Automatic (derived)' }, ...statusOptions()];
  protected readonly priorities = priorityOptions();
  protected readonly users = computed<PickOption[]>(() => [{ value: AUTO, label: 'Unassign' }, ...userOptions(this.store)]);
  protected readonly xIcon = LucideX;
  protected readonly copyIcon = LucideCopy;
  protected readonly trashIcon = LucideTrash2;
  protected readonly userIcon = LucideUserRound;
  protected readonly calIcon = LucideCalendar;

  private readonly statusPicker = viewChild<Picker>('statusPicker');
  private readonly priorityPicker = viewChild<Picker>('priorityPicker');
  private readonly accountablePicker = viewChild<Picker>('accountablePicker');
  private readonly datePicker = viewChild<WsDatePicker>('datePicker');

  constructor() {
    effect(() => {
      const i = this.actions.intent();
      if (!i || i.target !== 'bulk') return;
      untracked(() => {
        const picker =
          i.kind === 'status' ? this.statusPicker() : i.kind === 'priority' ? this.priorityPicker() : i.kind === 'accountable' ? this.accountablePicker() : null;
        if (picker && this.actions.consume(i.kind, 'bulk')) picker.open();
        else if (i.kind === 'date' && this.datePicker() && this.actions.consume('date', 'bulk')) this.datePicker()!.open();
      });
    });
  }

  protected setStatus(v: string | undefined): void {
    if (v) this.actions.setStatus(this.selected(), v === AUTO ? null : (v as WorkstreamStatus));
  }
  protected setAccountable(v: string | undefined): void {
    if (v) this.actions.setAccountable(this.selected(), v === AUTO ? null : v);
  }
  protected setPriority(v: string | undefined): void {
    if (v) this.actions.setPriority(this.selected(), v as Priority);
  }
}
