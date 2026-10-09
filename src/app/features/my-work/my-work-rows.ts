// Dense rows for My Work: issues (circle glyphs, inline status/priority) and workstreams
// (hexagon glyphs, issue progress, why it is on my list).
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUS_META,
  TramaStore,
  Notifier,
  PRIORITY_META,
  isOverdue,
  type Issue,
  type IssueStatus,
  type Priority,
  type Workstream,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EntityChip } from '../../shared/entity-chip';
import { IssueKindLabel } from '../../shared/issue';
import { ShortDatePipe } from '../../shared/pipes';
import { StatusIcon, statusLabel } from '../../shared/status';
import { AgoPipe } from '../overview/ago';
import { IssueStatusMenu, PriorityMenu } from './inline-menus';

const ROW =
  'group/row hover:bg-hover data-[focused]:bg-accent/70 flex h-9 items-center gap-2.5 border-b border-border/60 px-4 outline-none sm:px-6';

/** My issue: priority · status · type · key · title · workstreams · team · updated. */
@Component({
  selector: 'app-my-issue-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmTooltip, IssueStatusMenu, PriorityMenu, IssueKindLabel, EntityChip, AgoPipe],
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
      <span class="hidden min-w-0 items-center gap-1 md:flex">
        @for (w of i.workstreamIds.slice(0, 2); track w) {
          <app-entity-chip type="workstream" [ref]="w" compact />
        }
        @if (i.workstreamIds.length > 2) {
          <span class="text-meta">+{{ i.workstreamIds.length - 2 }}</span>
        }
      </span>
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

  protected async setStatus(status: IssueStatus): Promise<void> {
    const i = this.issue();
    const prev = i.status;
    if (await this.store.updateIssue(i.id, { status })) {
      this.notifier.success(`${i.key} → ${ISSUE_STATUS_META[status].label}`, {
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

/** My workstream: priority · hexagon status · key · title · why · issue progress · owner · target. */
@Component({
  selector: 'app-my-workstream-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmTooltip, PriorityMenu, StatusIcon, ActorAvatar, ShortDatePipe],
  host: { class: 'block' },
  template: `
    @let w = ws();
    <div [class]="row" [attr.data-row-id]="w.id" [attr.data-focused]="focused() ? '' : null">
      <app-priority-menu [priority]="w.priority" [disabled]="!canEdit()" (changed)="setPriority($event)" />
      <span class="inline-flex size-4 items-center justify-center" [hlmTooltip]="statusText()" position="top">
        <app-status-icon entity="workstream" [status]="w.status" />
      </span>
      <a [routerLink]="['/', slug(), 'workstreams', w.key]" class="flex min-w-0 flex-1 items-center gap-2.5 self-stretch">
        <span class="text-muted-foreground w-[4.25rem] shrink-0 truncate font-mono text-[11px] max-sm:hidden">{{ w.key }}</span>
        <span class="min-w-0 truncate text-sm" [class.text-muted-foreground]="w.status === 'canceled'">{{ w.title }}</span>
      </a>
      @if (reasons().length) {
        <span class="hidden min-w-0 items-center gap-1 md:flex">
          @for (r of reasons(); track r) {
            <span class="border-border-strong text-muted-foreground inline-flex h-5 items-center rounded-full border px-1.5 text-[11px] whitespace-nowrap">{{ r }}</span>
          }
        </span>
      }
      @if (progress(); as p) {
        <span class="flex items-center gap-1.5 max-sm:hidden" [hlmTooltip]="p.done + ' of ' + p.total + ' linked issues done'" position="top">
          <span class="bg-foreground/[0.08] h-1 w-10 overflow-hidden rounded-full">
            <span class="bg-status-shipped block h-full rounded-full" [style.width.%]="(p.done / p.total) * 100"></span>
          </span>
          <span class="text-meta w-8 tabular-nums">{{ p.done }}/{{ p.total }}</span>
        </span>
      } @else {
        <span class="text-meta w-[4.5rem] max-sm:hidden">no issues</span>
      }
      <span class="flex w-5 justify-center">
        @if (w.accountableUserId) {
          <app-actor-avatar [actor]="{ type: 'user', id: w.accountableUserId }" [size]="18" />
        }
      </span>
      <span class="text-meta w-12 text-end tabular-nums" [class.text-status-blocked]="overdue()">{{ w.targetDate | shortDate }}</span>
    </div>
  `,
})
export class MyWorkstreamRow {
  private readonly store = inject(TramaStore);
  readonly ws = input.required<Workstream>();
  /** Short reasons this workstream is on my list ("AUTH team", "2 of my issues"). */
  readonly reasons = input<readonly string[]>([]);
  readonly focused = input(false);

  protected readonly row = ROW;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly statusText = computed(() => {
    const w = this.ws();
    return statusLabel(w.status) + (w.statusOverride ? ' (set manually)' : '');
  });
  protected readonly overdue = computed(() => {
    const w = this.ws();
    return w.status !== 'shipped' && w.status !== 'canceled' && isOverdue(w.targetDate);
  });
  protected readonly progress = computed(() => {
    const issues = (this.store.issuesByWorkstream().get(this.ws().id) ?? []).filter((i) => i.status !== 'canceled');
    return issues.length ? { done: issues.filter((i) => i.status === 'done').length, total: issues.length } : null;
  });

  protected setPriority(priority: Priority): void {
    void this.store.updateWorkstream(this.ws().id, { priority });
  }
}
