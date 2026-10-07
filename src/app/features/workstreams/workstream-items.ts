// Workstream list row, board card and the draft / canceled override menu.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideBan, LucideDynamicIcon, LucideEllipsis, LucideFileText, LucideRotateCcw } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { NablaStore, type Workstream } from '../../core';
import { AvatarStack } from '../../shared/actor-avatar';
import { KeyChip } from '../../shared/key-chip';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusBadge, StatusIcon } from '../../shared/status';
import { CriteriaBar, PrChip, TargetDate, TeamDots } from './ws-parts';
import type { WsSummary } from './ws-model';

/** "⋯" menu to set / clear `statusOverride` (draft / canceled). */
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
              <app-status-icon status="draft" /> Mark as draft
            </button>
            <button hlmDropdownMenuItem (triggered)="set('canceled')">
              <app-status-icon status="canceled" /> Mark as canceled
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

/** One dense list row (32-36px): priority · key · title · PRs · teams · people · criteria · date · status. */
@Component({
  selector: 'app-workstream-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PriorityIcon, KeyChip, StatusBadge, PrChip, TeamDots, AvatarStack, CriteriaBar, TargetDate],
  host: { class: 'block' },
  template: `
    @let s = summary();
    @let w = s.ws;
    <a
      [routerLink]="['/', slug(), 'workstreams', w.key]"
      [attr.data-row-id]="w.id"
      class="hover:bg-muted/60 focus-visible:bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 outline-none sm:px-6 md:min-h-9 md:flex-nowrap"
      [class.bg-muted]="focused()"
    >
      <span class="flex min-w-0 flex-1 items-center gap-3 max-md:basis-full">
        <app-priority-icon [priority]="w.priority" />
        <app-key-chip [value]="w.key" class="w-[4.5rem]" />
        <span class="min-w-0 flex-1 truncate text-sm" [class.text-muted-foreground]="w.status === 'canceled'">{{ w.title }}</span>
      </span>
      <span class="flex items-center gap-3 max-md:order-last max-md:basis-full max-md:pl-[26px] md:contents">
        <span class="hidden items-center gap-1 lg:flex">
          @for (a of s.openPrs.slice(0, 2); track a.id) {
            <app-pr-chip [artifact]="a" />
          }
          @if (s.openPrs.length > 2) {
            <span class="text-muted-foreground text-xs">+{{ s.openPrs.length - 2 }}</span>
          }
        </span>
        <app-team-dots [ws]="w" class="max-md:hidden" />
        <span class="w-[4.5rem] max-md:hidden">
          @if (s.performers.length) {
            <app-avatar-stack [actors]="s.performers" [max]="3" [size]="20" />
          }
        </span>
        <app-criteria-bar [met]="s.criteriaMet" [inProgress]="s.criteriaInProgress" [total]="s.criteriaTotal" class="md:w-[5.5rem]" />
        <app-target-date [date]="w.targetDate" [done]="w.status === 'shipped' || w.status === 'canceled'" class="md:w-16" />
        <span class="md:order-last md:flex md:w-[6.5rem] md:justify-end max-md:order-first">
          <app-status-badge [status]="w.status" />
        </span>
      </span>
    </a>
  `,
})
export class WorkstreamRow {
  private readonly store = inject(NablaStore);
  readonly summary = input.required<WsSummary>();
  readonly focused = input(false);
  protected readonly slug = computed(() => this.store.slug() ?? '');
}

/** Board card: same signals as the row, clickable (no drag: status is derived). */
@Component({
  selector: 'app-workstream-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PriorityIcon, KeyChip, PrChip, TeamDots, AvatarStack, CriteriaBar, TargetDate, OverrideMenu],
  host: { class: 'block' },
  template: `
    @let s = summary();
    @let w = s.ws;
    <div
      class="bg-card hover:border-foreground/25 group relative rounded-lg border p-2.5 transition-colors"
      [class.border-primary]="focused()"
      [attr.data-row-id]="w.id"
    >
      <a
        [routerLink]="['/', slug(), 'workstreams', w.key]"
        class="focus-visible:ring-ring absolute inset-0 rounded-lg outline-none focus-visible:ring-2"
        [attr.aria-label]="w.key + ' ' + w.title"
      ></a>
      <div class="pointer-events-none relative flex items-center gap-1.5">
        <app-priority-icon [priority]="w.priority" />
        <app-key-chip [value]="w.key" />
        <span class="ml-auto flex items-center gap-1">
          <app-target-date [date]="w.targetDate" [done]="w.status === 'shipped' || w.status === 'canceled'" />
          <span class="pointer-events-auto -mr-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-100">
            <app-override-menu [ws]="w" size="icon-xs" />
          </span>
        </span>
      </div>
      <div class="pointer-events-none relative mt-1.5 line-clamp-2 text-sm leading-snug font-medium">{{ w.title }}</div>
      @if (s.openPrs.length) {
        <div class="pointer-events-none relative mt-2 flex flex-wrap items-center gap-1">
          @for (a of s.openPrs.slice(0, 3); track a.id) {
            <app-pr-chip [artifact]="a" />
          }
        </div>
      }
      <div class="pointer-events-none relative mt-2.5 flex items-center gap-2">
        <app-team-dots [ws]="w" />
        <app-criteria-bar [met]="s.criteriaMet" [inProgress]="s.criteriaInProgress" [total]="s.criteriaTotal" />
        <span class="ml-auto">
          @if (s.performers.length) {
            <app-avatar-stack [actors]="s.performers" [max]="3" [size]="18" />
          }
        </span>
      </div>
    </div>
  `,
})
export class WorkstreamCard {
  private readonly store = inject(NablaStore);
  readonly summary = input.required<WsSummary>();
  readonly focused = input(false);
  protected readonly slug = computed(() => this.store.slug() ?? '');
}
