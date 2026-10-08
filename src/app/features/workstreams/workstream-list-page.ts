// `/:slug/workstreams` — outcomes (coordinated work that resolves issues).
//
// URL: `?view=active|backlog|shipped|all` (tabs), `?team=<teamId>` (owner OR participating team,
// used by the sidebar team links). Display options (layout, grouping, ordering, visible properties)
// persist in localStorage. Rows are editable in place, right-click opens the workstream menu,
// multi-selection shows the bulk bar, and the focused row reacts to s / p / a / t / ⌘. / ⌘⇧C / ⌘⌫.
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, effect, inject, input, signal, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import {
  LucideArrowDownWideNarrow,
  LucideArrowUpNarrowWide,
  LucideBookmarkPlus,
  LucideDynamicIcon,
  LucideLayoutList,
  LucideListFilter,
  LucidePlus,
  LucideSearch,
  LucideSlidersHorizontal,
  LucideSquareKanban,
  LucideWorkflow,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  Notifier,
  NablaStore,
  UiStore,
  PRIORITY_META,
  WORKSTREAM_STATUS_FLOW,
  WORKSTREAM_STATUS_META,
  filterValues,
  isTypingTarget,
  queryGroups,
  setFilter,
  usePageShortcuts,
  type Priority,
  type ViewFilter,
  type Workstream,
  type WorkstreamStatus,
} from '../../core';
import { oneOf, readJson, writeJson } from '../../core/stores/storage';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Kanban, KanbanItemDirective, KanbanLabelDirective } from '../../shared/kanban';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { TopBarActions } from '../../layout/page-chrome';
import { CreateWorkstreamDialog, type CreateWorkstreamDefaults } from './create-workstream-dialog';
import { Picker, type PickOption } from './picker';
import { WsActions } from './ws-actions';
import { WsBulkBar } from './ws-bulk-bar';
import {
  WS_VIEW_TABS,
  buildSummary,
  labelOptions,
  priorityOptions,
  repoOptions,
  statusOptions,
  teamOptions,
  userOptions,
  type WsSummary,
  type WsViewTab,
} from './ws-model';
import { DEFAULT_ROW_PROPS, ROW_PROP_LABELS, WorkstreamCard, WorkstreamRow, type WsRowProps } from './workstream-items';

type Layout = 'list' | 'board';
type GroupField = 'status' | 'ownerTeamId' | 'priority' | 'accountableUserId' | 'none';
type SortField = 'updatedAt' | 'priority' | 'targetDate' | 'createdAt' | 'title' | 'status';

const DISPLAY_KEY = 'nabla.workstreams.display.v2';
const LEGACY_LAYOUT_KEY = 'nabla.workstreams.layout';
const GROUPS: GroupField[] = ['status', 'ownerTeamId', 'priority', 'accountableUserId', 'none'];
const SORTS: SortField[] = ['updatedAt', 'priority', 'targetDate', 'createdAt', 'title', 'status'];
const GROUP_OPTIONS: PickOption[] = [
  { value: 'status', label: 'Status' },
  { value: 'ownerTeamId', label: 'Owner team' },
  { value: 'priority', label: 'Priority' },
  { value: 'accountableUserId', label: 'Accountable' },
  { value: 'none', label: 'No grouping' },
];
const SORT_OPTIONS: PickOption[] = [
  { value: 'updatedAt', label: 'Last updated' },
  { value: 'priority', label: 'Priority' },
  { value: 'targetDate', label: 'Target date' },
  { value: 'status', label: 'Status' },
  { value: 'createdAt', label: 'Created' },
  { value: 'title', label: 'Title' },
];

interface DisplayPrefs {
  layout: Layout;
  groupBy: GroupField;
  sortField: SortField;
  sortDir: 'asc' | 'desc';
  props: WsRowProps;
}

const DEFAULT_DISPLAY: DisplayPrefs = {
  layout: 'list',
  groupBy: 'status',
  sortField: 'updatedAt',
  sortDir: 'desc',
  props: DEFAULT_ROW_PROPS,
};

function loadDisplay(): DisplayPrefs {
  const raw = readJson<DisplayPrefs>(DISPLAY_KEY);
  let legacy: string | null = null;
  try {
    legacy = globalThis.localStorage?.getItem(LEGACY_LAYOUT_KEY) ?? null;
  } catch {
    /* ignore */
  }
  return {
    layout: oneOf(raw?.layout ?? legacy, ['list', 'board'] as const, 'list'),
    groupBy: oneOf(raw?.groupBy, GROUPS, 'status'),
    sortField: oneOf(raw?.sortField, SORTS, 'updatedAt'),
    sortDir: raw?.sortDir === 'asc' ? 'asc' : 'desc',
    props: { ...DEFAULT_ROW_PROPS, ...(raw?.props && typeof raw.props === 'object' ? raw.props : {}) },
  };
}

interface Column {
  key: string;
  items: WsSummary[];
}

const EMPTY_COPY: Record<WsViewTab, { title: string; description: string }> = {
  active: { title: 'Nothing in flight', description: 'Active workstreams are being worked on, waiting for input, in review, blocked or ready to land.' },
  backlog: { title: 'No planned workstreams', description: 'Drafts and planned outcomes that nobody started yet show up here.' },
  shipped: { title: 'Nothing shipped yet', description: 'Workstreams land here once their work reaches production.' },
  all: { title: 'No workstreams yet', description: 'A workstream is an outcome: coordinated work that resolves one or more issues.' },
};

@Component({
  selector: 'app-workstream-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmInputImports,
    HlmPopoverImports,
    HlmSwitchImports,
    HlmTooltip,
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
    WsBulkBar,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canCreate()) {
        <button hlmBtn size="sm" (click)="create()" hlmTooltip="New workstream" position="bottom">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New workstream</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header [title]="pageTitle()" [description]="pageDescription()" />

    <!-- view tabs · scope · search · display -->
    <div class="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-4 py-1.5 sm:px-6">
      <nav class="scrollbar-none -ml-1 flex items-center gap-0.5 overflow-x-auto" aria-label="Workstream views">
        @for (t of tabs; track t.id) {
          <button
            type="button"
            class="hover:bg-accent hover:text-foreground inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors"
            [class.bg-accent]="tab() === t.id"
            [class.text-foreground]="tab() === t.id"
            [class.font-medium]="tab() === t.id"
            [class.text-muted-foreground]="tab() !== t.id"
            [attr.aria-current]="tab() === t.id ? 'page' : null"
            [hlmTooltip]="t.hint"
            position="bottom"
            (click)="setTab(t.id)"
          >
            {{ t.label }}
            <span class="text-muted-foreground text-xs tabular-nums">{{ tabCounts()[t.id] }}</span>
          </button>
        }
      </nav>
      @if (team(); as t) {
        <span class="border-border-strong bg-accent inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border pr-1 pl-1.5 text-xs">
          <app-actor-avatar [actor]="{ type: 'team', id: t.id }" [size]="16" />
          {{ t.name }}
          <span class="text-muted-foreground">· owner or participant</span>
          <button type="button" class="text-muted-foreground hover:text-foreground hover:bg-background rounded p-0.5" aria-label="Show all teams" (click)="clearTeam()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>
          </button>
        </span>
      }
      <span class="flex-1"></span>
      <div class="relative max-sm:w-full sm:w-48">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input
          #searchBox
          hlmInput
          class="h-7 w-full pl-8 text-xs"
          placeholder="Filter by title or key…"
          aria-label="Filter workstreams"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
          (keydown.escape)="search.set(''); searchBox.blur()"
        />
      </div>
      <div class="border-border-strong flex h-7 items-center rounded-md border p-0.5" role="group" aria-label="Layout">
        <button type="button" class="hover:text-foreground flex h-full items-center rounded-[4px] px-1.5" [class.bg-accent]="display().layout === 'list'" [class.text-muted-foreground]="display().layout !== 'list'" aria-label="List layout" hlmTooltip="List (v)" position="bottom" (click)="setLayout('list')">
          <svg [lucideIcon]="listIcon" [size]="14"></svg>
        </button>
        <button type="button" class="hover:text-foreground flex h-full items-center rounded-[4px] px-1.5" [class.bg-accent]="display().layout === 'board'" [class.text-muted-foreground]="display().layout !== 'board'" aria-label="Board layout" hlmTooltip="Board (v)" position="bottom" (click)="setLayout('board')">
          <svg [lucideIcon]="boardIcon" [size]="14"></svg>
        </button>
      </div>
      <hlm-popover align="end" sideOffset="4" [state]="displayState()" (stateChanged)="displayState.set($event)">
        <button hlmBtn hlmPopoverTrigger variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs font-normal">
          <svg [lucideIcon]="sliders" [size]="13"></svg>Display
        </button>
        <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-80 gap-3 p-3 text-[13px]">
          <div class="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2">
            <span class="text-muted-foreground text-xs">Grouping</span>
            <app-picker label="Grouping" [searchable]="false" [options]="groupOptions()" [value]="[effectiveGroup()]" [disabled]="display().layout === 'board'" (valueChange)="patchDisplay({ groupBy: $any($event[0] ?? 'status') })" />
            <span class="text-muted-foreground text-xs">Ordering</span>
            <div class="flex min-w-0 items-center gap-1">
              <app-picker class="min-w-0 flex-1" label="Ordering" [searchable]="false" [options]="sorts" [value]="[display().sortField]" (valueChange)="patchDisplay({ sortField: $any($event[0] ?? 'updatedAt') })" />
              <button hlmBtn variant="outline" size="icon-sm" [attr.aria-label]="display().sortDir === 'asc' ? 'Ascending' : 'Descending'" [hlmTooltip]="display().sortDir === 'asc' ? 'Ascending' : 'Descending'" (click)="patchDisplay({ sortDir: display().sortDir === 'asc' ? 'desc' : 'asc' })">
                <svg [lucideIcon]="display().sortDir === 'asc' ? ascIcon : descIcon" [size]="14"></svg>
              </button>
            </div>
          </div>
          <div class="border-t pt-3">
            <div class="text-muted-foreground mb-2 text-xs">Properties shown on rows</div>
            <div class="flex flex-wrap gap-1">
              @for (p of propLabels; track p.key) {
                <button
                  type="button"
                  class="h-6 rounded-md border px-2 text-xs transition-colors"
                  [class]="display().props[p.key] ? 'bg-accent border-border-strong text-foreground' : 'border-border text-muted-foreground hover:text-foreground'"
                  [attr.aria-pressed]="display().props[p.key]"
                  (click)="toggleProp(p.key)"
                >
                  {{ p.label }}
                </button>
              }
            </div>
          </div>
          <div class="flex items-center justify-between border-t pt-2">
            <span class="text-muted-foreground text-[11px]">Saved on this device</span>
            <button hlmBtn variant="ghost" size="xs" class="text-muted-foreground" (click)="resetDisplay()">Reset</button>
          </div>
        </hlm-popover-content>
      </hlm-popover>
    </div>

    <!-- filters -->
    <div class="flex items-center gap-1.5 border-b px-4 py-1.5 sm:px-6">
      <div class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        <svg [lucideIcon]="filterIcon" [size]="13" class="text-muted-foreground shrink-0"></svg>
        <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statuses" [value]="fv('status')" (valueChange)="setF('status', $event)" />
        @if (!team()) {
          <app-picker variant="chip" label="Team" [multiple]="true" [options]="teams()" [value]="fv('teamId')" (valueChange)="setF('teamId', $event)" />
        }
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
      @if (hasFilters()) {
        <hlm-popover align="end" sideOffset="4" [state]="saveState()" (stateChanged)="saveState.set($event)">
          <button hlmBtn hlmPopoverTrigger variant="ghost" size="sm" class="h-7 shrink-0 gap-1 px-2 text-xs">
            <svg [lucideIcon]="bookmark" [size]="13"></svg><span class="max-sm:hidden">Save view</span>
          </button>
          <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-72">
            <hlm-popover-header>
              <h3 hlmPopoverTitle>Save as view</h3>
              <p hlmPopoverDescription class="text-xs">Keeps the current filters, grouping and layout.</p>
            </hlm-popover-header>
            <div class="grid gap-2">
              <input hlmInput class="h-8" placeholder="View name" aria-label="View name" [value]="viewName()" (input)="viewName.set($any($event.target).value)" (keydown.enter)="saveView()" />
              <label class="flex items-center gap-2 text-xs">
                <hlm-switch [checked]="viewShared()" (checkedChange)="viewShared.set($event)" aria-label="Share with workspace" />
                Share with the workspace
              </label>
              <button hlmBtn size="sm" [disabled]="!viewName().trim()" (click)="saveView()">Save view</button>
            </div>
          </hlm-popover-content>
        </hlm-popover>
      }
    </div>

    @if (scopeTotal() === 0) {
      <app-empty-state [icon]="flow" [title]="team() ? 'No workstreams for ' + team()!.name : 'No workstreams yet'" description="A workstream is an outcome: coordinated work that resolves one or more issues, with its PRs, decisions and acceptance criteria in one place.">
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New workstream</button>
        }
      </app-empty-state>
    } @else if (shown() === 0) {
      @if (hasFilters()) {
        <app-empty-state [icon]="filterIcon" title="No workstreams match" description="Try removing a filter or changing the search.">
          <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
        </app-empty-state>
      } @else {
        <app-empty-state [icon]="flow" [title]="emptyCopy().title" [description]="emptyCopy().description">
          <button hlmBtn size="sm" variant="outline" (click)="setTab('all')">Show all workstreams</button>
        </app-empty-state>
      }
    } @else {
      <app-kanban
        [columns]="columns()"
        [layout]="display().layout"
        [disabled]="!canEdit()"
        prefix="workstreams"
        [track]="trackSummary"
        (moved)="move($event.item, $event.to)"
      >
        <ng-template kanbanItem let-s>
          @if (display().layout === 'list') {
            <app-workstream-row [summary]="s" [props]="display().props" [focused]="ui.focusedRowId() === s.ws.id" />
          } @else {
            <app-workstream-card [summary]="s" [focused]="ui.focusedRowId() === s.ws.id" />
          }
        </ng-template>
        <ng-template kanbanLabel let-key>
          @switch (effectiveGroup()) {
            @case ('status') {
              <app-status-icon entity="workstream" [status]="$any(key)" />
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
            @default {
              <span class="font-medium">All workstreams</span>
            }
          }
          @if (display().layout === 'board' && canEdit()) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground hover:bg-accent order-last ml-auto flex size-6 items-center justify-center rounded-md"
              [attr.aria-label]="'New workstream in ' + $any(statusMeta)[key]?.label"
              [hlmTooltip]="'New ' + ($any(statusMeta)[key]?.label ?? '').toLowerCase() + ' workstream'"
              (click)="createIn(key)"
            >
              <svg [lucideIcon]="plus" [size]="14"></svg>
            </button>
          }
        </ng-template>
      </app-kanban>
    }

    <app-ws-bulk-bar />
    <app-create-workstream-dialog [(open)]="createOpen" [defaults]="createDefaults()" />
  `,
})
export class WorkstreamListPage {
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);
  private readonly router = inject(Router);
  private readonly actions = inject(WsActions);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** `?team=` (owner or participating team id or key). */
  readonly teamParam = input<string | undefined>(undefined, { alias: 'team' });
  /** `?view=` tab. */
  readonly viewParam = input<string | undefined>(undefined, { alias: 'view' });

  protected readonly display = signal<DisplayPrefs>(loadDisplay());
  protected readonly filters = signal<ViewFilter[]>([]);
  protected readonly search = signal('');
  protected readonly createOpen = signal(false);
  protected readonly createDefaults = signal<CreateWorkstreamDefaults>({});
  protected readonly saveState = signal<'open' | 'closed'>('closed');
  protected readonly displayState = signal<'open' | 'closed'>('closed');
  protected readonly viewName = signal('');
  protected readonly viewShared = signal(true);
  private readonly searchBox = viewChild<ElementRef<HTMLInputElement>>('searchBox');

  protected readonly tabs = WS_VIEW_TABS;
  protected readonly statusMeta = WORKSTREAM_STATUS_META;
  protected readonly priorityMeta = PRIORITY_META;
  protected readonly statuses = statusOptions();
  protected readonly priorities = priorityOptions();
  protected readonly sorts = SORT_OPTIONS;
  protected readonly propLabels = ROW_PROP_LABELS;
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
  protected readonly sliders = LucideSlidersHorizontal;

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly canCreate = computed(() => this.store.allowed('createWorkstreams'));
  protected readonly team = computed(() => this.store.getTeam(this.teamParam()));
  protected readonly tab = computed<WsViewTab>(() => oneOf(this.viewParam(), ['active', 'backlog', 'shipped', 'all'] as const, 'active'));
  protected readonly emptyCopy = computed(() => EMPTY_COPY[this.tab()]);
  protected readonly hasFilters = computed(() => this.filters().length > 0 || this.search().trim().length > 0);
  protected readonly groupOptions = computed(() => GROUP_OPTIONS);
  protected readonly effectiveGroup = computed<GroupField>(() => (this.display().layout === 'board' ? 'status' : this.display().groupBy));

  protected readonly pageTitle = computed(() => (this.team() ? `${this.team()!.name} workstreams` : 'Workstreams'));
  protected readonly pageDescription = computed(
    () => 'Outcomes — coordinated work that resolves issues. Each workstream tracks its issues, PRs, decisions and acceptance criteria.',
  );

  /** Workstreams in the team scope (before tabs / filters). */
  private readonly scoped = computed(() => {
    const t = this.team();
    const all = this.store.workstreams();
    return t ? all.filter((w) => w.ownerTeamId === t.id || w.participatingTeamIds.includes(t.id)) : all;
  });
  protected readonly scopeTotal = computed(() => this.scoped().length);

  /** Scope + filters + search (what the tabs count). */
  private readonly filtered = computed(() =>
    queryGroups('workstream', this.scoped() as Workstream[], { filters: this.filters(), search: this.search() })[0]?.items ?? [],
  );
  protected readonly tabCounts = computed(() => {
    const out = {} as Record<WsViewTab, number>;
    for (const t of WS_VIEW_TABS) out[t.id] = t.statuses ? this.filtered().filter((w) => t.statuses!.includes(w.status)).length : this.filtered().length;
    return out;
  });
  private readonly inTab = computed(() => {
    const def = WS_VIEW_TABS.find((t) => t.id === this.tab());
    return def?.statuses ? this.filtered().filter((w) => def.statuses!.includes(w.status)) : this.filtered();
  });

  private readonly summaries = computed(() => {
    const map = new Map<string, WsSummary>();
    for (const w of this.store.workstreams()) map.set(w.id, buildSummary(this.store, w));
    return map;
  });

  protected readonly columns = computed<Column[]>(() => {
    const group = this.effectiveGroup();
    const board = this.display().layout === 'board';
    const tabDef = WS_VIEW_TABS.find((t) => t.id === this.tab());
    // board columns: the tab's statuses (or the whole lifecycle), canceled only when it has cards
    const include =
      group === 'status' && board ? (tabDef?.statuses ?? WORKSTREAM_STATUS_FLOW.filter((s) => s !== 'canceled')) : undefined;
    const d = this.display();
    const groups = queryGroups(
      'workstream',
      this.inTab(),
      { sort: { field: d.sortField, direction: d.sortDir }, groupBy: group === 'none' ? null : group },
      {},
      include,
    );
    let out = groups;
    if (group === 'status') {
      const order = (k: string) => WORKSTREAM_STATUS_FLOW.indexOf(k as WorkstreamStatus);
      out = [...groups].sort((a, b) => order(a.key) - order(b.key));
    } else if (group === 'ownerTeamId' || group === 'accountableUserId') {
      const name = (k: string) => (group === 'ownerTeamId' ? this.store.getTeam(k)?.name : this.store.getUser(k)?.name) ?? '￿';
      out = [...groups].sort((a, b) => (a.key === '' ? 1 : b.key === '' ? -1 : name(a.key).localeCompare(name(b.key))));
    }
    const sums = this.summaries();
    return out.map((g) => ({ key: g.key, items: g.items.map((w) => sums.get(w.id) ?? buildSummary(this.store, w)) }));
  });

  protected readonly shown = computed(() => this.inTab().length);
  /** Visible workstream ids in display order (for select-all). */
  private readonly visibleIds = computed(() => [...new Set(this.columns().flatMap((c) => c.items.map((s) => s.ws.id)))]);

  /** Focused row's workstream, when the focus is on this page's list. */
  private readonly focusedWs = computed(() => {
    const id = this.ui.focusedRowId();
    return id ? this.store.workstreamById().get(id) : undefined;
  });
  /** What a keyboard action applies to: the selection, else the focused row. */
  private targets(): Workstream[] {
    const sel = this.actions.selected();
    if (sel.length) return sel;
    const f = this.focusedWs();
    return f ? [f] : [];
  }
  private notTyping = (): boolean => !isTypingTarget(globalThis.document?.activeElement ?? null);
  private hasTarget = (): boolean => this.notTyping() && (this.actions.selected().length > 0 || !!this.focusedWs());
  private editTarget = (): boolean => this.canEdit() && this.hasTarget();

  constructor() {
    effect(() => writeJson(DISPLAY_KEY, this.display()));
    // keep the team filter chip out of the way while a team scope is active
    effect(() => {
      if (this.team()) this.filters.update((f) => (f.some((x) => x.field === 'teamId') ? setFilter(f, 'teamId', 'in', null) : f));
    });
    inject(DestroyRef).onDestroy(() => this.ui.clearSelected());
  }

  private readonly _keys = usePageShortcuts([
    { keys: 'c', label: 'New workstream', run: () => this.canCreate() && this.create() },
    { keys: 'v', label: 'Toggle list / board', run: () => this.setLayout(this.display().layout === 'list' ? 'board' : 'list') },
    { keys: 'f', label: 'Filter by text', run: () => this.searchBox()?.nativeElement.focus() },
    { keys: 's', label: 'Set status', when: this.editTarget, run: () => this.intent('status') },
    { keys: 'p', label: 'Set priority', when: this.editTarget, run: () => this.intent('priority') },
    { keys: 'a', label: 'Set accountable', when: this.editTarget, run: () => this.intent('accountable') },
    { keys: 't', label: 'Set target date', when: this.editTarget, run: () => this.intent('date') },
    { keys: 'mod+.', label: 'Copy key', when: this.hasTarget, run: () => this.actions.copyKey(this.targets()) },
    { keys: 'mod+shift+c', label: 'Copy link', when: this.hasTarget, run: () => this.actions.copyLink(this.targets()) },
    { keys: 'mod+shift+g', label: 'Copy git branch name', when: () => this.hasTarget() && this.targets().length === 1, run: () => this.actions.copyBranch(this.targets()[0]) },
    { keys: 'mod+shift+.', label: 'Copy git branch name', hidden: true, when: () => this.hasTarget() && this.targets().length === 1, run: () => this.actions.copyBranch(this.targets()[0]) },
    { keys: 'mod+shift+>', label: 'Copy git branch name', hidden: true, when: () => this.hasTarget() && this.targets().length === 1, run: () => this.actions.copyBranch(this.targets()[0]) },
    { keys: 'shift+o', label: 'Open Delta thread', when: () => !!this.focusedWs(), run: () => this.actions.openDelta(this.focusedWs()!) },
    { keys: 'mod+backspace', label: 'Delete', when: this.editTarget, run: () => this.actions.confirmDelete(this.targets()) },
    { keys: 'mod+a', label: 'Select all', when: this.notTyping, run: () => this.ui.setSelected(this.visibleIds()) },
  ]);

  private intent(kind: 'status' | 'priority' | 'accountable' | 'date'): void {
    if (this.actions.selected().length) this.actions.request(kind, 'bulk');
    else {
      const f = this.focusedWs();
      if (!f) return;
      if (kind === 'date' && !this.display().props.targetDate && this.display().layout === 'list') {
        this.patchDisplay({ props: { ...this.display().props, targetDate: true } });
      }
      this.actions.request(kind, f.id);
    }
  }

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

  protected setTab(id: WsViewTab): void {
    void this.router.navigate([], { queryParams: { view: id === 'active' ? null : id }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected clearTeam(): void {
    void this.router.navigate([], { queryParams: { team: null }, queryParamsHandling: 'merge' });
  }

  protected patchDisplay(patch: Partial<DisplayPrefs>): void {
    this.display.update((d) => ({ ...d, ...patch }));
  }

  protected toggleProp(key: keyof WsRowProps): void {
    this.display.update((d) => ({ ...d, props: { ...d.props, [key]: !d.props[key] } }));
  }

  protected resetDisplay(): void {
    this.display.set({ ...DEFAULT_DISPLAY, layout: this.display().layout });
  }

  protected setLayout(v: Layout): void {
    this.patchDisplay({ layout: v });
  }

  protected create(defaults: CreateWorkstreamDefaults = {}): void {
    const t = this.team();
    this.createDefaults.set({ ...(t ? { ownerTeamId: t.id } : {}), ...defaults });
    this.createOpen.set(true);
  }

  /** Board column "+": new workstream pinned to that status (draft is the natural start, so no pin). */
  protected createIn(status: string): void {
    const s = status as WorkstreamStatus;
    this.create(s === 'draft' ? {} : { statusOverride: s });
  }

  protected readonly trackSummary = (s: { ws: { id: string } }): string => s.ws.id;

  /** Drag between columns. A status drop pins `statusOverride` so the card stays in that column. */
  protected move(summary: { ws: Workstream }, to: string): void {
    const w = summary.ws;
    const group = this.effectiveGroup();
    if (group === 'status') {
      if (w.status !== to) this.actions.setStatus([w], to as WorkstreamStatus);
    } else if (group === 'priority') {
      this.actions.setPriority([w], to as Priority);
    } else if (group === 'ownerTeamId') {
      if (to && w.ownerTeamId !== to) void this.store.updateWorkstream(w.id, { ownerTeamId: to, participatingTeamIds: w.participatingTeamIds.filter((t) => t !== to) });
    } else if (group === 'accountableUserId') {
      this.actions.setAccountable([w], to || null);
    }
  }

  protected async saveView(): Promise<void> {
    const name = this.viewName().trim();
    if (!name) return;
    const filters = [...this.filters()];
    const q = this.search().trim();
    if (q) filters.push({ field: 'title', op: 'contains', value: q });
    const t = this.team();
    if (t) filters.push({ field: 'teamId', op: 'in', value: [t.id] });
    const tabDef = WS_VIEW_TABS.find((x) => x.id === this.tab());
    if (tabDef?.statuses && !filters.some((f) => f.field === 'status')) filters.push({ field: 'status', op: 'in', value: tabDef.statuses });
    const d = this.display();
    const group = this.effectiveGroup();
    const view = await this.store.createView({
      name,
      entity: 'workstream',
      filters,
      sort: { field: d.sortField, direction: d.sortDir },
      groupBy: group === 'none' ? undefined : group,
      layout: d.layout,
      shared: this.viewShared(),
    });
    if (!view) return;
    this.saveState.set('closed');
    this.viewName.set('');
    this.notify.success(`Saved view “${view.name}”`, { description: 'Find it under Views in the sidebar.' });
  }
}
