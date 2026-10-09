// The workstream action menu, defined once and used as a right-click context menu (rows, cards),
// a "⋯" dropdown (cards, detail header). It renders nothing itself: hosts reference its template.
//
//   <app-ws-menu #m [ws]="w" />
//   <div [hlmContextMenuTrigger]="m.template()">…</div>
//   <button [hlmDropdownMenuTrigger]="m.template()">⋯</button>
//
// When the workstream is part of a multi-selection, every action applies to the whole selection.
import { ProviderIcon } from '../../shared/provider-icon';
import { ChangeDetectionStrategy, Component, TemplateRef, booleanAttribute, computed, inject, input, viewChild } from '@angular/core';
import {
  LucideCalendar,
  LucideCheck,
  LucideCopy,
  LucideDynamicIcon,
  LucideExternalLink,
  LucideGitBranch,
  LucideStar,
  LucideLink,
  LucideRotateCcw,
  LucideSparkles,
  LucideTrash2,
  LucideUserRound,
} from '@lucide/angular';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import {
  FavoritesStore,
  TramaStore,
  PRIORITIES,
  PRIORITY_META,
  WORKSTREAM_STATUS_FLOW,
  WORKSTREAM_STATUS_META,
  type Priority,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { Kbd } from '../../shared/kbd';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { AiActions } from '../ai-actions/ai-actions.service';
import { WsActions } from './ws-actions';

@Component({
  selector: 'app-ws-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ProviderIcon,HlmDropdownMenuImports, LucideDynamicIcon, StatusIcon, PriorityIcon, ActorAvatar, Kbd],
  host: { class: 'contents' },
  template: `
    <ng-template #menu>
      <hlm-dropdown-menu class="w-60">
        @if (targets().length > 1) {
          <hlm-dropdown-menu-label>{{ targets().length }} workstreams</hlm-dropdown-menu-label>
        }
        @if (canEdit()) {
          <hlm-dropdown-menu-group>
            <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="statusSub">
              <app-status-icon entity="workstream" [status]="ws().status" />
              Status
              <hlm-dropdown-menu-item-sub-indicator />
            </button>
            <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="prioritySub">
              <app-priority-icon [priority]="ws().priority" />
              Priority
              <hlm-dropdown-menu-item-sub-indicator />
            </button>
            <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="peopleSub">
              <svg [lucideIcon]="userIcon" [size]="14" class="text-muted-foreground"></svg>
              Accountable
              <hlm-dropdown-menu-item-sub-indicator />
            </button>
            <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="dateSub">
              <svg [lucideIcon]="calIcon" [size]="14" class="text-muted-foreground"></svg>
              Target date
              <hlm-dropdown-menu-item-sub-indicator />
            </button>
          </hlm-dropdown-menu-group>
          <hlm-dropdown-menu-separator />
        }
        @if (aiHost() && ai.available() && targets().length === 1) {
          <hlm-dropdown-menu-group>
            <button hlmDropdownMenuItem (triggered)="ai.request('update', ws().id)">
              <svg [lucideIcon]="sparkleIcon" [size]="14" class="text-entity-workstream"></svg>
              Draft status update…
            </button>
            @if (canEdit()) {
              <button hlmDropdownMenuItem (triggered)="ai.request('breakdown', ws().id)">
                <svg [lucideIcon]="sparkleIcon" [size]="14" class="text-entity-workstream"></svg>
                Break down into issues…
              </button>
            }
          </hlm-dropdown-menu-group>
          <hlm-dropdown-menu-separator />
        }
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem (triggered)="actions.copyKey(targets())">
            <svg [lucideIcon]="copyIcon" [size]="14" class="text-muted-foreground"></svg>
            Copy {{ targets().length > 1 ? 'keys' : 'key' }}
            <app-kbd keys="mod+." class="ml-auto opacity-70" />
          </button>
          <button hlmDropdownMenuItem (triggered)="actions.copyLink(targets())">
            <svg [lucideIcon]="linkIcon" [size]="14" class="text-muted-foreground"></svg>
            Copy {{ targets().length > 1 ? 'links' : 'link' }}
            <app-kbd keys="mod+shift+l" class="ml-auto opacity-70" />
          </button>
          @if (targets().length === 1) {
            <button hlmDropdownMenuItem (triggered)="actions.copyKeyAndTitle(ws())">
              <svg [lucideIcon]="copyIcon" [size]="14" class="text-muted-foreground"></svg>
              Copy key and title
            </button>
            <button hlmDropdownMenuItem (triggered)="actions.copyBranch(ws())">
              <svg [lucideIcon]="branchIcon" [size]="14" class="text-muted-foreground"></svg>
              Copy git branch name
              <app-kbd keys="mod+shift+g" class="ml-auto opacity-70" />
            </button>
            <button hlmDropdownMenuItem (triggered)="favorites.toggle('workstream', ws().id)">
              <svg [lucideIcon]="starIcon" [size]="14" class="text-muted-foreground" [attr.fill]="favorites.has('workstream', ws().id) ? 'currentColor' : 'none'"></svg>
              {{ favorites.has('workstream', ws().id) ? 'Remove from favorites' : 'Add to favorites' }}
            </button>
            @if (ws().deltaThreadUrl && store.deltaThreads()) {
              <button hlmDropdownMenuItem (triggered)="actions.openDelta(ws())">
                <app-provider-icon provider="delta" [size]="14" class="text-muted-foreground" />
                Open Delta thread
                <app-kbd keys="shift+o" class="ml-auto opacity-70" />
              </button>
            }
          }
        </hlm-dropdown-menu-group>
        @if (store.allowed('deleteWorkstreams')) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem variant="destructive" (triggered)="actions.confirmDelete(targets(), deleted)">
            <svg [lucideIcon]="trashIcon" [size]="14"></svg>
            Delete{{ targets().length > 1 ? ' ' + targets().length + ' workstreams' : '…' }}
            <app-kbd keys="mod+backspace" class="ml-auto opacity-70" />
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #statusSub>
      <hlm-dropdown-menu-sub class="w-56">
        <button hlmDropdownMenuItem (triggered)="setStatus(null)">
          <svg [lucideIcon]="autoIcon" [size]="14" class="text-muted-foreground"></svg>
          <span class="flex-1">Automatic</span>
          <span class="text-muted-foreground text-xs">{{ derivedLabel() }}</span>
          @if (!ws().statusOverride) {
            <svg [lucideIcon]="checkIcon" [size]="14" class="text-primary"></svg>
          }
        </button>
        <hlm-dropdown-menu-separator />
        @for (s of statuses; track s) {
          <button hlmDropdownMenuItem (triggered)="setStatus(s)">
            <app-status-icon entity="workstream" [status]="s" />
            <span class="flex-1">{{ statusMeta[s].label }}</span>
            @if (ws().statusOverride === s) {
              <svg [lucideIcon]="checkIcon" [size]="14" class="text-primary"></svg>
            }
          </button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>

    <ng-template #prioritySub>
      <hlm-dropdown-menu-sub class="w-48">
        @for (p of priorities; track p) {
          <button hlmDropdownMenuItem (triggered)="setPriority(p)">
            <app-priority-icon [priority]="p" />
            <span class="flex-1">{{ priorityMeta[p].label }}</span>
            @if (ws().priority === p) {
              <svg [lucideIcon]="checkIcon" [size]="14" class="text-primary"></svg>
            }
          </button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>

    <ng-template #peopleSub>
      <hlm-dropdown-menu-sub class="max-h-80 w-56 overflow-y-auto">
        <button hlmDropdownMenuItem (triggered)="setAccountable(null)">
          <span class="text-muted-foreground flex-1">Unassigned</span>
          @if (!ws().accountableUserId) {
            <svg [lucideIcon]="checkIcon" [size]="14" class="text-primary"></svg>
          }
        </button>
        @if (me(); as m) {
          <button hlmDropdownMenuItem (triggered)="setAccountable(m.id)">
            <app-actor-avatar [actor]="{ type: 'user', id: m.id }" [size]="16" />
            <span class="flex-1">Me</span>
          </button>
        }
        <hlm-dropdown-menu-separator />
        @for (u of store.users(); track u.id) {
          <button hlmDropdownMenuItem (triggered)="setAccountable(u.id)">
            <app-actor-avatar [actor]="{ type: 'user', id: u.id }" [size]="16" />
            <span class="flex-1 truncate">{{ u.name }}</span>
            @if (ws().accountableUserId === u.id) {
              <svg [lucideIcon]="checkIcon" [size]="14" class="text-primary"></svg>
            }
          </button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>

    <ng-template #dateSub>
      <hlm-dropdown-menu-sub class="w-48">
        @for (d of datePresets; track d.label) {
          <button hlmDropdownMenuItem (triggered)="setDate(d.at())">
            <span class="flex-1">{{ d.label }}</span>
          </button>
        }
        @if (ws().targetDate) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="setDate(null)">
            <span class="text-muted-foreground flex-1">Clear date</span>
          </button>
        }
      </hlm-dropdown-menu-sub>
    </ng-template>
  `,
})
export class WsMenu {
  protected readonly store = inject(TramaStore);
  protected readonly actions = inject(WsActions);
  protected readonly ai = inject(AiActions);

  readonly ws = input.required<Workstream>();
  /** Called after a confirmed delete (e.g. navigate back to the list). */
  readonly afterDelete = input<(() => void) | undefined>(undefined);
  /** The host page mounts `<app-ai-ws-actions>` (the workstream detail page): show the AI entries. */
  readonly aiHost = input(false, { transform: booleanAttribute });

  /** Reference this from `[hlmContextMenuTrigger]` / `[hlmDropdownMenuTrigger]`. */
  readonly template = viewChild<TemplateRef<unknown>>('menu');

  protected readonly statuses = WORKSTREAM_STATUS_FLOW;
  protected readonly statusMeta = WORKSTREAM_STATUS_META;
  protected readonly priorities = PRIORITIES;
  protected readonly priorityMeta = PRIORITY_META;
  protected readonly datePresets = DATE_PRESETS;
  protected readonly copyIcon = LucideCopy;
  protected readonly branchIcon = LucideGitBranch;
  protected readonly starIcon = LucideStar;
  protected readonly favorites = inject(FavoritesStore);
  protected readonly linkIcon = LucideLink;
  protected readonly extIcon = LucideExternalLink;
  protected readonly trashIcon = LucideTrash2;
  protected readonly checkIcon = LucideCheck;
  protected readonly autoIcon = LucideRotateCcw;
  protected readonly userIcon = LucideUserRound;
  protected readonly calIcon = LucideCalendar;
  protected readonly sparkleIcon = LucideSparkles;

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly me = this.store.me;
  protected readonly targets = computed(() => {
    // re-evaluated whenever the selection changes
    this.actions.selected();
    return this.actions.targetsFor(this.ws());
  });
  protected readonly derivedLabel = computed(() => WORKSTREAM_STATUS_META[this.ws().derivedStatus].label);
  protected readonly deleted = (): void => this.afterDelete()?.();

  protected setStatus(s: WorkstreamStatus | null): void {
    this.actions.setStatus(this.targets(), s);
  }
  protected setPriority(p: Priority): void {
    this.actions.setPriority(this.targets(), p);
  }
  protected setAccountable(id: string | null): void {
    this.actions.setAccountable(this.targets(), id);
  }
  protected setDate(date: Date | null): void {
    this.actions.setTargetDate(this.targets(), date);
  }
}

/** Quick target-date choices ("end of week" = the coming Friday). */
export const DATE_PRESETS: { label: string; at: () => Date }[] = [
  { label: 'Today', at: () => daysFromNow(0) },
  { label: 'Tomorrow', at: () => daysFromNow(1) },
  { label: 'End of this week', at: () => daysFromNow(daysUntilFriday()) },
  { label: 'In one week', at: () => daysFromNow(7) },
  { label: 'In two weeks', at: () => daysFromNow(14) },
  { label: 'In one month', at: () => daysFromNow(30) },
];

function daysUntilFriday(): number {
  const d = new Date().getDay(); // 0 Sun … 6 Sat
  return d <= 5 ? 5 - d : 6;
}

export function daysFromNow(days: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}
