import { CdkDrag, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import {
  LucideArrowDownWideNarrow,
  LucideArrowUpNarrowWide,
  LucideChevronDown,
  LucideChevronRight,
  LucideDynamicIcon,
  LucideInbox,
  LucideLayoutList,
  LucideListFilter,
  LucidePlus,
  LucideSearch,
  LucideSquareKanban,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import {
  ISSUE_KIND_META,
  ISSUE_KINDS,
  ISSUE_STATUSES,
  ISSUE_STATUS_META,
  NablaStore,
  PRIORITY_META,
  UiStore,
  type Priority,
  filterValues,
  queryGroups,
  setFilter,
  usePageShortcuts,
  type Issue,
  type IssueKind,
  type IssueStatus,
  type ViewFilter,
} from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { IssueKindLabel } from '../../shared/issue';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { Picker, type PickOption } from '../workstreams/picker';
import { priorityOptions, teamOptions, userOptions } from '../workstreams/ws-model';
import { IssueCard, IssueRow } from './issue-items';

type Layout = 'list' | 'board';
type GroupField = 'status' | 'kind' | 'teamId' | 'priority' | 'assigneeId';

const LAYOUT_KEY = 'nabla.issues.layout';
const GROUP_OPTIONS: PickOption[] = [
  { value: 'status', label: 'Status' },
  { value: 'kind', label: 'Type' },
  { value: 'priority', label: 'Priority' },
  { value: 'teamId', label: 'Team' },
  { value: 'assigneeId', label: 'Assignee' },
];
const SORT_OPTIONS: PickOption[] = [
  { value: 'updatedAt', label: 'Updated' },
  { value: 'priority', label: 'Priority' },
  { value: 'createdAt', label: 'Created' },
  { value: 'key', label: 'Key' },
  { value: 'title', label: 'Title' },
];

interface Column {
  key: string;
  items: Issue[];
}

function loadLayout(): Layout {
  try {
    return globalThis.localStorage?.getItem(LAYOUT_KEY) === 'board' ? 'board' : 'list';
  } catch {
    return 'list';
  }
}

@Component({
  selector: 'app-issue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    CdkDropListGroup,
    CdkDropList,
    CdkDrag,
    HlmButtonImports,
    HlmInputImports,
    HlmToggleGroupImports,
    LucideDynamicIcon,
    PageHeader,
    Picker,
    Kbd,
    EmptyState,
    StatusIcon,
    PriorityIcon,
    ActorAvatar,
    IssueKindLabel,
    IssueRow,
    IssueCard,
    TopBarActions,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New issue</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Issues" [description]="description()">
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

    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2 sm:px-6">
      <div class="relative w-full sm:w-52">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input
          hlmInput
          class="h-7 w-full pl-8 text-xs"
          placeholder="Search issues…"
          aria-label="Search issues"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
      </div>
      <div class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full">
        <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statuses" [value]="fv('status')" (valueChange)="setF('status', $event)" />
        <app-picker variant="chip" label="Type" [multiple]="true" [searchable]="false" [options]="kinds" [value]="fv('kind')" (valueChange)="setF('kind', $event)" />
        <app-picker variant="chip" label="Priority" [multiple]="true" [searchable]="false" [options]="priorities" [value]="fv('priority')" (valueChange)="setF('priority', $event)" />
        <app-picker variant="chip" label="Team" [multiple]="true" [options]="teams()" [value]="fv('teamId')" (valueChange)="setF('teamId', $event)" />
        <app-picker variant="chip" label="Assignee" [multiple]="true" [options]="users()" [value]="fv('assigneeId')" (valueChange)="setF('assigneeId', $event)" />
        @if (hasFilters()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs" (click)="clearFilters()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-1">
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
      <app-empty-state [icon]="inbox" title="No issues yet" description="Issues are the bugs, requests and tasks a team decides to solve. Workstreams group the ones that belong together.">
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New issue</button>
        }
      </app-empty-state>
    } @else if (shown() === 0) {
      <app-empty-state [icon]="filterIcon" title="No issues match" description="Try removing a filter or changing the search.">
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else if (layout() === 'list') {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list" cdkDropListGroup>
        @for (g of columns(); track g.key) {
          <section>
            <button
              type="button"
              class="bg-muted/40 hover:bg-muted/70 sticky top-0 z-[1] flex min-h-8 w-full items-center gap-2 border-b px-4 text-left text-xs sm:px-6"
              [attr.aria-expanded]="!collapsed().has(g.key)"
              (click)="toggleGroup(g.key)"
            >
              <svg [lucideIcon]="collapsed().has(g.key) ? right : down" [size]="13" class="text-muted-foreground"></svg>
              <ng-container *ngTemplateOutlet="groupLabel; context: { $implicit: g.key }" />
              <span class="text-muted-foreground tabular-nums">{{ g.items.length }}</span>
            </button>
            @if (!collapsed().has(g.key)) {
              <div
                cdkDropList
                [id]="listId(g.key)"
                [cdkDropListData]="g.items"
                [cdkDropListDisabled]="!draggable()"
                cdkDropListSortingDisabled
                class="min-h-8"
                (cdkDropListDropped)="drop($event)"
              >
                @for (i of g.items; track i.id) {
                  <app-issue-row cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!draggable()" [issue]="i" [focused]="ui.focusedRowId() === i.id" />
                }
              </div>
            }
          </section>
        }
      </div>
    } @else {
      <div class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div class="flex h-full min-w-max gap-3 px-4 py-3 sm:px-6" cdkDropListGroup>
          @for (g of columns(); track g.key) {
            <section class="bg-muted/30 flex h-full w-[17.5rem] shrink-0 flex-col rounded-lg border">
              <header class="flex h-9 shrink-0 items-center gap-2 px-3 text-xs font-medium">
                <ng-container *ngTemplateOutlet="groupLabel; context: { $implicit: g.key }" />
                <span class="text-muted-foreground font-normal tabular-nums">{{ g.items.length }}</span>
              </header>
              <div
                cdkDropList
                [id]="listId(g.key)"
                [cdkDropListData]="g.items"
                [cdkDropListDisabled]="!canEdit()"
                cdkDropListSortingDisabled
                class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2"
                (cdkDropListDropped)="drop($event)"
              >
                @for (i of g.items; track i.id) {
                  <app-issue-card cdkDrag [cdkDragData]="i" [cdkDragDisabled]="!canEdit()" class="cursor-grab" [issue]="i" [focused]="ui.focusedRowId() === i.id" />
                } @empty {
                  <p class="text-muted-foreground px-1 py-4 text-center text-xs">Drop here</p>
                }
              </div>
            </section>
          }
        </div>
      </div>
    }

    <ng-template #groupLabel let-key>
      @switch (effectiveGroup()) {
        @case ('status') {
          <app-status-icon [status]="$any(key)" />
          <span class="font-medium">{{ statusLabel(key) }}</span>
        }
        @case ('kind') {
          <app-issue-kind [kind]="$any(key)" />
          <span class="font-medium">{{ kindLabel(key) }}</span>
        }
        @case ('priority') {
          <app-priority-icon [priority]="$any(key)" />
          <span class="font-medium">{{ priorityLabel(key) }}</span>
        }
        @case ('teamId') {
          @if (key) {
            <app-actor-avatar [actor]="{ type: 'team', id: key }" [size]="16" />
            <span class="font-medium">{{ store.getTeam(key)?.name }}</span>
          } @else {
            <span class="font-medium">No team</span>
          }
        }
        @case ('assigneeId') {
          @if (key) {
            <app-actor-avatar [actor]="{ type: 'user', id: key }" [size]="16" />
            <span class="font-medium">{{ store.getUser(key)?.name }}</span>
          } @else {
            <span class="font-medium">Unassigned</span>
          }
        }
      }
    </ng-template>
  `,
})
export class IssuePage {
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);

  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  /** Query `?status=backlog` from attention and saved links. */
  readonly status = input<string>();
  /** Query `?team=<teamId>`. */
  readonly team = input<string>();

  protected readonly layout = signal<Layout>(loadLayout());
  protected readonly groupBy = signal<GroupField>('status');
  protected readonly filters = signal<ViewFilter[]>([]);
  protected readonly search = signal('');
  protected readonly sortField = signal('updatedAt');
  protected readonly sortDir = signal<'asc' | 'desc'>('desc');
  protected readonly collapsed = signal<ReadonlySet<string>>(new Set());

  protected readonly statuses: PickOption[] = ISSUE_STATUSES.map((s) => ({
    value: s,
    label: ISSUE_STATUS_META[s].label,
    kind: 'status',
  }));
  protected readonly kinds: PickOption[] = ISSUE_KINDS.map((k) => ({
    value: k,
    label: ISSUE_KIND_META[k].label,
    hint: ISSUE_KIND_META[k].prefix,
  }));
  protected readonly priorities = priorityOptions();
  protected readonly groupOptions = GROUP_OPTIONS;
  protected readonly sorts = SORT_OPTIONS;
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly users = computed(() => userOptions(this.store));

  protected readonly plus = LucidePlus;
  protected readonly listIcon = LucideLayoutList;
  protected readonly boardIcon = LucideSquareKanban;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly ascIcon = LucideArrowUpNarrowWide;
  protected readonly descIcon = LucideArrowDownWideNarrow;
  protected readonly down = LucideChevronDown;
  protected readonly right = LucideChevronRight;
  protected readonly inbox = LucideInbox;
  protected readonly filterIcon = LucideListFilter;

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly total = computed(() => this.store.issues().length);
  protected readonly hasFilters = computed(() => this.filters().length > 0 || this.search().trim().length > 0);
  protected readonly effectiveGroup = computed<GroupField>(() => (this.layout() === 'board' ? 'status' : this.groupBy()));
  /** Kind is part of the key, so it cannot be changed by dragging. */
  protected readonly draggable = computed(() => this.canEdit() && this.effectiveGroup() !== 'kind');

  protected readonly columns = computed<Column[]>(() => {
    const group = this.effectiveGroup();
    const board = this.layout() === 'board';
    const groups = queryGroups(
      'issue',
      this.store.issues() as Issue[],
      {
        filters: this.filters(),
        search: this.search(),
        sort: { field: this.sortField(), direction: this.sortDir() },
        groupBy: group,
      },
      {},
      board ? ISSUE_STATUSES : undefined,
    );
    return groups;
  });

  protected readonly shown = computed(() => this.columns().reduce((n, g) => n + g.items.length, 0));
  protected readonly description = computed(() =>
    this.hasFilters() ? `${this.shown()} of ${this.total()} issues` : `${this.total()} issues`,
  );

  private readonly _keys = usePageShortcuts([{ keys: 'c', label: 'New issue', run: () => this.canEdit() && this.create() }]);

  constructor() {
    effect(() => {
      const status = this.status();
      const team = this.team();
      const next: ViewFilter[] = [];
      if (status && (ISSUE_STATUSES as readonly string[]).includes(status)) next.push({ field: 'status', op: 'in', value: [status] });
      if (team) next.push({ field: 'teamId', op: 'in', value: [team] });
      if (next.length) this.filters.set(next);
    });
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

  protected create(): void {
    this.ui.openCreate('issue');
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

  protected listId(key: string): string {
    return `issue-col:${key}`;
  }

  /** Move an issue into another status, team, assignee or priority column. */
  protected drop(event: CdkDragDrop<Issue[]>): void {
    if (!this.draggable() || event.previousContainer === event.container) return;
    const issue = event.item.data as Issue | undefined;
    if (!issue) return;
    const value = event.container.id.slice('issue-col:'.length);
    const group = this.effectiveGroup();
    if (group === 'status') {
      if (issue.status === value) return;
      void this.store.updateIssue(issue.id, { status: value as IssueStatus });
    } else if (group === 'priority') {
      if (issue.priority === value) return;
      void this.store.updateIssue(issue.id, { priority: value as Priority });
    } else if (group === 'teamId') {
      const teamId = value || null;
      if ((issue.teamId ?? null) === teamId) return;
      void this.store.updateIssue(issue.id, { teamId });
    } else if (group === 'assigneeId') {
      const assigneeId = value || null;
      if ((issue.assigneeId ?? null) === assigneeId) return;
      void this.store.updateIssue(issue.id, { assigneeId });
    }
  }

  protected toggleGroup(key: string): void {
    this.collapsed.update((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  protected statusLabel(key: string): string {
    return ISSUE_STATUS_META[key as IssueStatus]?.label ?? key;
  }
  protected kindLabel(key: string): string {
    return ISSUE_KIND_META[key as IssueKind]?.label ?? key;
  }
  protected priorityLabel(key: string): string {
    return PRIORITY_META[key as keyof typeof PRIORITY_META]?.label ?? key;
  }
}
