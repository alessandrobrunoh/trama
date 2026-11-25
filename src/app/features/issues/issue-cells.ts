// The v3 cells of a task row / board card that edit in place: a v3 atom (status box, priority bars,
// avatar, EST chip) as the trigger of the same searchable option popover the old glyph buttons opened.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideDynamicIcon, LucideUserPlus } from '@lucide/angular';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, formatEstimate, formatEstimateLong, type Issue } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { V3Priority, V3Status } from '../../shared/v3';
import { IssueOptionList } from './issue-option-list';

type CellField = 'status' | 'priority' | 'assignee' | 'estimate';
const KEY: Record<CellField, string> = { status: 'S', priority: 'P', assignee: 'A', estimate: 'E' };

/**
 * `<app-issue-cell [issue]="i" field="status" />` — the task's status / priority / assignee / estimate as
 * its v3 atom; click to change it in place (members only).
 */
@Component({
  selector: 'app-issue-cell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmPopoverImports, HlmTooltip, IssueOptionList, V3Status, V3Priority, ActorAvatar, LucideDynamicIcon],
  host: { class: 'inline-flex shrink-0' },
  template: `
    @let i = issue();
    <hlm-popover align="start" sideOffset="4" [state]="state()" (stateChanged)="state.set($event)">
      <button
        hlmPopoverTrigger
        type="button"
        class="focus-visible:ring-ring inline-flex items-center outline-none focus-visible:ring-1 disabled:pointer-events-none"
        [class.hover:bg-hover]="canEdit()"
        [disabled]="!canEdit()"
        [hlmTooltip]="tip()"
        [tooltipDisabled]="!canEdit()"
        [attr.aria-label]="tip()"
        (click)="$event.stopPropagation()"
      >
        @switch (field()) {
          @case ('status') {
            <v3-status [status]="i.status" />
          }
          @case ('priority') {
            <v3-priority [priority]="i.priority" [label]="showLabel()" />
          }
          @case ('estimate') {
            <span
              class="inline-flex items-center gap-[5px] border px-1.5 py-0.5 font-mono whitespace-nowrap"
              [class]="hasEstimate() ? 'border-border' : 'border-[#3a3e45]'"
            >
              <span class="text-faint text-[9.5px] leading-[13px]">EST</span>
              <span
                class="text-[11px] leading-[14px] font-semibold"
                [class]="hasEstimate() ? 'text-foreground' : 'text-faint'"
                >{{ estimateText() }}</span
              >
            </span>
          }
          @default {
            @if (i.assigneeId) {
              <app-actor-avatar [actor]="{ type: 'user', id: i.assigneeId }" [size]="22" />
            } @else {
              <span
                class="border-border text-faint inline-flex size-[22px] items-center justify-center border border-dashed"
              >
                <svg [lucideIcon]="assignIcon" [size]="12" [strokeWidth]="1.5"></svg>
              </span>
            }
          }
        }
      </button>
      <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-60 p-0" (click)="$event.stopPropagation()">
        <app-issue-option-list [field]="field()" [ids]="[i.id]" (done)="state.set('closed')" />
      </hlm-popover-content>
    </hlm-popover>
  `,
})
export class IssueCell {
  private readonly store = inject(TramaStore);
  readonly issue = input.required<Issue>();
  readonly field = input.required<CellField>();
  /** Priority: bars with the word next to them (rows) or the bars alone (cards). */
  readonly showLabel = input(true);

  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly assignIcon = LucideUserPlus;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly hasEstimate = computed(() => {
    const e = this.issue().estimate;
    return e !== undefined && e !== null;
  });
  protected readonly estimateText = computed(() =>
    this.hasEstimate() ? formatEstimate(this.issue().estimate, this.store.estimateScale()) : '—',
  );
  protected readonly tip = computed(() => {
    const i = this.issue();
    const what =
      this.field() === 'status'
        ? 'Change status'
        : this.field() === 'priority'
          ? 'Change priority'
          : this.field() === 'estimate'
            ? this.hasEstimate()
              ? `Estimate: ${formatEstimateLong(i.estimate, this.store.estimateScale())}`
              : 'Set estimate'
            : i.assigneeId
              ? `Assignee: ${this.store.getUser(i.assigneeId)?.name ?? 'Unknown'}`
              : 'Assign';
    return `${what}  ·  ${KEY[this.field()]}`;
  });
}
