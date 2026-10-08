// Issue list and board, including drag-and-drop between columns.
// Used by the issues page and by a workstream (its linked issues).
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import {
  LucideArrowDownWideNarrow,
  LucideArrowUpNarrowWide,
  LucideDynamicIcon,
  LucideInbox,
  LucideListFilter,
  LucidePlus,
  LucideSearch,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
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
  type Issue,
  type IssueKind,
  type IssueStatus,
  type ViewFilter,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { IssueKindLabel } from '../../shared/issue';
import { Kanban, KanbanItemDirective, KanbanLabelDirective } from '../../shared/kanban';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { Picker, type PickOption } from '../workstreams/picker';
import { priorityOptions, teamOptions, userOptions } from '../workstreams/ws-model';
import { IssueCard, IssueRow } from './issue-items';

type Layout = 'list' | 'board';
type GroupField = 'status' | 'kind' | 'teamId' | 'priority' | 'assigneeId';

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

@Component({
  selector: 'app-issue-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmInputImports,
    LucideDynamicIcon,
    Picker,
    EmptyState,
    StatusIcon,
    PriorityIcon,
    ActorAvatar,
    IssueKindLabel,
    IssueRow,
    IssueCard,
    Kanban,
    KanbanItemDirective,
    KanbanLabelDirective,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
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
        <button hlmBtn variant="outline" size="sm" class="h-7 px-2 text-xs" (click)="toggleLayout()">
          {{ layout() === 'list' ? 'Board' : 'List' }}
        </button>
      </div>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="inbox" [title]="emptyTitle()" [description]="emptyDescription()">
        @if (canEdit() && showCreate()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New issue</button>
        }
      </app-empty-state>
    } @else if (shown() === 0) {
      <app-empty-state [icon]="filterIcon" title="No issues match" description="Try removing a filter or changing the search.">
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else {
      <app-kanban
        [columns]="columns()"
        [layout]="layout()"
        [disabled]="!draggable()"
        [prefix]="dropPrefix()"
        (moved)="move($event.item, $event.to)"
      >
        <ng-template kanbanItem let-i>
          @if (layout() === 'list') {
            <app-issue-row [issue]="i" [focused]="ui.focusedRowId() === i.id" />
          } @else {
            <app-issue-card [issue]="i" [focused]="ui.focusedRowId() === i.id" />
          }
        </ng-template>
        <ng-template kanbanLabel let-key>
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
      </app-kanban>
    }
  `,
})
export class IssueBoard {
  protected readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);

  /** Issues this board shows. The issues page passes every issue; a workstream passes its own. */
  readonly issues = input.required<readonly Issue[]>();
  /** Distinguishes drop-list ids when more than one board is on the page. */
  readonly dropPrefix = input('issue-col');
  /** Query `?status=` applied once when the board opens. */
  readonly status = input<string>();
  /** Query `?team=`. */
  readonly team = input<string>();
  readonly emptyTitle = input('No issues yet');
  readonly emptyDescription = input('Issues are the bugs, requests and tasks a team decides to solve.');
  readonly showCreate = input(true);

  protected readonly layout = signal<Layout>('board');
  protected readonly groupBy = signal<GroupField>('status');
  protected readonly filters = signal<ViewFilter[]>([]);
  protected readonly search = signal('');
  protected readonly sortField = signal('updatedAt');
  protected readonly sortDir = signal<'asc' | 'desc'>('desc');

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
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly ascIcon = LucideArrowUpNarrowWide;
  protected readonly descIcon = LucideArrowDownWideNarrow;
  protected readonly inbox = LucideInbox;
  protected readonly filterIcon = LucideListFilter;

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly total = computed(() => this.issues().length);
  protected readonly hasFilters = computed(() => this.filters().length > 0 || this.search().trim().length > 0);
  protected readonly effectiveGroup = computed<GroupField>(() => (this.layout() === 'board' ? 'status' : this.groupBy()));
  protected readonly draggable = computed(() => this.canEdit() && this.effectiveGroup() !== 'kind');

  protected readonly columns = computed<Column[]>(() => {
    const group = this.effectiveGroup();
    return queryGroups(
      'issue',
      this.issues() as Issue[],
      {
        filters: this.filters(),
        search: this.search(),
        sort: { field: this.sortField(), direction: this.sortDir() },
        groupBy: group,
      },
      {},
      this.layout() === 'board' ? ISSUE_STATUSES : undefined,
    );
  });

  protected readonly shown = computed(() => this.columns().reduce((n, g) => n + g.items.length, 0));

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

  protected toggleLayout(): void {
    this.layout.update((l) => (l === 'list' ? 'board' : 'list'));
  }

  protected toggleDir(): void {
    this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
  }

  protected move(issue: Issue, value: string): void {
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
