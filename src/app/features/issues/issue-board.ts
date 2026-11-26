// Issue list, board and flow: filters, display options (persisted), drag-and-drop between groups,
// multi-select with a bulk action bar, right-click menu and keyboard actions on the focused row.
import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideCheck,
  LucideChevronsUpDown,
  LucideBox,
  LucideCircleUserRound,
  LucideCopy,
  LucideGitBranch,
  LucideStar,
  LucideDynamicIcon,
  LucideExternalLink,
  LucideInbox,
  LucideLink,
  LucideListFilter,
  LucidePlus,
  LucideSearch,
  LucideSlidersHorizontal,
  LucideListTree,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUSES,
  FavoritesStore,
  ListStateStore,
  TramaStore,
  UiStore,
  Viewport,
  filterValues,
  isTypingTarget,
  matchesFilter,
  parseFilters,
  queryGroups,
  queryItems,
  sameFilters,
  serializeFilters,
  setFilter,
  usePageShortcuts,
  type Issue,
  type IssueStatus,
  type Priority,
  type QueryContext,
  type ViewFilter,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { IssueKindLabel } from '../../shared/issue';
import { Kanban, KanbanItemDirective, KanbanLabelDirective } from '../../shared/kanban';
import { StatusBar } from '../../layout/status-bar';
import { Kbd } from '../../shared/kbd';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { V3StatusDot } from '../../shared/v3';
import { ProjectGlyph } from '../projects/project-glyph';
import { FilterBar, type FilterMatch, type FilterPreset } from '../../shared/filter-bar/filter-bar';
import { fieldLabel } from '../views/view-model';
import { IssueActions } from './issue-actions';
import { IssueFlow } from './issue-flow';
import { IssueCard, IssueRow } from './issue-items';
import {
  DEFAULT_DISPLAY,
  GROUP_LABEL,
  PROPS,
  PROP_LABEL,
  SORTS,
  SORT_LABEL,
  groupLabel,
  groupUniverse,
  issueFlow,
  readDisplay,
  writeDisplay,
  type IssueDisplay,
  type IssueGroup,
  type IssueLayout,
  type IssueProp,
  type IssueSort,
} from './issue-model';
import { IssueOptionGlyph, promptOptions } from './issue-options';
import { buildIssueTree, flatIssueRows, type IssueTreeRow } from './issue-tree';
import { SearchInput } from '../../shared/search-input';

interface Column {
  key: string;
  items: Issue[];
}

/** A group as the list renders it: tree rows (context rows included), and the count of real matches. */
interface RowColumn {
  key: string;
  items: IssueTreeRow[];
  count: number;
  parentIds: string[];
}

const DRAGGABLE = new Set<IssueGroup>(['status', 'priority', 'assigneeId']);

/** Heights of a desktop list row (`min-h-10`, `min-h-8`, and a sub-task's `min-h-[38px]`). */
const ROW_PX = 40;
const ROW_COMPACT_PX = 32;
const SUBTASK_ROW_PX = 38;

/** The chips the filter bar offers up front ("Assignee any"): the v3 task list and board rows. */
const LIST_FILTER_FIELDS: readonly string[] = ['assigneeId', 'projectId', 'thread', 'source'];
const BOARD_FILTER_FIELDS: readonly string[] = ['thread'];

const FILTER_LABEL: Record<string, string> = {
  status: 'Status',
  kind: 'Type',
  priority: 'Priority',
  assigneeId: 'Assignee',
  labels: 'Label',
  projectId: 'Project',
  milestoneIds: 'Milestone',
};

/** `ListStateStore.remember` under a key that can change with an input (one board per context). */
function rememberKeyed<T>(list: ListStateStore, key: () => string, initial: T): WritableSignal<T> {
  const cell = computed(() => list.remember<T>(key(), initial));
  const read = computed(() => cell()());
  return Object.assign(read, {
    set: (value: T) => untracked(cell).set(value),
    update: (fn: (value: T) => T) => untracked(cell).update(fn),
    asReadonly: () => read,
  }) as unknown as WritableSignal<T>;
}

@Component({
  selector: 'app-issue-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SearchInput,
    FilterBar,
    HlmButtonImports,
    HlmPopoverImports,
    HlmSwitchImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    LucideDynamicIcon,
    EmptyState,
    StatusIcon,
    PriorityIcon,
    ActorAvatar,
    IssueKindLabel,
    IssueRow,
    IssueCard,
    IssueOptionGlyph,
    ProjectGlyph,
    Kanban,
    KanbanItemDirective,
    KanbanLabelDirective,
    IssueFlow,
    NgTemplateOutlet,
    Kbd,
    StatusBar,
    RouterLink,
    V3StatusDot,
  ],
  host: { class: 'relative flex min-h-0 flex-1 flex-col' },
  template: `
    <!-- Filter + display toolbar -->
    @if (toolbar()) {
    <!-- v3 filter bar: layout switch · filter chips … Group / Sort. Phones: the search stays a field of its
         own and the chip row sticks under the header while the list scrolls (styles.css, [data-mobile-sticky]). -->
    <div class="border-border flex shrink-0 flex-col md:border-b max-md:contents">
      <div class="md:hidden max-md:w-full max-md:px-4 max-md:py-2">
        <app-search-input noun="issues" [(value)]="search" />
      </div>
      <div
        class="px-5 py-2 max-md:sticky max-md:top-0 max-md:z-[3] max-md:flex max-md:basis-full max-md:items-center max-md:gap-1 max-md:bg-background max-md:py-1.5 max-md:pl-4 max-md:pr-2 md:min-h-10"
        data-mobile-sticky
      >
        <app-filter-bar
          class="min-w-0 flex-1"
          entity="issue"
          [filters]="filters()"
          (filtersChange)="filters.set($event)"
          [extended]="true"
          [suggested]="d().layout === 'board' ? boardFilterFields : listFilterFields"
          [items]="filterPool()"
          [ctx]="queryCtx()"
          [locked]="showBase() ? baseFilters() : []"
          [matchable]="true"
          [match]="match()"
          (matchChange)="match.set($event)"
          [presets]="presetMap()"
          [presetActive]="presetActive()"
          (presetPick)="statusPresetChange.emit($event.id)"
          [sort]="sortSpec()"
          [defaultSort]="false"
          (sortChange)="setSort($event)"
          [groupBy]="groupField()"
          [columns]="d().layout === 'board'"
          (groupByChange)="setGroup($event)"
        >
        @if (!forceLayout()) {
          <div leading class="flex shrink-0 items-center gap-2.5">
            <div
              class="border-border flex items-stretch border font-mono text-[11px]"
              role="group"
              aria-label="Layout"
            >
              @if (pageSwitch()) {
                <a
                  [routerLink]="['/', store.slug(), 'tasks']"
                  class="flex h-[22px] items-center px-2.5 outline-none focus-visible:underline"
                  [class]="d().layout !== 'board' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'"
                  [attr.aria-current]="d().layout !== 'board' ? 'page' : null"
                  >List</a
                >
                <a
                  [routerLink]="['/', store.slug(), 'board']"
                  class="border-border -ms-px flex h-[22px] items-center border-l px-2.5 outline-none focus-visible:underline"
                  [class]="d().layout === 'board' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'"
                  [attr.aria-current]="d().layout === 'board' ? 'page' : null"
                  >Board</a
                >
                <a
                  [routerLink]="['/', store.slug(), 'timeline']"
                  class="border-border -ms-px flex h-[22px] items-center border-l px-2.5 outline-none focus-visible:underline text-muted-foreground hover:text-foreground"
                  >Timeline</a
                >
              } @else {
                @for (l of layoutChoices(); track l.id; let first = $first) {
                  <button
                    type="button"
                    class="flex h-[22px] items-center px-2.5 outline-none focus-visible:underline"
                    [class]="
                      (first ? '' : 'border-border -ms-px border-l ') +
                      (d().layout === l.id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground')
                    "
                    [attr.aria-pressed]="d().layout === l.id"
                    [hlmTooltip]="l.hint"
                    (click)="patch({ layout: l.id })"
                  >
                    {{ l.label }}
                  </button>
                }
              }
            </div>
            <span class="bg-border h-[18px] w-px max-sm:hidden" aria-hidden="true"></span>
          </div>
        }
        @if (hint(); as h) {
          <span hint class="text-faint hidden font-mono text-[11px] xl:inline">{{ h }}</span>
        }
        @if (searchOpen() || search().trim()) {
          <input
            hint
            type="text"
            data-task-filter
            class="border-border placeholder:text-faint focus:border-ring h-[22px] w-44 border bg-transparent px-2 font-mono text-[11px] outline-none max-md:hidden"
            autocomplete="off"
            placeholder="Search tasks…"
            aria-label="Filter tasks"
            [value]="search()"
            (input)="search.set($any($event.target).value)"
            (keydown.escape)="closeSearch()"
            (blur)="search().trim() || closeSearch()"
          />
        }
        <div trailing class="ms-1 flex shrink-0 items-center gap-1">
          <button
            type="button"
            class="text-faint hover:text-foreground hover:bg-hover inline-flex size-[22px] items-center justify-center outline-none focus-visible:text-foreground max-md:hidden"
            aria-label="Search tasks"
            hlmTooltip="Search tasks"
            (click)="openSearch()"
          >
            <svg [lucideIcon]="searchIcon" [size]="13"></svg>
          </button>
          @if (hasTree()) {
            <button
              type="button"
              class="text-faint hover:text-foreground hover:bg-hover inline-flex size-[22px] items-center justify-center outline-none focus-visible:text-foreground"
              [attr.aria-label]="anyExpanded() ? 'Collapse all sub-tasks' : 'Expand all sub-tasks'"
              [hlmTooltip]="anyExpanded() ? 'Collapse all sub-tasks' : 'Expand all sub-tasks'"
              (click)="toggleAll()"
            >
              <svg [lucideIcon]="expandAllIcon" [size]="14"></svg>
            </button>
          }

          <hlm-popover align="end" sideOffset="4">
            <button
              hlmPopoverTrigger
              type="button"
              class="text-faint hover:text-foreground hover:bg-hover aria-expanded:text-foreground inline-flex size-[22px] items-center justify-center outline-none focus-visible:text-foreground"
              aria-label="Display options"
              hlmTooltip="Display options"
            >
              <svg [lucideIcon]="displayIcon" [size]="13"></svg>
            </button>
            <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-72 p-0 text-[13px]">
              <div class="flex flex-col gap-2.5 p-3">
                <label class="flex cursor-pointer items-center justify-between gap-3">
                  <span class="text-muted-foreground">Show empty groups</span>
                  <hlm-switch
                    size="sm"
                    aria-label="Show empty groups"
                    [checked]="d().showEmptyGroups"
                    (checkedChange)="patch({ showEmptyGroups: $event })"
                  />
                </label>
                @if (pageSwitch() && allowsFlow()) {
                  <!-- the page switch (List / Board / Timeline) is made of pages; Flow is a list layout -->
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-muted-foreground">List layout</span>
                    <span class="bg-muted/60 flex rounded-md p-0.5">
                      @for (o of listLayouts; track o.id) {
                        <button
                          type="button"
                          class="h-6 rounded-[5px] px-2 text-xs"
                          [class]="d().layout === o.id ? 'bg-background shadow-xs' : 'text-muted-foreground'"
                          [attr.aria-pressed]="d().layout === o.id"
                          [hlmTooltip]="o.hint"
                          (click)="patch({ layout: o.id })"
                        >
                          {{ o.label }}
                        </button>
                      }
                    </span>
                  </div>
                }
                @if (d().layout !== 'board') {
                  <label class="flex cursor-pointer items-center justify-between gap-3">
                    <span class="text-muted-foreground">Nest sub-tasks</span>
                    <hlm-switch
                      size="sm"
                      aria-label="Nest sub-tasks under their parent"
                      [checked]="d().nested"
                      (checkedChange)="patch({ nested: $event })"
                    />
                  </label>
                }
                @if (d().layout === 'list') {
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-muted-foreground">Density</span>
                    <span class="bg-muted/60 flex rounded-md p-0.5">
                      @for (o of densities; track o) {
                        <button
                          type="button"
                          class="h-6 rounded-[5px] px-2 text-xs capitalize"
                          [class]="
                            d().density === o ? 'bg-background shadow-xs' : 'text-muted-foreground'
                          "
                          (click)="patch({ density: o })"
                        >
                          {{ o }}
                        </button>
                      }
                    </span>
                  </div>
                }
              </div>
              <div class="p-3 pt-1">
                <p class="text-muted-foreground mb-2 text-xs">Display properties</p>
                <div class="flex flex-wrap gap-1.5">
                  @for (p of props; track p) {
                    <button
                      type="button"
                      class="h-6 rounded-md px-2 text-xs transition-colors"
                      [class]="
                        isShown(p)
                          ? 'bg-selected text-foreground'
                          : 'bg-secondary text-muted-foreground hover:text-foreground'
                      "
                      [attr.aria-pressed]="isShown(p)"
                      (click)="toggleProp(p)"
                    >
                      {{ propLabels[p] }}
                    </button>
                  }
                </div>
              </div>
              <div class="flex justify-end px-3 pb-2">
                <button
                  hlmBtn
                  variant="ghost"
                  size="sm"
                  class="text-muted-foreground h-7 text-xs"
                  (click)="resetDisplay()"
                >
                  Reset to default
                </button>
              </div>
            </hlm-popover-content>
          </hlm-popover>
        </div>
        </app-filter-bar>
      </div>
    </div>
    }

    @if (scoped().length === 0) {
      <app-empty-state [icon]="inbox" [title]="emptyTitle()" [description]="emptyDescription()">
        @if (canEdit() && showCreate()) {
          <button hlmBtn size="sm" (click)="create()">
            <svg [lucideIcon]="plus" [size]="14"></svg>New task
            <app-kbd keys="c" class="opacity-70" />
          </button>
        }
      </app-empty-state>
    } @else if (shown() === 0) {
      <app-empty-state
        [icon]="filterIcon"
        title="No tasks match"
        description="Nothing in this view matches the filters. Remove a filter or change the search."
      >
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
        @if (canEdit() && showCreate()) {
          <button hlmBtn size="sm" (click)="create()">
            <svg [lucideIcon]="plus" [size]="14"></svg>New task
          </button>
        }
      </app-empty-state>
    } @else if (d().layout === 'flow') {
      <app-issue-flow
        [groups]="rowColumns()"
        [grouped]="effectiveGroup() !== 'none'"
        [statuses]="store.settings().statuses.issue"
        [nested]="nested()"
        [selected]="selectedSet()"
        [selectable]="canEdit()"
        [selecting]="selection().length > 0"
        [canEdit]="canEdit()"
        [menu]="issueMenu"
        [groupLabel]="groupLabel"
        (toggleExpand)="toggleRow($event)"
        (toggleSelect)="onSelect($event.issue, $event.event)"
      />
    } @else {
      <app-kanban
        [columns]="rowColumns()"
        [layout]="d().layout === 'board' ? 'board' : 'list'"
        [disabled]="!draggable()"
        [prefix]="dropPrefix()"
        [rowHeight]="rowHeight()"
        [addable]="canEdit() && showCreate()"
        addLabel="New task in this group"
        emptyText="No tasks"
        [dropText]="dropText"
        (add)="createIn($event)"
        (moved)="move($event.item.issue, $event.to)"
      >
        <ng-template kanbanItem let-r>
          @let i = r.issue;
          <div
            [hlmContextMenuTrigger]="issueMenu"
            [hlmContextMenuTriggerData]="{ $implicit: i }"
            [disabled]="!canEdit()"
          >
            @if (d().layout === 'list') {
              <app-issue-row
                [issue]="i"
                [selected]="selectedSet().has(i.id)"
                [selectable]="canEdit() && !r.ghost"
                [selecting]="selection().length > 0"
                [hidden]="hiddenProps()"
                [compact]="d().density === 'compact'"
                [dateField]="dateField()"
                [tree]="nested()"
                [depth]="r.depth"
                [childCount]="r.childCount"
                [expanded]="r.expanded"
                [ghost]="r.ghost"
                (toggleExpand)="toggleRow(r.id)"
                (toggleSelect)="onSelect(i, $event)"
              />
            } @else {
              <app-issue-card
                class="mb-0"
                [issue]="i"
                [selected]="selectedSet().has(i.id)"
                [selectable]="canEdit()"
                [selecting]="selection().length > 0"
                [hidden]="hiddenProps()"
                [dateField]="dateField()"
                [showStatus]="effectiveGroup() !== 'status'"
                (toggleSelect)="onSelect(i, $event)"
              />
            }
          </div>
        </ng-template>
        <ng-template kanbanLabel let-key>
          <ng-container *ngTemplateOutlet="groupLabel; context: { $implicit: key }" />
        </ng-template>
      </app-kanban>
    }

    <!-- Group header label, shared by the list / board and the flow sections -->
    <ng-template #groupLabel let-key>
      @switch (effectiveGroup()) {
        @case ('status') {
          <v3-status-dot [status]="$any(key)" />
        }
        @case ('kind') {
          <app-issue-kind [kind]="$any(key)" />
        }
        @case ('priority') {
          <app-priority-icon [priority]="$any(key)" />
        }
        @case ('assigneeId') {
          @if (key) {
            <app-actor-avatar [actor]="{ type: 'user', id: key }" [size]="16" />
          } @else {
            <svg
              [lucideIcon]="noUser"
              [size]="16"
              [strokeWidth]="1.5"
              class="text-muted-foreground"
            ></svg>
          }
        }
        @case ('projectId') {
          @if (store.getProject(key); as p) {
            <app-project-glyph [project]="p" [size]="14" />
          } @else {
            <svg [lucideIcon]="projectIcon" [size]="14" class="text-muted-foreground"></svg>
          }
        }
      }
      <span class="truncate">{{ label(key) }}</span>
    </ng-template>

    <!-- Right-click menu (acts on the selection when the clicked issue is part of it) -->
    <ng-template #issueMenu let-i>
      @let ids = targetsFor(i);
      <!-- v3 · 14 Row menu: Open · Status · Assign to… · Priority | Add subtask · Copy link · provider | Delete -->
      <hlm-dropdown-menu class="w-[260px]">
        @if (ids.length > 1) {
          <hlm-dropdown-menu-label class="truncate">{{ ids.length }} tasks</hlm-dropdown-menu-label>
        }
        <hlm-dropdown-menu-group>
          @if (ids.length === 1) {
            <button hlmDropdownMenuItem (triggered)="actions.open(i)">
              <svg [lucideIcon]="openIcon" [size]="14"></svg> Open
              <hlm-dropdown-menu-shortcut>↵</hlm-dropdown-menu-shortcut>
            </button>
          }
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="statusSub">
            <app-status-icon entity="issue" [status]="i.status" /> Status
            <hlm-dropdown-menu-shortcut>S</hlm-dropdown-menu-shortcut>
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="assigneeSub">
            <svg [lucideIcon]="noUser" [size]="14"></svg> Assign to…
            <hlm-dropdown-menu-shortcut>A</hlm-dropdown-menu-shortcut>
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="prioritySub">
            <app-priority-icon [priority]="i.priority" /> Priority
            <hlm-dropdown-menu-shortcut>P</hlm-dropdown-menu-shortcut>
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          @if (ids.length === 1) {
            <button hlmDropdownMenuItem (triggered)="ui.openCreate('issue', { parentId: i.id })">
              <svg [lucideIcon]="subtaskIcon" [size]="14"></svg> Add subtask
              <hlm-dropdown-menu-shortcut>⇧C</hlm-dropdown-menu-shortcut>
            </button>
          }
          <button hlmDropdownMenuItem (triggered)="actions.copyLinks(ids)">
            <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy
            {{ ids.length > 1 ? 'links' : 'link' }}
            <hlm-dropdown-menu-shortcut>⇧⌘L</hlm-dropdown-menu-shortcut>
          </button>
          @if (ids.length === 1 && i.externalUrl) {
            <a hlmDropdownMenuItem [href]="i.externalUrl" target="_blank" rel="noopener noreferrer">
              <svg [lucideIcon]="openIcon" [size]="14"></svg>
              Open issue in {{ i.source === 'gitlab' ? 'GitLab' : i.source === 'github' ? 'GitHub' : 'tracker' }} ↗
            </a>
          }
          <button hlmDropdownMenuItem (triggered)="actions.copyKeys(ids)">
            <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy
            {{ ids.length > 1 ? 'keys' : 'key' }}
            <hlm-dropdown-menu-shortcut>⇧⌘K</hlm-dropdown-menu-shortcut>
          </button>
          @if (ids.length === 1) {
            <button hlmDropdownMenuItem (triggered)="actions.copyBranch(i.id)">
              <svg [lucideIcon]="branchIcon" [size]="14"></svg> Copy git branch name
              <hlm-dropdown-menu-shortcut>⇧⌘G</hlm-dropdown-menu-shortcut>
            </button>
            <button hlmDropdownMenuItem (triggered)="favorites.toggle('issue', i.id)">
              <svg
                [lucideIcon]="starIcon"
                [size]="14"
                [attr.fill]="favorites.has('issue', i.id) ? 'currentColor' : 'none'"
              ></svg>
              {{ favorites.has('issue', i.id) ? 'Remove from favorites' : 'Add to favorites' }}
            </button>
            <button
              hlmDropdownMenuItem
              (triggered)="actions.openPrompt('duplicate', ids)"
              [disabled]="!!i.duplicateOfId"
            >
              <svg [lucideIcon]="copyIcon" [size]="14"></svg> Mark as duplicate…
            </button>
          }
        </hlm-dropdown-menu-group>
        @if (store.allowed('deleteIssues')) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem variant="destructive" (triggered)="actions.remove(ids)">
            <svg [lucideIcon]="trash" [size]="14"></svg> Delete{{
              ids.length > 1 ? ' ' + ids.length + ' tasks' : ''
            }}
            <hlm-dropdown-menu-shortcut>⌫</hlm-dropdown-menu-shortcut>
          </button>
        }
      </hlm-dropdown-menu>

      <ng-template #statusSub>
        <hlm-dropdown-menu-sub class="w-48">
          @for (o of statusOpts; track o.value; let n = $index) {
            <button hlmDropdownMenuItem (triggered)="actions.setStatus(ids, $any(o.value))">
              <app-issue-option-glyph [option]="o" /> {{ o.label }}
              @if (allHave(ids, 'status', o.value)) {
                <svg [lucideIcon]="checkIcon" [size]="13" class="ml-auto"></svg>
              } @else {
                <hlm-dropdown-menu-shortcut>{{ n + 1 }}</hlm-dropdown-menu-shortcut>
              }
            </button>
          }
        </hlm-dropdown-menu-sub>
      </ng-template>
      <ng-template #prioritySub>
        <hlm-dropdown-menu-sub class="w-44">
          @for (o of priorityOpts; track o.value) {
            <button hlmDropdownMenuItem (triggered)="actions.setPriority(ids, $any(o.value))">
              <app-issue-option-glyph [option]="o" /> {{ o.label }}
              @if (allHave(ids, 'priority', o.value)) {
                <svg [lucideIcon]="checkIcon" [size]="13" class="ml-auto"></svg>
              }
            </button>
          }
        </hlm-dropdown-menu-sub>
      </ng-template>
      <ng-template #assigneeSub>
        <hlm-dropdown-menu-sub class="max-h-80 w-52 overflow-y-auto">
          @if (store.me(); as me) {
            <button hlmDropdownMenuItem (triggered)="actions.setAssignee(ids, me.id)">
              <app-actor-avatar [actor]="{ type: 'user', id: me.id }" [size]="16" /> Assign to me
              <hlm-dropdown-menu-shortcut><app-kbd keys="i" /></hlm-dropdown-menu-shortcut>
            </button>
            <hlm-dropdown-menu-separator />
          }
          @for (o of assigneeOpts(); track o.value) {
            <button hlmDropdownMenuItem (triggered)="actions.setAssignee(ids, o.value || null)">
              <app-issue-option-glyph [option]="o" /> <span class="truncate">{{ o.label }}</span>
              @if (allHave(ids, 'assigneeId', o.value)) {
                <svg [lucideIcon]="checkIcon" [size]="13" class="ml-auto shrink-0"></svg>
              }
            </button>
          }
        </hlm-dropdown-menu-sub>
      </ng-template>
    </ng-template>

    <!-- Status bar: what is open, this week's delta and the active filters. -->
    @if (statusBar()) {
    <app-status-bar>
      <span class="tabular-nums">{{ flow().open }} open · {{ flow().inProgress }} in progress</span>
      <span
        class="flex items-center gap-1.5 tabular-nums"
        [attr.aria-label]="flow().opened + ' opened and ' + flow().closed + ' closed this week'"
      >
        <span class="text-diff-add">+{{ flow().opened }}</span>
        <span class="text-diff-del">−{{ flow().closed }}</span>
        <span>this week</span>
      </span>
      @if (hasFilters()) {
        <span class="truncate">{{ shown() }} shown · {{ filterSummary() }}</span>
      }
      @if (hasFilters()) {
        <button
          end
          type="button"
          class="hover:text-foreground underline-offset-2 hover:underline"
          (click)="clearFilters()"
        >
          Clear filters
        </button>
      }
    </app-status-bar>
    }

    <!-- Bulk action bar -->
    @if (selection().length) {
      <div
        class="pointer-events-none absolute inset-x-0 bottom-11 z-20 flex justify-center px-4 max-md:fixed max-md:bottom-[calc(3.0625rem+env(safe-area-inset-bottom)+0.5rem)]"
      >
        <!-- v3 selection bar: "2 selected" | Status S · Assign A · Move to project M · Delete ⌫ -->
        <div
          class="bg-secondary border-border-strong pointer-events-auto flex max-w-full items-center gap-3 overflow-x-auto border py-2 pr-2.5 pl-4 shadow-[0_12px_32px_rgb(0_0_0_/_0.6)]"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span class="text-foreground font-mono text-[11.5px] whitespace-nowrap">
            <span class="tabular-nums">{{ selection().length }}</span> selected
          </span>
          <button
            type="button"
            class="text-faint hover:text-foreground -ms-1.5 inline-flex size-5 shrink-0 items-center justify-center outline-none focus-visible:text-foreground"
            aria-label="Clear selection"
            hlmTooltip="Clear selection · Esc"
            (click)="ui.clearSelected()"
          >
            <svg [lucideIcon]="xIcon" [size]="12"></svg>
          </button>
          @if (selection().length < ordered().length) {
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground -ms-1.5 shrink-0 font-mono text-[11px] whitespace-nowrap outline-none focus-visible:underline"
              hlmTooltip="Select all · ⌘A"
              (click)="selectAll()"
            >
              Select all
            </button>
          }
          <span class="bg-border h-4 w-px shrink-0" aria-hidden="true"></span>
          <button
            hlmBtn
            variant="outline"
            class="shrink-0"
            hlmTooltip="Change status"
            (click)="actions.openPrompt('status', selection())"
          >
            Status <app-kbd keys="s" />
          </button>
          <button
            hlmBtn
            variant="outline"
            class="shrink-0"
            hlmTooltip="Assign"
            (click)="actions.openPrompt('assignee', selection())"
          >
            Assign <app-kbd keys="a" />
          </button>
          <button
            hlmBtn
            variant="outline"
            class="shrink-0"
            hlmTooltip="Set priority"
            (click)="actions.openPrompt('priority', selection())"
          >
            Priority <app-kbd keys="p" />
          </button>
          <button
            hlmBtn
            variant="outline"
            class="shrink-0"
            hlmTooltip="Labels"
            (click)="actions.openPrompt('label', selection())"
          >
            Labels <app-kbd keys="l" />
          </button>
          <button
            hlmBtn
            variant="outline"
            class="shrink-0"
            hlmTooltip="Move to project · ⇧P"
            (click)="actions.openPrompt('project', selection())"
          >
            Move to project <app-kbd keys="m" />
          </button>
          <button
            hlmBtn
            variant="outline"
            size="icon-sm"
            class="size-[26px] shrink-0"
            aria-label="Copy keys"
            hlmTooltip="Copy keys · ⇧⌘K"
            (click)="actions.copyKeys(selection())"
          >
            <svg [lucideIcon]="copyIcon" [size]="13"></svg>
          </button>
          @if (store.allowed('deleteIssues')) {
            <button
              hlmBtn
              variant="destructive"
              class="shrink-0"
              hlmTooltip="Delete · ⌘⌫"
              (click)="actions.remove(selection())"
            >
              Delete <app-kbd keys="backspace" />
            </button>
          }
        </div>
      </div>
    }
  `,
})
export class IssueBoard {
  protected readonly store = inject(TramaStore);
  private readonly listState = inject(ListStateStore);
  protected readonly ui = inject(UiStore);
  protected readonly actions = inject(IssueActions);
  protected readonly favorites = inject(FavoritesStore);
  private readonly document = inject(DOCUMENT);
  private readonly vp = inject(Viewport);
  private readonly router = inject(Router);
  private readonly filterBar = viewChild(FilterBar);

  /** Issues this board shows. */
  readonly issues = input.required<readonly Issue[]>();
  /** Restrict to these statuses (view tabs); null = all. */
  readonly scope = input<readonly IssueStatus[] | null>(null);
  /** Distinguishes drop-list ids when more than one board is on the page. */
  readonly dropPrefix = input('issue-col');
  /** Query `?status=` applied once when the board opens. */
  readonly status = input<string>();
  /** Query `?project=<projectId>` (links from a project). */
  readonly project = input<string>();
  readonly emptyTitle = input('No tasks yet');
  readonly emptyDescription = input(
    'Tasks track bugs, requests and incidents from triage through completion.',
  );
  readonly showCreate = input(true);
  /** localStorage key for display options. */
  readonly storageKey = input('trama.issues.display.v1');
  /** Remembered filters and search live under this key (a board embedded elsewhere gets its own). */
  readonly stateKey = input('issues');
  /** Prefilled into the create dialog (new task buttons), e.g. the project of an embedded board. */
  readonly createDefaults = input<Record<string, unknown>>({});

  // ── embedding (project tab, saved views): what the table is told instead of what the user picks ──
  /** Filters that always apply and are not shown or editable (a project, a saved view's query). */
  readonly baseFilters = input<readonly ViewFilter[]>([]);
  /** Show the search and filter / sort / group bar. A host that owns them (a saved view) turns it off. */
  readonly toolbar = input(true);
  /** Show the counts and active filters under the list. */
  readonly statusBar = input(true);
  /** Columns to leave out of the rows whatever the user chose in Display. */
  readonly hideProps = input<readonly IssueProp[]>([]);
  /** Fixed layout; hides the list / board switch. */
  readonly forceLayout = input<IssueLayout | null>(null);
  /** Layouts the user may pick (null = all). A remembered layout outside the list falls back to the first. */
  readonly layouts = input<readonly IssueLayout[] | null>(null);
  /**
   * The switch is made of pages (List → /tasks, Board → /board, Timeline → /timeline) instead of layouts
   * of this table. Used by the Tasks and Board pages.
   */
  readonly pageSwitch = input(false);
  /** Show the base filters as locked chips on the bar ("Assignee is me" on My tasks). */
  readonly showBase = input(false);
  /**
   * Write the filters into the page URL (`?f=status:in:todo&match=any`) and read them back from it, so
   * a filtered list can be linked. Only the page that owns the URL turns it on.
   */
  readonly syncUrl = input(false);
  /** Query `f` (repeated): the filters of a link. */
  readonly urlFilters = input<string | readonly string[] | undefined>(undefined);
  /** Query `match`: `any` when the filters of a link are alternatives. */
  readonly urlMatch = input<string | undefined>(undefined);
  /** Named views of the Status chip (the page's tabs: All / Active / Backlog / Done / Drafts). */
  readonly statusPresets = input<readonly FilterPreset[]>([]);
  readonly statusPreset = input('');
  readonly statusPresetChange = output<string>();
  /** Fixed grouping field (`'none'` = no grouping). */
  readonly forceGroup = input<IssueGroup | null>(null);
  /** Fixed ordering. */
  readonly forceSort = input<{ field: IssueSort; direction: 'asc' | 'desc' } | null>(null);

  // display options (persisted); `d` is what the table uses: the user's options with the fixed ones on top
  private readonly state = signal<IssueDisplay>(readDisplay('trama.issues.display.v1'));
  protected readonly d = computed<IssueDisplay>(() => {
    const s = this.state();
    const allowed = this.layouts();
    const layout =
      this.forceLayout() ?? (allowed?.length && !allowed.includes(s.layout) ? allowed[0] : null);
    const group = this.forceGroup();
    const sort = this.forceSort();
    return {
      ...s,
      ...(layout ? { layout } : {}),
      ...(group ? { groupBy: group } : {}),
      ...(sort ? { sortField: sort.field, sortDir: sort.direction } : {}),
    };
  });
  // Filters survive navigation inside the app (see ListStateStore); display options persist in localStorage.
  protected readonly filters = rememberKeyed<ViewFilter[]>(this.listState, () => `${this.stateKey()}.filters`, []);
  protected readonly search = rememberKeyed(this.listState, () => `${this.stateKey()}.search`, '');
  /** Do the filters all have to match, or any of them? */
  protected readonly match = rememberKeyed<FilterMatch>(this.listState, () => `${this.stateKey()}.match`, 'all');
  /** The search field is out (Filter · F); it stays while it holds text. */
  protected readonly searchOpen = signal(false);
  /** Sub-tasks the user collapsed (ids), remembered while the app is open. */
  private readonly collapsed = rememberKeyed<string[]>(this.listState, () => `${this.stateKey()}.collapsed`, []);
  private anchor: string | null = null;

  /** What the filters read besides the task: today, and which tasks have sub-tasks. */
  protected readonly queryCtx = computed<QueryContext>(() => {
    const parents = new Set<string>();
    for (const i of this.issues()) if (i.parentId) parents.add(i.parentId);
    return { now: new Date(), subtaskParents: parents };
  });
  protected readonly props = PROPS;
  protected readonly listFilterFields = LIST_FILTER_FIELDS;
  protected readonly boardFilterFields = BOARD_FILTER_FIELDS;
  protected readonly expandAllIcon = LucideChevronsUpDown;
  protected readonly listLayouts: readonly { id: IssueLayout; label: string; hint: string }[] = [
    { id: 'list', label: 'List', hint: 'Rows grouped by status' },
    { id: 'flow', label: 'Flow', hint: 'Tasks through the statuses over time' },
  ];
  private readonly allLayouts: readonly { id: IssueLayout; label: string; hint: string }[] = [
    { id: 'list', label: 'List', hint: 'Rows grouped by status' },
    { id: 'board', label: 'Board', hint: 'Columns you drag cards between' },
    { id: 'flow', label: 'Flow', hint: 'Tasks through the statuses over time' },
  ];
  /** Layouts the switch offers (the layout switch of embedded tables). */
  protected readonly layoutChoices = computed(() => {
    const allowed = this.layouts();
    return allowed ? this.allLayouts.filter((l) => allowed.includes(l.id)) : this.allLayouts;
  });
  protected readonly allowsFlow = computed(() => this.layouts()?.includes('flow') ?? true);
  protected readonly groupLabels = GROUP_LABEL;
  protected readonly sortLabels = SORT_LABEL;
  protected readonly propLabels = PROP_LABEL;
  protected readonly densities = ['comfortable', 'compact'] as const;

  // context-menu option lists
  protected readonly statusOpts = promptOptions(this.store, 'status', []);
  protected readonly priorityOpts = promptOptions(this.store, 'priority', []);
  protected readonly assigneeOpts = computed(() => promptOptions(this.store, 'assignee', []));

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly inbox = LucideInbox;
  protected readonly filterIcon = LucideListFilter;
  protected readonly displayIcon = LucideSlidersHorizontal;
  protected readonly noUser = LucideCircleUserRound;
  protected readonly projectIcon = LucideBox;
  protected readonly copyIcon = LucideCopy;
  protected readonly branchIcon = LucideGitBranch;
  protected readonly starIcon = LucideStar;
  protected readonly linkIcon = LucideLink;
  protected readonly openIcon = LucideExternalLink;
  protected readonly subtaskIcon = LucideListTree;
  protected readonly trash = LucideTrash2;
  protected readonly checkIcon = LucideCheck;

  protected readonly canEdit = computed(() => this.store.can('member'));
  /** The Status chip's views, by field (the filter bar draws them at the top of the chip's menu). */
  protected readonly presetMap = computed<Readonly<Record<string, readonly FilterPreset[]>>>(() => {
    const out: Record<string, readonly FilterPreset[]> = {};
    if (this.statusPresets().length) out['status'] = this.statusPresets();
    return out;
  });
  protected readonly presetActive = computed<Readonly<Record<string, string>>>(() => ({
    status: this.statusPreset(),
  }));
  /** Whether a view other than the first (All) is picked. */
  private readonly presetOn = computed(() => {
    const p = this.statusPresets();
    return p.length > 0 && this.statusPreset() !== p[0].id;
  });
  protected readonly hasFilters = computed(
    () => this.filters().length > 0 || this.search().trim().length > 0 || this.presetOn(),
  );
  /** What the board says next to the chips. */
  protected readonly hint = computed(() => {
    if (this.d().layout !== 'board' || !this.draggable()) return '';
    const g = this.effectiveGroup();
    return g === 'status'
      ? 'Drag a card to change status — status is always set by people'
      : `Drag a card to change ${g === 'assigneeId' ? 'assignee' : g}`;
  });
  /** "Drop to set In review" under the column a card is held over. */
  protected readonly dropText = (key: string): string =>
    this.effectiveGroup() === 'status'
      ? `Drop to set ${this.label(key)}`
      : `Drop to move to ${this.label(key)}`;
  protected readonly effectiveGroup = computed<IssueGroup>(() => {
    const g = this.d().groupBy;
    return this.d().layout === 'board' && g === 'none' ? 'status' : g;
  });
  /** What the filter bar shows as the grouping (`null` = no grouping). */
  protected readonly groupField = computed<string | null>(() => {
    const g = this.effectiveGroup();
    return g === 'none' ? null : g;
  });
  protected readonly sortSpec = computed(() => ({ field: this.d().sortField, direction: this.d().sortDir }));
  protected readonly hiddenProps = computed<IssueProp[]>(() => [...new Set([...this.d().hidden, ...this.hideProps()])]);
  protected readonly draggable = computed(
    () => this.canEdit() && DRAGGABLE.has(this.effectiveGroup()),
  );
  /** The date column is the due date, unless the list is sorted by when tasks were created / updated. */
  protected readonly dateField = computed<'dueDate' | 'updatedAt' | 'createdAt'>(() => {
    const sort = this.d().sortField;
    return sort === 'createdAt' || sort === 'updatedAt' ? sort : 'dueDate';
  });

  /**
   * Row heights of the desktop list (the phone rows are two lines of varying height): lets the list draw
   * only the rows near the viewport. Keep in step with the row classes in issue-items.ts.
   */
  protected readonly rowHeight = computed<((row: IssueTreeRow) => number) | null>(() => {
    if (this.vp.isMobile() || this.d().layout !== 'list') return null;
    const row = this.d().density === 'compact' ? ROW_COMPACT_PX : ROW_PX;
    const nested = this.nested();
    return (r) => (nested && r.depth > 0 ? SUBTASK_ROW_PX : row);
  });

  protected readonly flow = computed(() =>
    issueFlow(this.issues(), this.store.settings().statuses.issue),
  );
  protected readonly filterSummary = computed(() => {
    const parts = this.filters().map((f) => {
      const n = Array.isArray(f.value) ? f.value.length : 1;
      return `${FILTER_LABEL[f.field] ?? fieldLabel('issue', f.field)}${n > 1 ? ` (${n})` : ''}`;
    });
    if (this.presetOn()) parts.push('Status');
    const q = this.search().trim();
    if (q) parts.push(`“${q}”`);
    return parts.join(', ');
  });

  /** Issues inside the current view tab. */
  protected readonly scoped = computed(() => {
    const s = this.scope();
    const set = s ? new Set<string>(s) : null;
    const inScope = set ? this.issues().filter((i) => set.has(i.status)) : this.issues();
    const base = this.baseFilters();
    return base.length ? queryItems('issue', inScope, { filters: base }, this.queryCtx()) : inScope;
  });
  /** What the value counts of the filter menus are taken from. */
  protected readonly filterPool = computed(() => this.scoped());

  protected readonly columns = computed<Column[]>(() => {
    const group = this.effectiveGroup();
    const d = this.d();
    let include: string[] | undefined;
    if (d.showEmptyGroups || (d.layout === 'board' && group === 'status')) {
      include = groupUniverse(this.store, group);
      // keep empty status columns inside the view tab / status filter
      if (include && group === 'status') {
        const scope = this.scope();
        const ctx = this.queryCtx();
        const statusFilter = this.match() === 'all' ? this.filters().find((f) => f.field === 'status') : undefined;
        include = include.filter(
          (s) =>
            (!scope || scope.includes(s as IssueStatus)) &&
            (!statusFilter || matchesFilter('issue', { status: s } as Issue, statusFilter, ctx)),
        );
      }
    }
    const ctx = this.queryCtx();
    const filters = this.filters();
    const inScope = this.scoped();
    // "Match any": a task needs one of the filters (the base filters still all apply).
    const items =
      this.match() === 'any' && filters.length > 1
        ? inScope.filter((i) => filters.some((f) => matchesFilter('issue', i, f, ctx)))
        : inScope;
    return queryGroups(
      'issue',
      items as Issue[],
      {
        filters: [...this.baseFilters(), ...(this.match() === 'any' && filters.length > 1 ? [] : filters)],
        search: this.search(),
        sort: { field: d.sortField, direction: d.sortDir },
        groupBy: group === 'none' ? null : group,
      },
      this.queryCtx(),
      include,
    );
  });

  /** Ids of every task that passed the filters, in any group. */
  private readonly matching = computed(
    () => new Set(this.columns().flatMap((c) => c.items.map((i) => i.id))),
  );
  protected readonly shown = computed(() => this.matching().size);

  /** Sub-tasks nest under their parent (list and flow layouts; the board shows them as cards). */
  protected readonly nested = computed(() => this.d().layout !== 'board' && this.d().nested);
  /** The rows each group shows: the matching tasks, as a tree when nested. */
  protected readonly rowColumns = computed<RowColumn[]>(() => {
    if (!this.nested()) {
      return this.columns().map((c) => ({ key: c.key, items: flatIssueRows(c.items), count: c.items.length, parentIds: [] }));
    }
    const byId = this.store.issueById();
    const matching = this.matching();
    const collapsed = new Set(this.collapsed());
    return this.columns().map((c) => {
      const tree = buildIssueTree(c.items, byId, matching, collapsed);
      return { key: c.key, items: tree.rows, count: c.items.length, parentIds: tree.parentIds };
    });
  });
  private readonly parentIds = computed(() => [...new Set(this.rowColumns().flatMap((c) => c.parentIds))]);
  protected readonly hasTree = computed(() => this.nested() && this.parentIds().length > 0);
  protected readonly anyExpanded = computed(() => {
    const collapsed = new Set(this.collapsed());
    return this.parentIds().some((id) => !collapsed.has(id));
  });
  /** The rows by task id, to follow ← / → from the focused row. */
  private readonly rowById = computed(() => {
    const map = new Map<string, IssueTreeRow>();
    for (const c of this.rowColumns()) for (const r of c.items) if (!r.ghost && !map.has(r.id)) map.set(r.id, r);
    return map;
  });

  /** Visible task ids in display order (context rows and collapsed sub-tasks are not part of it). */
  protected readonly ordered = computed(() => [
    ...new Set(this.rowColumns().flatMap((c) => c.items.filter((r) => !r.ghost).map((r) => r.id))),
  ]);
  private readonly visibleSet = computed(() => new Set(this.ordered()));
  /** Selected issues that are visible on this board. */
  protected readonly selection = computed(() =>
    this.ui.selectedRowIds().filter((id) => this.visibleSet().has(id)),
  );
  protected readonly selectedSet = computed(() => new Set(this.selection()));
  /** What keyboard actions apply to: the selection, else the focused row. */
  private readonly targets = computed<string[]>(() => {
    const sel = this.selection();
    if (sel.length) return sel;
    const f = this.ui.focusedRowId();
    return f && this.visibleSet().has(f) ? [f] : [];
  });

  private readonly _keys = usePageShortcuts([
    {
      keys: 's',
      label: 'Change status',
      group: 'Tasks',
      when: () => this.canAct(),
      run: () => this.actions.openPrompt('status', this.targets()),
    },
    {
      keys: 'p',
      label: 'Set priority',
      group: 'Tasks',
      when: () => this.canAct(),
      run: () => this.actions.openPrompt('priority', this.targets()),
    },
    {
      keys: 'a',
      label: 'Assign to…',
      group: 'Tasks',
      when: () => this.canAct(),
      run: () => this.actions.openPrompt('assignee', this.targets()),
    },
    {
      keys: 'i',
      label: 'Assign to me',
      group: 'Tasks',
      when: () => this.canAct(),
      run: () => this.actions.toggleAssignMe(this.targets()),
    },
    {
      keys: 'l',
      label: 'Toggle labels…',
      group: 'Tasks',
      when: () => this.canAct(),
      run: () => this.actions.openPrompt('label', this.targets()),
    },
    {
      keys: 'shift+p',
      label: 'Move to project…',
      group: 'Tasks',
      when: () => this.canAct(),
      run: () => this.actions.openPrompt('project', this.targets()),
    },
    {
      keys: 'm',
      label: 'Move to project…',
      group: 'Tasks',
      hidden: true,
      when: () => this.canAct(),
      run: () => this.actions.openPrompt('project', this.targets()),
    },
    {
      keys: 'left',
      label: 'Collapse sub-tasks / go to parent',
      group: 'Tasks',
      when: () => this.treeKey('left', false),
      run: () => this.treeKey('left', true),
    },
    {
      keys: 'right',
      label: 'Expand sub-tasks / go to first sub-task',
      group: 'Tasks',
      when: () => this.treeKey('right', false),
      run: () => this.treeKey('right', true),
    },
    {
      keys: 'e',
      label: 'Set estimate…',
      group: 'Tasks',
      when: () => this.canAct() && this.store.estimateScale() !== 'none',
      run: () => this.actions.openPrompt('estimate', this.targets()),
    },
    {
      keys: 'mod+shift+k',
      label: 'Copy task key',
      group: 'Tasks',
      when: () => this.targets().length > 0 && !this.typing(),
      run: () => this.actions.copyKeys(this.targets()),
    },
    {
      keys: 'mod+shift+l',
      label: 'Copy task link',
      group: 'Tasks',
      when: () => this.targets().length > 0 && !this.typing(),
      run: () => this.actions.copyLinks(this.targets()),
    },
    {
      keys: 'mod+shift+g',
      label: 'Copy git branch name',
      group: 'Tasks',
      when: () => this.targets().length === 1 && !this.typing(),
      run: () => this.actions.copyBranch(this.targets()[0]),
    },
    {
      keys: 'mod+shift+.',
      label: 'Copy git branch name',
      group: 'Tasks',
      hidden: true,
      when: () => this.targets().length === 1 && !this.typing(),
      run: () => this.actions.copyBranch(this.targets()[0]),
    },
    {
      keys: 'mod+shift+>',
      label: 'Copy git branch name',
      group: 'Tasks',
      hidden: true,
      when: () => this.targets().length === 1 && !this.typing(),
      run: () => this.actions.copyBranch(this.targets()[0]),
    },
    {
      keys: 'mod+backspace',
      label: 'Delete task',
      group: 'Tasks',
      when: () => this.canAct() && !this.typing(),
      run: () => this.actions.remove(this.targets()),
    },
    {
      // The selection bar shows ⌫ on Delete; the confirmation dialog still guards it.
      keys: 'backspace',
      label: 'Delete task',
      group: 'Tasks',
      hidden: true,
      when: () => this.canAct() && this.selection().length > 0 && !this.typing(),
      run: () => this.actions.remove(this.targets()),
    },
    {
      keys: 'mod+a',
      label: 'Select all tasks',
      group: 'Tasks',
      when: () => this.canEdit() && this.shown() > 0 && !this.typing(),
      run: () => this.selectAll(),
    },
    { keys: 'f', label: 'Filter tasks', group: 'Tasks', when: () => this.toolbar(), run: () => this.openFilter() },
  ]);

  constructor() {
    // Display options follow the storage key (one set per board context) and persist on change.
    let loadedKey = '';
    effect(() => {
      const key = this.storageKey();
      const d = this.state();
      if (key !== loadedKey) {
        loadedKey = key;
        this.state.set(readDisplay(key));
        return;
      }
      writeDisplay(key, d);
    });
    // `?status=` / `?project=` from links (attention, project pages, saved links).
    // On open, a link's params override the remembered filters; with no params the remembered ones stay.
    effect(() => {
      const status = this.status();
      const project = this.project();
      untracked(() => {
        this.filters.update((f) => {
          let next = f;
          if (project) next = setFilter(next, 'projectId', 'in', [project]);
          const known = this.store.settings().statuses.issue.some((entry) => entry.id === status || entry.type === status);
          if (status && known) next = setFilter(next, 'status', 'in', [status]);
          return next;
        });
      });
    });
    // Filters in the URL (`?f=status:in:todo,done&match=any`): a link brings its filters, and what the
    // user changes is written back (replacing the history entry), so the address is always shareable.
    // `written` is the last state this board put in the URL: seeing it come back changes nothing.
    let written = '';
    const stateKey = (list: readonly string[], match: string): string => `${list.join('|')}#${match}`;
    effect(() => {
      if (!this.syncUrl()) return;
      const raw = this.urlFilters();
      const match = this.urlMatch() === 'any' ? 'any' : 'all';
      untracked(() => {
        if (raw === undefined && this.urlMatch() === undefined) return;
        const incoming = parseFilters(raw, 'issue', true);
        const key = stateKey(serializeFilters(incoming), match);
        if (key === written) return;
        written = key;
        if (!sameFilters(incoming, this.filters())) this.filters.set(incoming);
        if (this.match() !== match) this.match.set(match);
      });
    });
    effect(() => {
      if (!this.syncUrl()) return;
      const list = serializeFilters(this.filters());
      const match = this.match();
      untracked(() => {
        const key = stateKey(list, match);
        const inUrl = stateKey(
          serializeFilters(parseFilters(this.urlFilters(), 'issue', true)),
          this.urlMatch() === 'any' ? 'any' : 'all',
        );
        if (key === written || (key === inUrl && !this.status() && !this.project())) return;
        written = key;
        void this.router.navigate([], {
          queryParams: {
            f: list.length ? list : null,
            match: match === 'any' ? 'any' : null,
            // now part of `f`
            status: null,
            project: null,
          },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      });
    });
    // The Flow layout draws each task's status changes: make sure they are loaded, not just the recent ones.
    effect(() => {
      if (this.d().layout === 'flow') void this.store.loadStatusHistory();
    });
    // Prev / next on the detail page follow this order.
    effect(() => this.actions.navOrder.set(this.ordered()));
    inject(DestroyRef).onDestroy(() => {
      this.ui.clearSelected();
      this.ui.setFocusedRow(null);
    });
  }

  // ───────────────────────── display ─────────────────────────

  protected patch(p: Partial<IssueDisplay>): void {
    this.state.update((d) => ({ ...d, ...p }));
  }

  protected resetDisplay(): void {
    this.state.set({ ...DEFAULT_DISPLAY, hidden: [...DEFAULT_DISPLAY.hidden] });
  }

  protected setGroup(field: string | null): void {
    this.patch({ groupBy: (field ?? 'none') as IssueGroup });
  }

  protected setSort(sort: { field: string; direction: 'asc' | 'desc' } | null): void {
    if (sort && (SORTS as readonly string[]).includes(sort.field)) {
      this.patch({ sortField: sort.field as IssueSort, sortDir: sort.direction });
    }
  }

  // ───────────────────────── sub-task tree ─────────────────────────

  protected toggleRow(id: string): void {
    this.collapsed.update((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  }

  protected toggleAll(): void {
    this.collapsed.set(this.anyExpanded() ? [...this.parentIds()] : []);
  }

  /** ← collapses the focused row, or moves to its parent; → expands it, or moves to its first sub-task. */
  private treeKey(dir: 'left' | 'right', run: boolean): boolean {
    if (!this.nested()) return false;
    const id = this.ui.focusedRowId();
    const row = id ? this.rowById().get(id) : undefined;
    if (!row) return false;
    if (dir === 'left') {
      if (row.expanded) {
        if (run) this.toggleRow(row.id);
        return true;
      }
      const parent = row.parentId ? this.rowById().get(row.parentId) : undefined;
      if (!parent) return false;
      if (run) this.focusRow(parent.id);
      return true;
    }
    if (row.childCount === 0) return false;
    if (!row.expanded) {
      if (run) this.toggleRow(row.id);
      return true;
    }
    const child = this.rowColumns()
      .flatMap((c) => c.items)
      .find((r) => r.parentId === row.id);
    if (!child) return false;
    if (run) this.focusRow(child.id);
    return true;
  }

  private focusRow(id: string): void {
    this.ui.setFocusedRow(id);
    this.document
      .querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }

  protected isShown(p: IssueProp): boolean {
    return !this.d().hidden.includes(p);
  }

  protected toggleProp(p: IssueProp): void {
    this.patch({
      hidden: this.isShown(p) ? [...this.d().hidden, p] : this.d().hidden.filter((x) => x !== p),
    });
  }

  protected label(key: string): string {
    return groupLabel(this.store, this.effectiveGroup(), key);
  }

  // ───────────────────────── filters ─────────────────────────

  protected clearFilters(): void {
    this.filters.set([]);
    this.search.set('');
    this.match.set('all');
    const first = this.statusPresets()[0];
    if (first && this.presetOn()) this.statusPresetChange.emit(first.id);
  }

  /** Filter · F: open the "add filter" menu (properties, then values). */
  openFilter(): void {
    this.filterBar()?.openAdd();
  }

  /** Filter · F: bring out the search field and put the cursor in it. */
  openSearch(): void {
    this.searchOpen.set(true);
    // phones always show their own field; on desktop wait for the inline one to render
    setTimeout(() =>
      this.document
        .querySelector<HTMLInputElement>('input[data-task-filter], app-search-input input')
        ?.focus(),
    );
  }

  protected closeSearch(): void {
    this.search.set('');
    this.searchOpen.set(false);
  }

  // ───────────────────────── create / move ─────────────────────────

  protected create(): void {
    this.ui.openCreate('issue', { ...this.createDefaults() });
  }

  /** "+" in a group header: prefill what the group means. */
  protected createIn(key: string): void {
    const defaults: Record<string, unknown> = { ...this.createDefaults() };
    switch (this.effectiveGroup()) {
      case 'status':
        defaults['status'] = key;
        break;
      case 'priority':
        defaults['priority'] = key;
        break;
      case 'kind':
        defaults['kind'] = key;
        break;
      case 'assigneeId':
        if (key) defaults['assigneeId'] = key;
        break;
      case 'projectId':
        if (key) defaults['projectId'] = key;
        break;
    }
    this.ui.openCreate('issue', defaults);
  }

  protected move(issue: Issue, value: string): void {
    switch (this.effectiveGroup()) {
      case 'status':
        if (issue.status !== value)
          void this.store.updateIssue(issue.id, { status: value as IssueStatus });
        break;
      case 'priority':
        if (issue.priority !== value)
          void this.store.updateIssue(issue.id, { priority: value as Priority });
        break;
      case 'assigneeId':
        if ((issue.assigneeId ?? '') !== value)
          void this.store.updateIssue(issue.id, { assigneeId: value || null });
        break;
    }
  }

  // ───────────────────────── selection ─────────────────────────

  protected onSelect(issue: Issue, e: MouseEvent): void {
    const ids = this.ordered();
    if (e.shiftKey && this.anchor && ids.includes(this.anchor)) {
      const a = ids.indexOf(this.anchor);
      const b = ids.indexOf(issue.id);
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      this.ui.setSelected([...new Set([...this.selection(), ...range])]);
    } else {
      this.ui.toggleSelected(issue.id);
    }
    this.anchor = issue.id;
    this.ui.setFocusedRow(issue.id);
  }

  protected selectAll(): void {
    this.ui.setSelected([...this.ordered()]);
  }

  /** Context-menu targets: the whole selection when the clicked issue is in it. */
  protected targetsFor(issue: Issue): string[] {
    const sel = this.selection();
    return sel.length > 1 && sel.includes(issue.id) ? sel : [issue.id];
  }

  protected allHave(
    ids: readonly string[],
    field: 'status' | 'priority' | 'assigneeId',
    value: string,
  ): boolean {
    const list = this.actions.issues(ids);
    return list.length > 0 && list.every((i) => (i[field] ?? '') === value);
  }

  private canAct(): boolean {
    return this.canEdit() && this.targets().length > 0;
  }

  private typing(): boolean {
    return isTypingTarget(this.document.activeElement);
  }
}
