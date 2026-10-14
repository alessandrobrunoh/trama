// Dense rows for assigned issues: inline status and priority controls.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUS_META,
  TramaStore,
  resolveStatusEntry,
  Notifier,
  PRIORITY_META,
  type Issue,
  type Priority,
} from '../../core';
import { IssueKindLabel } from '../../shared/issue';
import { AgoPipe } from '../overview/ago';
import { IssueStatusMenu, PriorityMenu } from './inline-menus';

const ROW =
  'group/row hover:bg-hover data-[focused]:bg-accent/70 flex h-9 items-center gap-2.5 border-b border-border/60 px-4 outline-none sm:px-6';

/** My issue: priority · status · type · key · title · team · updated. */
@Component({
  selector: 'app-my-issue-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmTooltip, IssueStatusMenu, PriorityMenu, IssueKindLabel, AgoPipe],
  host: { class: 'block' },
  template: `
    @let i = issue();
    <div [class]="row" [attr.data-row-id]="i.id" [attr.data-focused]="focused() ? '' : null">
      <app-priority-menu [priority]="i.priority" [disabled]="!canEdit()" (changed)="setPriority($event)" />
      <app-issue-status-menu [status]="i.status" [disabled]="!canEdit()" (changed)="setStatus($event)" />
      <a [routerLink]="['/', slug(), 'issues', i.key]" class="flex min-w-0 flex-1 items-center gap-2.5 self-stretch">
        <span class="text-muted-foreground w-[4.75rem] shrink-0 truncate font-mono text-[11px] max-sm:hidden">{{ i.key }}</span>
        <span class="min-w-0 truncate text-sm" [class.text-muted-foreground]="quiet()">{{ i.title }}</span>
      </a>
      <app-issue-kind [kind]="i.kind" class="max-sm:hidden" />
      <span class="text-meta w-10 truncate max-lg:hidden">{{ teamKey() }}</span>
      <span class="text-meta w-8 text-end tabular-nums" [hlmTooltip]="'Updated ' + (i.updatedAt | ago)" position="left">{{ i.updatedAt | ago }}</span>
    </div>
  `,
})
export class MyIssueRow {
  private readonly store = inject(TramaStore);
  private readonly notifier = inject(Notifier);
  readonly issue = input.required<Issue>();
  readonly focused = input(false);

  protected readonly row = ROW;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly quiet = computed(() => {
    const s = this.issue().status;
    return s === 'done' || s === 'canceled';
  });
  protected readonly teamKey = computed(() => this.store.getTeam(this.issue().teamId)?.key ?? '');

  protected async setStatus(status: string): Promise<void> {
    const i = this.issue();
    const prev = i.status;
    const name = resolveStatusEntry(this.store.settings().statuses.issue, status)?.name ?? status;
    if (await this.store.updateIssue(i.id, { status })) {
      this.notifier.success(`${i.key} → ${name}`, {
        action: { label: 'Undo', run: () => void this.store.updateIssue(i.id, { status: prev }) },
      });
    }
  }

  protected async setPriority(priority: Priority): Promise<void> {
    const i = this.issue();
    const prev = i.priority;
    if (await this.store.updateIssue(i.id, { priority })) {
      this.notifier.success(`${i.key} priority → ${PRIORITY_META[priority].label}`, {
        action: { label: 'Undo', run: () => void this.store.updateIssue(i.id, { priority: prev }) },
      });
    }
  }
}
