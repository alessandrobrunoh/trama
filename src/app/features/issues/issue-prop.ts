// Inline property editors: a glyph button that opens a searchable popover (rows, cards, detail),
// and the centered command dialog opened by s / p / a / w / bulk actions.
import { ChangeDetectionStrategy, Component, booleanAttribute, computed, inject, input, signal } from '@angular/core';
import { LucideCircleUserRound, LucideDynamicIcon } from '@lucide/angular';
import { HlmCommandImports } from '@spartan-ng/helm/command';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { ISSUE_STATUS_META, NablaStore, PRIORITY_META, type Issue } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { IssueActions } from './issue-actions';
import { PROMPT_TITLE } from './issue-options';
import { IssueOptionList } from './issue-option-list';

type PropField = 'status' | 'priority' | 'assignee';
const KEY: Record<PropField, string> = { status: 'S', priority: 'P', assignee: 'A' };

/** `<app-issue-prop [issue]="i" field="status" />` — click the glyph to change it in place. */
@Component({
  selector: 'app-issue-prop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmPopoverImports, HlmTooltip, IssueOptionList, StatusIcon, PriorityIcon, ActorAvatar, LucideDynamicIcon],
  host: { class: 'inline-flex shrink-0' },
  template: `
    @let i = issue();
    <hlm-popover align="start" sideOffset="4" [state]="state()" (stateChanged)="state.set($event)">
      <button
        hlmPopoverTrigger
        type="button"
        class="hover:bg-accent focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 disabled:pointer-events-none"
        [class]="showLabel() ? 'h-7 px-1.5 text-[13px]' : 'size-6 justify-center'"
        [disabled]="!canEdit()"
        [hlmTooltip]="tip()"
        [tooltipDisabled]="showLabel() || !canEdit()"
        [attr.aria-label]="tip()"
        (click)="$event.stopPropagation()"
      >
        @switch (field()) {
          @case ('status') {
            <app-status-icon [status]="i.status" entity="issue" [size]="size()" />
            @if (showLabel()) {
              <span>{{ statusLabel() }}</span>
            }
          }
          @case ('priority') {
            <app-priority-icon [priority]="i.priority" />
            @if (showLabel()) {
              <span>{{ priorityLabel() }}</span>
            }
          }
          @default {
            @if (i.assigneeId) {
              <app-actor-avatar [actor]="{ type: 'user', id: i.assigneeId }" [size]="avatarSize()" />
              @if (showLabel()) {
                <span class="truncate">{{ store.getUser(i.assigneeId)?.name ?? 'Unknown' }}</span>
              }
            } @else {
              <svg [lucideIcon]="noUser" [size]="avatarSize()" [strokeWidth]="1.5" class="text-muted-foreground/70"></svg>
              @if (showLabel()) {
                <span class="text-muted-foreground">Unassigned</span>
              }
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
export class IssueProp {
  protected readonly store = inject(NablaStore);
  readonly issue = input.required<Issue>();
  readonly field = input.required<PropField>();
  readonly showLabel = input(false, { transform: booleanAttribute });
  readonly size = input(14);
  readonly avatarSize = input(18);

  protected readonly state = signal<'open' | 'closed'>('closed');
  protected readonly noUser = LucideCircleUserRound;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly statusLabel = computed(() => ISSUE_STATUS_META[this.issue().status].label);
  protected readonly priorityLabel = computed(() => PRIORITY_META[this.issue().priority].label);
  protected readonly tip = computed(() => {
    const i = this.issue();
    const what =
      this.field() === 'status'
        ? `Status: ${this.statusLabel()}`
        : this.field() === 'priority'
          ? `Priority: ${this.priorityLabel()}`
          : i.assigneeId
            ? `Assignee: ${this.store.getUser(i.assigneeId)?.name ?? 'Unknown'}`
            : 'Assign';
    return `${what}  ·  ${KEY[this.field()]}`;
  });
}

/** Centered "Change status…" dialog for the issues in `IssueActions.prompt()`. Mount once per page. */
@Component({
  selector: 'app-issue-command-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmCommandImports, IssueOptionList],
  template: `
    <hlm-command-dialog
      [title]="title()"
      description="Pick a value; Esc closes."
      [state]="prompt() ? 'open' : 'closed'"
      (stateChange)="$event === 'closed' && actions.closePrompt()"
      dialogContentClass="sm:max-w-lg top-[14%] sm:top-[20%] translate-y-0 max-sm:max-w-[calc(100%-1rem)]"
    >
      @if (prompt(); as p) {
        <div class="text-muted-foreground flex items-center gap-2 border-b px-3 pt-2.5 pb-2 text-xs">
          <span class="bg-muted text-foreground rounded px-1.5 py-0.5 font-mono text-[11px]">{{ actions.subject(p.ids) }}</span>
          @if (p.ids.length === 1) {
            <span class="truncate">{{ firstTitle() }}</span>
          }
        </div>
        <app-issue-option-list [field]="p.field" [ids]="p.ids" (done)="actions.closePrompt()" />
      }
    </hlm-command-dialog>
  `,
})
export class IssueCommandDialog {
  protected readonly actions = inject(IssueActions);
  protected readonly prompt = this.actions.prompt;
  protected readonly title = computed(() => {
    const p = this.prompt();
    return p ? PROMPT_TITLE[p.field] : 'Issue';
  });
  protected readonly firstTitle = computed(() => {
    const p = this.prompt();
    return p ? (this.actions.issues(p.ids)[0]?.title ?? '') : '';
  });
}
