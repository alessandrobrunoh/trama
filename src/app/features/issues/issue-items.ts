// Issue list row and board card.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NablaStore, type Issue } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { IssueKindLabel } from '../../shared/issue';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusBadge } from '../../shared/status';

/** One dense list row: priority · type · key · title · team · assignee · status. */
@Component({
  selector: 'app-issue-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PriorityIcon, IssueKindLabel, KeyChip, ActorAvatar, StatusBadge],
  host: { class: 'block' },
  template: `
    @let i = issue();
    <a
      [routerLink]="['/', slug(), 'issues', i.key]"
      [attr.data-row-id]="i.id"
      class="hover:bg-muted/60 focus-visible:bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 outline-none sm:px-6 md:min-h-9 md:flex-nowrap"
      [class.bg-muted]="focused()"
    >
      <span class="flex min-w-0 flex-1 items-center gap-3 max-md:basis-full">
        <app-priority-icon [priority]="i.priority" />
        <app-issue-kind [kind]="i.kind" />
        <app-key-chip [value]="i.key" class="w-[5.5rem]" />
        <span class="min-w-0 flex-1 truncate text-sm" [class.text-muted-foreground]="quiet()">{{ i.title }}</span>
      </span>
      <span class="flex items-center gap-3 max-md:basis-full max-md:pl-[26px] md:contents">
        <span class="text-muted-foreground w-16 truncate text-xs max-md:hidden">{{ teamKey() }}</span>
        <span class="flex w-6 justify-center max-md:hidden">
          @if (i.assigneeId) {
            <app-actor-avatar [actor]="{ type: 'user', id: i.assigneeId }" [size]="20" />
          }
        </span>
        <span class="md:flex md:w-[6.5rem] md:justify-end">
          <app-status-badge [status]="i.status" />
        </span>
      </span>
    </a>
  `,
})
export class IssueRow {
  private readonly store = inject(NablaStore);
  readonly issue = input.required<Issue>();
  readonly focused = input(false);
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly quiet = computed(() => {
    const s = this.issue().status;
    return s === 'done' || s === 'canceled';
  });
  protected readonly teamKey = computed(() => {
    const id = this.issue().teamId;
    return id ? (this.store.getTeam(id)?.key ?? '') : '';
  });
}

/** Board card for one issue. */
@Component({
  selector: 'app-issue-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PriorityIcon, IssueKindLabel, KeyChip, ActorAvatar],
  host: { class: 'block' },
  template: `
    @let i = issue();
    <div
      class="bg-card hover:border-foreground/25 relative rounded-lg border p-2.5 transition-colors"
      [class.border-primary]="focused()"
      [attr.data-row-id]="i.id"
    >
      <a
        [routerLink]="['/', slug(), 'issues', i.key]"
        class="focus-visible:ring-ring absolute inset-0 rounded-lg outline-none focus-visible:ring-2"
        [attr.aria-label]="i.key + ' ' + i.title"
      ></a>
      <div class="pointer-events-none relative flex items-center gap-1.5">
        <app-priority-icon [priority]="i.priority" />
        <app-issue-kind [kind]="i.kind" />
        <app-key-chip [value]="i.key" />
        <span class="ml-auto">
          @if (i.assigneeId) {
            <app-actor-avatar [actor]="{ type: 'user', id: i.assigneeId }" [size]="18" />
          }
        </span>
      </div>
      <div class="pointer-events-none relative mt-1.5 line-clamp-2 text-sm leading-snug font-medium" [class.text-muted-foreground]="quiet()">
        {{ i.title }}
      </div>
      @if (teamKey()) {
        <div class="text-muted-foreground pointer-events-none relative mt-2 text-xs">{{ teamKey() }}</div>
      }
    </div>
  `,
})
export class IssueCard {
  private readonly store = inject(NablaStore);
  readonly issue = input.required<Issue>();
  readonly focused = input(false);
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly quiet = computed(() => {
    const s = this.issue().status;
    return s === 'done' || s === 'canceled';
  });
  protected readonly teamKey = computed(() => {
    const id = this.issue().teamId;
    return id ? (this.store.getTeam(id)?.key ?? '') : '';
  });
}
