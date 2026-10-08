import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  LucideArrowDownWideNarrow,
  LucideArrowUpNarrowWide,
  LucideBookmarkPlus,
  LucideDynamicIcon,
  LucideLayoutList,
  LucideListFilter,
  LucidePlus,
  LucideSearch,
  LucideSquareKanban,
  LucideWorkflow,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import {
  Notifier,
  NablaStore,
  UiStore,
  PRIORITY_META,
  WORKSTREAM_STATUS_FLOW,
  WORKSTREAM_STATUS_META,
  filterValues,
  queryGroups,
  setFilter,
  usePageShortcuts,
  type Priority,
  type ViewFilter,
  type Workstream,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Kanban, KanbanItemDirective, KanbanLabelDirective } from '../../shared/kanban';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { TopBarActions } from '../../layout/page-chrome';
import { CreateWorkstreamDialog } from './create-workstream-dialog';
import { Picker, type PickOption } from './picker';
import {
  buildSummary,
  labelOptions,
  priorityOptions,
  repoOptions,
  statusOptions,
  teamOptions,
  userOptions,
  type WsSummary,
} from './ws-model';
import { WorkstreamCard, WorkstreamRow } from './workstream-items';

type Layout = 'list' | 'board';
type GroupField = 'status' | 'ownerTeamId' | 'priority' | 'accountableUserId';

const LAYOUT_KEY = 'nabla.workstreams.layout';
const GROUP_OPTIONS: PickOption[] = [
  { value: 'status', label: 'Status' },
  { value: 'ownerTeamId', label: 'Owner team' },
  { value: 'priority', label: 'Priority' },
  { value: 'accountableUserId', label: 'Accountable' },
];
const SORT_OPTIONS: PickOption[] = [
  { value: 'updatedAt', label: 'Updated' },
  { value: 'priority', label: 'Priority' },
  { value: 'targetDate', label: 'Target date' },
  { value: 'createdAt', label: 'Created' },
  { value: 'title', label: 'Title' },
];

interface Column {
  key: string;
  items: WsSummary[];
}

function loadLayout(): Layout {
  try {
    return globalThis.localStorage?.getItem(LAYOUT_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

@Component({
  selector: 'app-workstream-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmInputImports,
    HlmLabelImports,
    HlmPopoverImports,
    HlmSwitchImports,
    HlmToggleGroupImports,
    LucideDynamicIcon,
    PageHeader,
    Picker,
    Kbd,
    EmptyState,
    StatusIcon,
    PriorityIcon,
    ActorAvatar,
    WorkstreamRow,
    WorkstreamCard,
    Kanban,
    KanbanItemDirective,
    KanbanLabelDirective,
    CreateWorkstreamDialog,
    TopBarActions,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn size="sm" (click)="createOpen.set(true)">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New workstream</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Workstreams" [description]="description()">
      <div actions>
        <hlm-toggle-group type="single" variant="outline" size="sm" [value]="layout()" (valueChange)="setLayout($event)">
          <button hlmToggleGroupItem value="list" aria-label="List layout" class="gap-1.5 px-2.5">
            <svg [lucideIcon]="listIcon" [size]="14"></svg><span class="max-sm:hidden">List</span>
          </button>
          <button hlmToggleGroupItem value="board" aria-label="Board layout" class="gap-1.5 px-2.5">
            <svg [lucideIcon]="boardIcon" [size]="14"></svg><span class="max-sm:hidden">Board</span>
          </button>
        </hlm-toggle-group>
      </div>
    </app-page-header>

    <!-- toolbar -->
    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2 sm:px-6">
      <div class="relative w-full sm:w-52">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input
          hlmInput
          class="h-7 w-full pl-8 text-xs"
          placeholder="Search workstreams…"
          aria-label="Search workstreams"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
      </div>
      <div class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full">
        <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statuses" [value]="fv('status')" (valueChange)="setF('status', $event)" />
        <app-picker variant="chip" label="Team" [multiple]="true" [options]="teams()" [value]="fv('teamId')" (valueChange)="setF('teamId', $event)" />
        <app-picker variant="chip" label="Priority" [multiple]="true" [searchable]="false" [options]="priorities" [value]="fv('priority')" (valueChange)="setF('priority', $event)" />
        <app-picker variant="chip" label="Accountable" [multiple]="true" [options]="users()" [value]="fv('accountableUserId')" (valueChange)="setF('accountableUserId', $event)" />
        <app-picker variant="chip" label="Project" [multiple]="true" [options]="repos()" [value]="fv('repositoryIds')" (valueChange)="setF('repositoryIds', $event)" />
        @if (labels().length) {
          <app-picker variant="chip" label="Label" [multiple]="true" [options]="labels()" [value]="fv('labels')" (valueChange)="setF('labels', $event)" />
        }
        @if (hasFilters()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs" (click)="clearFilters()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        @if (hasFilters()) {
          <hlm-popover align="end" sideOffset="4" [state]="saveState()" (stateChanged)="saveState.set($event)">
            <button hlmBtn hlmPopoverTrigger variant="ghost" size="sm" class="h-7 gap-1 px-2 text-xs">
              <svg [lucideIcon]="bookmark" [size]="13"></svg><span class="max-sm:hidden">Save view</span>
            </button>
            <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-72">
              <hlm-popover-header>
                <h3 hlmPopoverTitle>Save as view</h3>
                <p hlmPopoverDescription class="text-xs">Keeps the current filters, grouping and layout.</p>
              </hlm-popover-header>
              <div class="grid gap-2">
                <input
                  hlmInput
                  class="h-8"
                  placeholder="View name"
                  aria-label="View name"
                  [value]="viewName()"
                  (input)="viewName.set($any($event.target).value)"
                  (keydown.enter)="saveView()"
                />
                <label class="flex items-center gap-2 text-xs">
                  <hlm-switch [checked]="viewShared()" (checkedChange)="viewShared.set($event)" aria-label="Share with workspace" />
                  Share with the workspace
                </label>
                <button hlmBtn size="sm" [disabled]="!viewName().trim()" (click)="saveView()">Save view</button>
              </div>
            </hlm-popover-content>
          </hlm-popover>
        }
        <app-picker variant="ghost" label="Sort" [icon]="null" [searchable]="false" [options]="sorts" [value]="[sortField()]" (valueChange)="sortField.set($any($event[0] ?? 'updatedAt'))" />
        <button hlmBtn variant="ghost" size="icon-sm" [attr.aria-label]="sortDir() === 'asc' ? 'Ascending' : 'Descending'" (click)="toggleDir()">
          <svg [lucideIcon]="sortDir() === 'asc' ? ascIcon : descIcon" [size]="14"></svg>
        </button>
        @if (layout() === 'list') {
          <app-picker variant="ghost" label="Group by" [searchable]="false" [options]="groupOptions" [value]="[groupBy()]" (valueChange)="groupBy.set($any($event[0] ?? 'status'))" />
        }
      </div>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="flow" title="No workstreams yet" description="A workstream groups the problems a team decided to solve together and connects them to the work.">
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="createOpen.set(true)"><svg [lucideIcon]="plus" [size]="14"></svg>New workstream</button>
        }
      </app-empty-state>
    } @else if (shown() === 0) {
      <app-empty-state [icon]="filterIcon" title="No workstreams match" description="Try removing a filter or changing the search.">
        <button hlmBtn size="sm" variant="outline" (click)="clearAll()">Clear filters</button>
      </app-empty-state>
    } @else {
      <app-kanban
        [columns]="columns()"
        [layout]="layout()"
        [disabled]="!canEdit()"
        prefix="workstreams"
        [track]="trackSummary"
        (moved)="move($event.item, $event.to)"
      >
        <ng-template kanbanItem let-s>
          @if (layout() === 'list') {
            <app-workstream-row [summary]="s" [focused]="ui.focusedRowId() === s.ws.id" />
          } @else {
            <app-workstream-card [summary]="s" [focused]="ui.focusedRowId() === s.ws.id" />
          }
        </ng-template>
        <ng-template kanbanLabel let-key>
      @switch (effectiveGroup()) {
        @case ('status') {
          <app-status-icon [status]="$any(key)" />
          <span class="font-medium">{{ $any(statusMeta)[key].label }}</span>
        }
        @case ('ownerTeamId') {
          @if (key) {
            <app-actor-avatar [actor]="{ type: 'team', id: key }" [size]="16" />
            <span class="font-medium">{{ store.getTeam(key)?.name }}</span>
          } @else {
            <span class="font-medium">No team</span>
          }
        }
        @case ('priority') {
          <app-priority-icon [priority]="$any(key)" />
          <span class="font-medium">{{ $any(priorityMeta)[key].label }}</span>
        }
        @case ('accountableUserId') {
          @if (key) {
            <app-actor-avatar [actor]="{ type: 'user', id: key }" [size]="16" />
            <span class="font-medium">{{ store.getUser(key)?.name }}</span>
          } @else {
            <span class="font-medium">Unassigned</span>
          }
        }
      }
        </ng-template>
      </app-kanban>
    }

    <app-create-workstream-dialog [(open)]="createOpen" />
  `,
})
export class WorkstreamListPage {
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  protected readonly layout = signal<Layout>(loadLayout());
  protected readonly groupBy = signal<GroupField>('status');
  protected readonly filters = signal<ViewFilter[]>([]);
  protected readonly search = signal('');
  protected readonly sortField = signal<string>('updatedAt');
  protected readonly sortDir = signal<'asc' | 'desc'>('desc');
  protected readonly createOpen = signal(false);
  protected readonly saveState = signal<'open' | 'closed'>('closed');
  protected readonly viewName = signal('');
  protected readonly viewShared = signal(true);

  protected readonly statusMeta = WORKSTREAM_STATUS_META;
  protected readonly priorityMeta = PRIORITY_META;
  protected readonly statuses = statusOptions();
  protected readonly priorities = priorityOptions();
  protected readonly groupOptions = GROUP_OPTIONS;
  protected readonly sorts = SORT_OPTIONS;
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));
  protected readonly repos = computed(() => repoOptions(this.store));
  protected readonly labels = computed(() => labelOptions(this.store));

  protected readonly plus = LucidePlus;
  protected readonly listIcon = LucideLayoutList;
  protected readonly boardIcon = LucideSquareKanban;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly bookmark = LucideBookmarkPlus;
  protected readonly ascIcon = LucideArrowUpNarrowWide;
  protected readonly descIcon = LucideArrowDownWideNarrow;
  protected readonly flow = LucideWorkflow;
  protected readonly filterIcon = LucideListFilter;

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly total = computed(() => this.store.workstreams().length);
  protected readonly hasFilters = computed(() => this.filters().length > 0 || this.search().trim().length > 0);

  protected readonly effectiveGroup = computed<GroupField>(() => (this.layout() === 'board' ? 'status' : this.groupBy()));

  private readonly summaries = computed(() => {
    const map = new Map<string, WsSummary>();
    for (const w of this.store.workstreams()) map.set(w.id, buildSummary(this.store, w));
    return map;
  });

  protected readonly columns = computed<Column[]>(() => {
    const group = this.effectiveGroup();
    const board = this.layout() === 'board';
    const groups = queryGroups(
      'workstream',
      this.store.workstreams() as Workstream[],
      {
        filters: this.filters(),
        search: this.search(),
        sort: { field: this.sortField(), direction: this.sortDir() },
        groupBy: group,
      },
      {},
      group === 'status' ? (board ? WORKSTREAM_STATUS_FLOW.filter((s) => s !== 'canceled') : []) : undefined,
    );
    let out = groups;
    if (group === 'status') {
      // lifecycle order (PLAN §2): draft → … → shipped → canceled
      const order = (k: string) => WORKSTREAM_STATUS_FLOW.indexOf(k as never);
      out = [...groups].sort((a, b) => order(a.key) - order(b.key));
      if (board) out = out.filter((g) => g.items.length > 0 || g.key !== 'canceled');
    } else if (group === 'ownerTeamId' || group === 'accountableUserId') {
      const name = (k: string) =>
        (group === 'ownerTeamId' ? this.store.getTeam(k)?.name : this.store.getUser(k)?.name) ?? '￿';
      out = [...groups].sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : name(a.key).localeCompare(name(b.key))));
    }
    const sums = this.summaries();
    return out.map((g) => ({
      key: g.key,
      items: g.items.map((w) => sums.get(w.id) ?? buildSummary(this.store, w)),
    }));
  });

  protected readonly shown = computed(() => this.columns().reduce((n, g) => n + g.items.length, 0));
  protected readonly description = computed(() =>
    this.hasFilters() ? `${this.shown()} of ${this.total()} workstreams` : `${this.total()} workstreams`,
  );

  private readonly _keys = usePageShortcuts([
    { keys: 'c', label: 'New workstream', run: () => this.canEdit() && this.createOpen.set(true) },
    { keys: 'v', label: 'Toggle list / board', run: () => this.setLayout(this.layout() === 'list' ? 'board' : 'list') },
  ]);

  protected fv(field: string): string[] {
    return filterValues(this.filters(), field);
  }

  protected setF(field: string, values: string[]): void {
    this.filters.update((f) => setFilter(f, field, 'in', values));
  }

  protected clearFilters(): void {
    this.filters.set([]);
    this.search.set('');
  }

  protected clearAll(): void {
    this.clearFilters();
  }

  protected setLayout(raw: unknown): void {
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v !== 'list' && v !== 'board') return;
    this.layout.set(v);
    try {
      globalThis.localStorage?.setItem(LAYOUT_KEY, v);
    } catch {
      /* ignore */
    }
  }

  protected toggleDir(): void {
    this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
  }

  protected readonly trackSummary = (s: { ws: { id: string } }): string => s.ws.id;

  /** Drag between columns. A status drop pins `statusOverride` so the card stays in that column. */
  protected move(summary: { ws: Workstream }, to: string): void {
    const w = summary.ws;
    const group = this.effectiveGroup();
    if (group === 'status') {
      if (w.status === to) return;
      void this.store.updateWorkstream(w.id, { statusOverride: to as Workstream['status'] });
    } else if (group === 'priority') {
      if (w.priority !== to) void this.store.updateWorkstream(w.id, { priority: to as Priority });
    } else if (group === 'ownerTeamId') {
      if (to && w.ownerTeamId !== to) void this.store.updateWorkstream(w.id, { ownerTeamId: to });
    } else if (group === 'accountableUserId') {
      const id = to || null;
      if ((w.accountableUserId ?? null) !== id) void this.store.updateWorkstream(w.id, { accountableUserId: id });
    }
  }

  protected async saveView(): Promise<void> {
    const name = this.viewName().trim();
    if (!name) return;
    const filters = [...this.filters()];
    const q = this.search().trim();
    if (q) filters.push({ field: 'title', op: 'contains', value: q });
    const view = await this.store.createView({
      name,
      entity: 'workstream',
      filters,
      sort: { field: this.sortField(), direction: this.sortDir() },
      groupBy: this.effectiveGroup(),
      layout: this.layout(),
      shared: this.viewShared(),
    });
    if (!view) return;
    this.saveState.set('closed');
    this.viewName.set('');
    this.notify.success(`Saved view “${view.name}”`, { description: 'Find it under Views in the sidebar.' });
  }
}
