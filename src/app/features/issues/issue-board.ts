// Issue list and board: filters, display options (persisted), drag-and-drop between groups,
// multi-select with a bulk action bar, right-click menu and keyboard actions on the focused row.
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import {
  LucideArrowDownWideNarrow,
  LucideArrowUpNarrowWide,
  LucideCheck,
  LucideBox,
  LucideTag,
  LucideCircleUserRound,
  LucideColumns3,
  LucideCopy,
  LucideGitBranch,
  LucideStar,
  LucideDynamicIcon,
  LucideExternalLink,
  LucideHexagon,
  LucideInbox,
  LucideLink,
  LucideList,
  LucideListFilter,
  LucidePlus,
  LucideSearch,
  LucideSlidersHorizontal,
  LucideTrash2,
  LucideUsers,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmContextMenuImports } from '@spartan-ng/helm/context-menu';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmPopoverImports } from '@spartan-ng/helm/popover';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  ISSUE_STATUSES,
  FavoritesStore,
  ListStateStore,
  NablaStore,
  UiStore,
  filterValues,
  isTypingTarget,
  queryGroups,
  setFilter,
  usePageShortcuts,
  type Issue,
  type IssueStatus,
  type Priority,
  type ViewFilter,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { IssueKindLabel } from '../../shared/issue';
import { Kanban, KanbanItemDirective, KanbanLabelDirective } from '../../shared/kanban';
import { PeekPanel } from '../../shared/peek-panel';
import { Kbd } from '../../shared/kbd';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { ProjectGlyph } from '../projects/project-glyph';
import { Picker, type PickOption } from '../workstreams/picker';
import { priorityOptions, projectFilterOptions, teamOptions, userOptions } from '../workstreams/ws-model';
import { DemandFilters } from '../customers/demand-filters';
import { IssueActions } from './issue-actions';
import { IssueCard, IssueRow } from './issue-items';
import {
  DEFAULT_DISPLAY,
  GROUPS,
  GROUP_LABEL,
  PROPS,
  PROP_LABEL,
  SORTS,
  SORT_LABEL,
  groupLabel,
  groupUniverse,
  issueKindOptions,
  issueStatusOptions,
  milestoneFilterOptions,
  readDisplay,
  workstreamPickOptions,
  writeDisplay,
  type IssueDisplay,
  type IssueGroup,
  type IssueProp,
} from './issue-model';
import { IssueOptionGlyph, promptOptions } from './issue-options';
import { LabelPicker } from '../../shared/label-picker';
import { SearchInput } from '../../shared/search-input';

interface Column {
  key: string;
  items: Issue[];
}

const DRAGGABLE = new Set<IssueGroup>(['status', 'priority', 'teamId', 'assigneeId']);

@Component({
  selector: 'app-issue-board',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SearchInput,
    LabelPicker,
    HlmButtonImports,
    HlmPopoverImports,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    HlmTooltip,
    LucideDynamicIcon,
    Picker,
    DemandFilters,
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
    Kbd,
    PeekPanel,
  ],
  host: { class: 'relative flex min-h-0 flex-1 flex-col' },
  template: `
    <!-- Filter + display toolbar -->
    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-1.5 sm:px-6">
      <app-search-input noun="issues" [(value)]="search" />
      <div class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overflow-y-hidden overscroll-x-contain max-sm:basis-full">
        <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statuses" [value]="fv('status')" (valueChange)="setF('status', $event)" />
        <app-picker variant="chip" label="Type" [multiple]="true" [searchable]="false" [options]="kinds" [value]="fv('kind')" (valueChange)="setF('kind', $event)" />
        <app-picker variant="chip" label="Priority" [multiple]="true" [searchable]="false" [options]="priorities" [value]="fv('priority')" (valueChange)="setF('priority', $event)" />
        <app-picker variant="chip" label="Assignee" [multiple]="true" [options]="assigneeFilter()" [value]="fv('assigneeId')" (valueChange)="setF('assigneeId', $event)" />
        <app-picker variant="chip" label="Team" [multiple]="true" [options]="teams()" [value]="fv('teamId')" (valueChange)="setF('teamId', $event)" />
        <app-label-picker variant="chip" label="Label" [creatable]="false" [manageLink]="false" [value]="fv('labels')" (valueChange)="setF('labels', $event)" />
        <app-picker variant="chip" label="Workstream" [multiple]="true" [options]="wsFilter()" [value]="fv('workstreamIds')" (valueChange)="setF('workstreamIds', $event)" />
        @if (projectFilter().length > 1) {
          <app-picker variant="chip" label="Project" [multiple]="true" [icon]="projectIcon" [options]="projectFilter()" [value]="fv('projectId')" (valueChange)="setF('projectId', $event)" />
        }
        @if (milestoneFilter().length) {
          <app-picker variant="chip" label="Milestone" [multiple]="true" [options]="milestoneFilter()" [value]="fv('milestoneIds')" (valueChange)="setF('milestoneIds', $event)" />
        }
        <app-demand-filters [filters]="filters()" (filtersChange)="filters.set($event)" />
        @if (hasFilters()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs" (click)="clearFilters()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <div class="bg-muted/60 flex items-center rounded-md p-0.5" role="group" aria-label="Layout">
          <button
            type="button"
            class="flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-xs"
            [class]="d().layout === 'list' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'"
            [attr.aria-pressed]="d().layout === 'list'"
            hlmTooltip="List"
            (click)="patch({ layout: 'list' })"
          >
            <svg [lucideIcon]="listIcon" [size]="14"></svg>
          </button>
          <button
            type="button"
            class="flex h-6 items-center gap-1 rounded-[5px] px-1.5 text-xs"
            [class]="d().layout === 'board' ? 'bg-background text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'"
            [attr.aria-pressed]="d().layout === 'board'"
            hlmTooltip="Board"
            (click)="patch({ layout: 'board' })"
          >
            <svg [lucideIcon]="boardIcon" [size]="14"></svg>
          </button>
        </div>

        <hlm-popover align="end" sideOffset="4">
          <button hlmBtn hlmPopoverTrigger variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs font-normal" aria-label="Display options">
            <svg [lucideIcon]="displayIcon" [size]="13"></svg>
            <span class="max-sm:hidden">Display</span>
          </button>
          <hlm-popover-content *hlmPopoverPortal="let ctx" class="w-72 p-0 text-[13px]">
            <div class="flex flex-col gap-2.5 p-3">
              <label class="flex items-center justify-between gap-3">
                <span class="text-muted-foreground">Grouping</span>
                <select class="border-input bg-background h-7 w-36 rounded-md border px-1.5 text-xs" [value]="d().groupBy" (change)="patch({ groupBy: $any($event.target).value })">
                  @for (g of groups; track g) {
                    <option [value]="g">{{ groupLabels[g] }}</option>
                  }
                </select>
              </label>
              <div class="flex items-center justify-between gap-3">
                <span class="text-muted-foreground">Ordering</span>
                <span class="flex items-center gap-1">
                  <select class="border-input bg-background h-7 w-[7.25rem] rounded-md border px-1.5 text-xs" [value]="d().sortField" (change)="patch({ sortField: $any($event.target).value })">
                    @for (s of sorts; track s) {
                      <option [value]="s">{{ sortLabels[s] }}</option>
                    }
                  </select>
                  <button hlmBtn variant="outline" size="icon-sm" class="size-7" [attr.aria-label]="d().sortDir === 'asc' ? 'Ascending' : 'Descending'" [hlmTooltip]="d().sortDir === 'asc' ? 'Ascending' : 'Descending'" (click)="patch({ sortDir: d().sortDir === 'asc' ? 'desc' : 'asc' })">
                    <svg [lucideIcon]="d().sortDir === 'asc' ? ascIcon : descIcon" [size]="13"></svg>
                  </button>
                </span>
              </div>
              <label class="flex cursor-pointer items-center justify-between gap-3">
                <span class="text-muted-foreground">Show empty groups</span>
                <input type="checkbox" class="accent-primary size-3.5" [checked]="d().showEmptyGroups" (change)="patch({ showEmptyGroups: $any($event.target).checked })" />
              </label>
              @if (d().layout === 'list') {
                <div class="flex items-center justify-between gap-3">
                  <span class="text-muted-foreground">Density</span>
                  <span class="bg-muted/60 flex rounded-md p-0.5">
                    @for (o of densities; track o) {
                      <button type="button" class="h-6 rounded-[5px] px-2 text-xs capitalize" [class]="d().density === o ? 'bg-background shadow-xs' : 'text-muted-foreground'" (click)="patch({ density: o })">{{ o }}</button>
                    }
                  </span>
                </div>
              }
            </div>
            <div class="border-t p-3">
              <p class="text-muted-foreground mb-2 text-xs">Display properties</p>
              <div class="flex flex-wrap gap-1.5">
                @for (p of props; track p) {
                  <button
                    type="button"
                    class="h-6 rounded-md border px-2 text-xs transition-colors"
                    [class]="isShown(p) ? 'border-border-strong bg-accent text-foreground' : 'border-border text-muted-foreground hover:text-foreground'"
                    [attr.aria-pressed]="isShown(p)"
                    (click)="toggleProp(p)"
                  >
                    {{ propLabels[p] }}
                  </button>
                }
              </div>
            </div>
            <div class="flex justify-end border-t px-3 py-2">
              <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 text-xs" (click)="resetDisplay()">Reset to default</button>
            </div>
          </hlm-popover-content>
        </hlm-popover>
      </div>
    </div>

    @if (scoped().length === 0) {
      <app-empty-state [icon]="inbox" [title]="emptyTitle()" [description]="emptyDescription()">
        @if (canEdit() && showCreate()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New issue <app-kbd keys="c" class="opacity-70" /></button>
        }
      </app-empty-state>
    } @else if (shown() === 0) {
      <app-empty-state [icon]="filterIcon" title="No issues match" description="Nothing in this view matches the filters. Remove a filter or change the search.">
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else {
      <app-kanban
        [columns]="columns()"
        [layout]="d().layout"
        [disabled]="!draggable()"
        [prefix]="dropPrefix()"
        [addable]="canEdit() && showCreate() && effectiveGroup() !== 'workstreamIds'"
        addLabel="New issue in this group"
        emptyText="No issues"
        (add)="createIn($event)"
        (moved)="move($event.item, $event.to)"
      >
        <ng-template kanbanItem let-i>
          <div
            [hlmContextMenuTrigger]="issueMenu"
            [hlmContextMenuTriggerData]="{ $implicit: i }"
            [disabled]="!canEdit()"
            (mouseenter)="ui.setFocusedRow(i.id)"
          >
            @if (d().layout === 'list') {
              <app-issue-row
                [issue]="i"
                [focused]="ui.focusedRowId() === i.id"
                [selected]="selectedSet().has(i.id)"
                [selectable]="canEdit()"
                [selecting]="selection().length > 0"
                [hidden]="d().hidden"
                [compact]="d().density === 'compact'"
                [dateField]="dateField()"
                (toggleSelect)="onSelect(i, $event)"
              />
            } @else {
              <app-issue-card
                class="mb-0"
                [issue]="i"
                [focused]="ui.focusedRowId() === i.id"
                [selected]="selectedSet().has(i.id)"
                [selectable]="canEdit()"
                [selecting]="selection().length > 0"
                [hidden]="d().hidden"
                [dateField]="dateField()"
                [showStatus]="effectiveGroup() !== 'status'"
                (toggleSelect)="onSelect(i, $event)"
              />
            }
          </div>
        </ng-template>
        <ng-template kanbanLabel let-key>
          @switch (effectiveGroup()) {
            @case ('status') {
              <app-status-icon entity="issue" [status]="$any(key)" />
            }
            @case ('kind') {
              <app-issue-kind [kind]="$any(key)" />
            }
            @case ('priority') {
              <app-priority-icon [priority]="$any(key)" />
            }
            @case ('teamId') {
              @if (key) {
                <app-actor-avatar [actor]="{ type: 'team', id: key }" [size]="16" />
              }
            }
            @case ('assigneeId') {
              @if (key) {
                <app-actor-avatar [actor]="{ type: 'user', id: key }" [size]="16" />
              } @else {
                <svg [lucideIcon]="noUser" [size]="16" [strokeWidth]="1.5" class="text-muted-foreground"></svg>
              }
            }
            @case ('projectId') {
              @if (store.getProject(key); as p) {
                <app-project-glyph [project]="p" [size]="14" />
              } @else {
                <svg [lucideIcon]="projectIcon" [size]="14" class="text-muted-foreground"></svg>
              }
            }
            @case ('workstreamIds') {
              @if (key) {
                <app-status-icon entity="workstream" [status]="$any(store.getWorkstream(key)?.status ?? 'draft')" />
                <span class="text-muted-foreground font-mono text-xs">{{ store.getWorkstream(key)?.key }}</span>
              } @else {
                <svg [lucideIcon]="hexIcon" [size]="14" class="text-muted-foreground"></svg>
              }
            }
          }
          <span class="truncate font-medium">{{ label(key) }}</span>
        </ng-template>
      </app-kanban>
    }

    <!-- Right-click menu (acts on the selection when the clicked issue is part of it) -->
    <ng-template #issueMenu let-i>
      @let ids = targetsFor(i);
      <hlm-dropdown-menu class="w-60">
        <hlm-dropdown-menu-label class="truncate">{{ ids.length > 1 ? ids.length + ' issues' : i.key + ' · ' + i.title }}</hlm-dropdown-menu-label>
        <hlm-dropdown-menu-group>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="statusSub">
            <app-status-icon entity="issue" [status]="i.status" /> Status
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="prioritySub">
            <app-priority-icon [priority]="i.priority" /> Priority
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="assigneeSub">
            <svg [lucideIcon]="noUser" [size]="14"></svg> Assignee
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="teamSub">
            <svg [lucideIcon]="teamIcon" [size]="14"></svg> Team
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
          <button hlmDropdownMenuItem [hlmDropdownMenuSubTrigger]="wsSub">
            <svg [lucideIcon]="hexIcon" [size]="14" class="text-entity-workstream"></svg> Add to workstream
            <hlm-dropdown-menu-item-sub-indicator />
          </button>
        </hlm-dropdown-menu-group>
        <hlm-dropdown-menu-separator />
        <hlm-dropdown-menu-group>
          @if (ids.length === 1) {
            <button hlmDropdownMenuItem (triggered)="actions.open(i)">
              <svg [lucideIcon]="openIcon" [size]="14"></svg> Open
              <hlm-dropdown-menu-shortcut><app-kbd keys="enter" /></hlm-dropdown-menu-shortcut>
            </button>
          }
          <button hlmDropdownMenuItem (triggered)="actions.copyKeys(ids)">
            <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy {{ ids.length > 1 ? 'keys' : 'key' }}
            <hlm-dropdown-menu-shortcut><app-kbd keys="mod+." /></hlm-dropdown-menu-shortcut>
          </button>
          <button hlmDropdownMenuItem (triggered)="actions.copyLinks(ids)">
            <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy {{ ids.length > 1 ? 'links' : 'link' }}
            <hlm-dropdown-menu-shortcut><app-kbd keys="mod+shift+l" /></hlm-dropdown-menu-shortcut>
          </button>
          @if (ids.length === 1) {
            <button hlmDropdownMenuItem (triggered)="actions.copyBranch(i.id)">
              <svg [lucideIcon]="branchIcon" [size]="14"></svg> Copy git branch name
              <hlm-dropdown-menu-shortcut><app-kbd keys="mod+shift+g" /></hlm-dropdown-menu-shortcut>
            </button>
            <button hlmDropdownMenuItem (triggered)="favorites.toggle('issue', i.id)">
              <svg [lucideIcon]="starIcon" [size]="14" [attr.fill]="favorites.has('issue', i.id) ? 'currentColor' : 'none'"></svg>
              {{ favorites.has('issue', i.id) ? 'Remove from favorites' : 'Add to favorites' }}
            </button>
            <button hlmDropdownMenuItem (triggered)="actions.openPrompt('duplicate', ids)" [disabled]="!!i.duplicateOfId">
              <svg [lucideIcon]="copyIcon" [size]="14"></svg> Mark as duplicate…
            </button>
            <button hlmDropdownMenuItem (triggered)="actions.createWorkstreamFrom(i)">
              <svg [lucideIcon]="plus" [size]="14"></svg> Create workstream from issue
            </button>
          }
        </hlm-dropdown-menu-group>
        @if (store.allowed('deleteIssues')) {
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem variant="destructive" (triggered)="actions.remove(ids)">
            <svg [lucideIcon]="trash" [size]="14"></svg> Delete{{ ids.length > 1 ? ' ' + ids.length + ' issues' : '' }}…
            <hlm-dropdown-menu-shortcut><app-kbd keys="mod+backspace" /></hlm-dropdown-menu-shortcut>
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
      <ng-template #teamSub>
        <hlm-dropdown-menu-sub class="max-h-80 w-52 overflow-y-auto">
          @for (o of teamOpts(); track o.value) {
            <button hlmDropdownMenuItem (triggered)="actions.setTeam(ids, o.value || null)">
              <app-issue-option-glyph [option]="o" /> <span class="truncate">{{ o.label }}</span>
              @if (allHave(ids, 'teamId', o.value)) {
                <svg [lucideIcon]="checkIcon" [size]="13" class="ml-auto shrink-0"></svg>
              }
            </button>
          }
        </hlm-dropdown-menu-sub>
      </ng-template>
      <ng-template #wsSub>
        <hlm-dropdown-menu-sub class="max-h-96 w-72 overflow-y-auto">
          <hlm-dropdown-menu-label>Contributes to the outcome of…</hlm-dropdown-menu-label>
          @for (o of wsMenuOpts(); track o.value) {
            <button hlmDropdownMenuItem (triggered)="actions.toggleWorkstream(ids, o.value)">
              <app-issue-option-glyph [option]="o" />
              <span class="text-muted-foreground shrink-0 font-mono text-[11px]">{{ o.hint }}</span>
              <span class="truncate">{{ o.label }}</span>
              @if (allLinked(ids, o.value)) {
                <svg [lucideIcon]="checkIcon" [size]="13" class="ml-auto shrink-0"></svg>
              }
            </button>
          }
          <hlm-dropdown-menu-separator />
          <button hlmDropdownMenuItem (triggered)="actions.openPrompt('workstream', ids)">
            <svg [lucideIcon]="searchIcon" [size]="14"></svg> Search workstreams…
            <hlm-dropdown-menu-shortcut><app-kbd keys="w" /></hlm-dropdown-menu-shortcut>
          </button>
        </hlm-dropdown-menu-sub>
      </ng-template>
    </ng-template>

    <app-peek-panel />

    <!-- Bulk action bar -->
    @if (selection().length) {
      <div class="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
        <div
          class="bg-popover text-popover-foreground ring-foreground/10 pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg p-1 text-[13px] shadow-lg ring-1"
          role="toolbar"
          aria-label="Bulk actions"
        >
          <span class="flex items-center gap-1 rounded-md border border-dashed px-2 py-0.5 text-xs whitespace-nowrap">
            <span class="tabular-nums">{{ selection().length }}</span> selected
            <button type="button" class="text-muted-foreground hover:text-foreground -mr-1 rounded p-0.5" aria-label="Clear selection" hlmTooltip="Clear selection · Esc" (click)="ui.clearSelected()">
              <svg [lucideIcon]="xIcon" [size]="12"></svg>
            </button>
          </span>
          @if (selection().length < shown()) {
            <button hlmBtn variant="ghost" size="sm" class="h-7 px-2 text-xs" hlmTooltip="Select all · ⌘A" (click)="selectAll()">Select all</button>
          }
          <span class="bg-border mx-1 h-4 w-px shrink-0"></span>
          <button hlmBtn variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" hlmTooltip="Change status · S" (click)="actions.openPrompt('status', selection())">
            <app-status-icon entity="issue" status="in_progress" /> Status
          </button>
          <button hlmBtn variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" hlmTooltip="Set priority · P" (click)="actions.openPrompt('priority', selection())">
            <app-priority-icon priority="high" /> Priority
          </button>
          <button hlmBtn variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" hlmTooltip="Assign · A" (click)="actions.openPrompt('assignee', selection())">
            <svg [lucideIcon]="noUser" [size]="14"></svg> Assignee
          </button>
          <button hlmBtn variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" hlmTooltip="Labels · L" (click)="actions.openPrompt('label', selection())">
            <svg [lucideIcon]="tagIcon" [size]="14"></svg> Labels
          </button>
          <button hlmBtn variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" hlmTooltip="Move to project · ⇧P" (click)="actions.openPrompt('project', selection())">
            <svg [lucideIcon]="projectIcon" [size]="14"></svg> Project
          </button>
          <button hlmBtn variant="ghost" size="sm" class="h-7 gap-1.5 px-2 text-xs" hlmTooltip="Add to workstream · W" (click)="actions.openPrompt('workstream', selection())">
            <svg [lucideIcon]="hexIcon" [size]="14" class="text-entity-workstream"></svg> Workstream
          </button>
          <button hlmBtn variant="ghost" size="icon-sm" class="size-7" aria-label="Copy keys" hlmTooltip="Copy keys · ⌘." (click)="actions.copyKeys(selection())">
            <svg [lucideIcon]="copyIcon" [size]="14"></svg>
          </button>
          <button hlmBtn variant="ghost" size="icon-sm" class="text-destructive hover:text-destructive size-7" aria-label="Delete selected" hlmTooltip="Delete · ⌘⌫" (click)="actions.remove(selection())">
            <svg [lucideIcon]="trash" [size]="14"></svg>
          </button>
        </div>
      </div>
    }
  `,
})
export class IssueBoard {
  protected readonly store = inject(NablaStore);
  private readonly listState = inject(ListStateStore);
  protected readonly ui = inject(UiStore);
  protected readonly actions = inject(IssueActions);
  protected readonly favorites = inject(FavoritesStore);
  private readonly document = inject(DOCUMENT);

  /** Issues this board shows. The issues page passes every issue; a workstream passes its own. */
  readonly issues = input.required<readonly Issue[]>();
  /** Restrict to these statuses (view tabs); null = all. */
  readonly scope = input<readonly IssueStatus[] | null>(null);
  /** Distinguishes drop-list ids when more than one board is on the page. */
  readonly dropPrefix = input('issue-col');
  /** Query `?status=` applied once when the board opens. */
  readonly status = input<string>();
  /** Query `?team=`. */
  readonly team = input<string>();
  /** Query `?project=<projectId>` (links from a project). */
  readonly project = input<string>();
  readonly emptyTitle = input('No issues yet');
  readonly emptyDescription = input(
    'Issues are demand: the bugs, requests and incidents people report. When you decide to act, add them to a workstream: the outcome that resolves them.',
  );
  readonly showCreate = input(true);
  /** localStorage key for display options. */
  readonly storageKey = input('nabla.issues.display.v1');

  // display options (persisted)
  protected readonly d = signal<IssueDisplay>(readDisplay('nabla.issues.display.v1'));
  // Filters survive navigation inside the app (see ListStateStore); display options persist in localStorage.
  protected readonly filters = this.listState.remember<ViewFilter[]>('issues.filters', []);
  protected readonly search = this.listState.remember('issues.search', '');
  private anchor: string | null = null;

  protected readonly statuses = issueStatusOptions();
  protected readonly kinds = issueKindOptions();
  protected readonly priorities = priorityOptions();
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly assigneeFilter = computed<PickOption[]>(() => [{ value: '', label: 'Unassigned' }, ...userOptions(this.store)]);
  protected readonly wsFilter = computed<PickOption[]>(() => [{ value: '', label: 'No workstream' }, ...workstreamPickOptions(this.store)]);
  protected readonly projectFilter = computed(() => projectFilterOptions(this.store));
  protected readonly milestoneFilter = computed(() => milestoneFilterOptions(this.store));
  /** An issue counts under its own project and the projects of its workstreams. */
  private readonly queryCtx = computed(() => ({ workstreamById: this.store.workstreamById(), demand: this.store.demand() }));
  protected readonly groups = GROUPS;
  protected readonly sorts = SORTS;
  protected readonly props = PROPS;
  protected readonly groupLabels = GROUP_LABEL;
  protected readonly sortLabels = SORT_LABEL;
  protected readonly propLabels = PROP_LABEL;
  protected readonly densities = ['comfortable', 'compact'] as const;

  // context-menu option lists
  protected readonly statusOpts = promptOptions(this.store, 'status', []);
  protected readonly priorityOpts = promptOptions(this.store, 'priority', []);
  protected readonly assigneeOpts = computed(() => promptOptions(this.store, 'assignee', []));
  protected readonly teamOpts = computed(() => promptOptions(this.store, 'team', []));
  protected readonly wsMenuOpts = computed(() => promptOptions(this.store, 'workstream', []).slice(0, 10));

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly ascIcon = LucideArrowUpNarrowWide;
  protected readonly descIcon = LucideArrowDownWideNarrow;
  protected readonly inbox = LucideInbox;
  protected readonly filterIcon = LucideListFilter;
  protected readonly listIcon = LucideList;
  protected readonly boardIcon = LucideColumns3;
  protected readonly displayIcon = LucideSlidersHorizontal;
  protected readonly noUser = LucideCircleUserRound;
  protected readonly hexIcon = LucideHexagon;
  protected readonly projectIcon = LucideBox;
  protected readonly teamIcon = LucideUsers;
  protected readonly copyIcon = LucideCopy;
  protected readonly branchIcon = LucideGitBranch;
  protected readonly starIcon = LucideStar;
  protected readonly linkIcon = LucideLink;
  protected readonly openIcon = LucideExternalLink;
  protected readonly trash = LucideTrash2;
  protected readonly tagIcon = LucideTag;
  protected readonly checkIcon = LucideCheck;

  protected readonly canEdit = computed(() => this.store.can('member'));
  /** Filters beyond the ones the URL pins (`?team=`). */
  protected readonly hasFilters = computed(
    () => this.filters().some((f) => !(f.field === 'teamId' && this.team())) || this.search().trim().length > 0,
  );
  protected readonly effectiveGroup = computed<IssueGroup>(() => {
    const g = this.d().groupBy;
    return this.d().layout === 'board' && g === 'none' ? 'status' : g;
  });
  protected readonly draggable = computed(() => this.canEdit() && DRAGGABLE.has(this.effectiveGroup()));
  protected readonly dateField = computed(() => (this.d().sortField === 'createdAt' ? 'createdAt' : 'updatedAt'));

  /** Issues inside the current view tab. */
  protected readonly scoped = computed(() => {
    const s = this.scope();
    if (!s) return this.issues();
    const set = new Set<string>(s);
    return this.issues().filter((i) => set.has(i.status));
  });

  protected readonly columns = computed<Column[]>(() => {
    const group = this.effectiveGroup();
    const d = this.d();
    let include: string[] | undefined;
    if (d.showEmptyGroups || (d.layout === 'board' && group === 'status')) {
      include = groupUniverse(this.store, group);
      // keep empty status columns inside the view tab / status filter
      if (include && group === 'status') {
        const scope = this.scope();
        const picked = filterValues(this.filters(), 'status');
        include = include.filter((s) => (!scope || scope.includes(s as IssueStatus)) && (!picked.length || picked.includes(s)));
      }
    }
    return queryGroups(
      'issue',
      this.scoped() as Issue[],
      {
        filters: this.filters(),
        search: this.search(),
        sort: { field: d.sortField, direction: d.sortDir },
        groupBy: group === 'none' ? null : group,
      },
      this.queryCtx(),
      include,
    );
  });

  /** Visible issue ids in display order (unique; an issue can sit in several workstream groups). */
  private readonly ordered = computed(() => [...new Set(this.columns().flatMap((c) => c.items.map((i) => i.id)))]);
  protected readonly shown = computed(() => this.ordered().length);
  private readonly visibleSet = computed(() => new Set(this.ordered()));
  /** Selected issues that are visible on this board. */
  protected readonly selection = computed(() => this.ui.selectedRowIds().filter((id) => this.visibleSet().has(id)));
  protected readonly selectedSet = computed(() => new Set(this.selection()));
  /** What keyboard actions apply to: the selection, else the focused row. */
  private readonly targets = computed<string[]>(() => {
    const sel = this.selection();
    if (sel.length) return sel;
    const f = this.ui.focusedRowId();
    return f && this.visibleSet().has(f) ? [f] : [];
  });

  private readonly _keys = usePageShortcuts([
    { keys: 's', label: 'Change status', group: 'Issues', when: () => this.canAct(), run: () => this.actions.openPrompt('status', this.targets()) },
    { keys: 'p', label: 'Set priority', group: 'Issues', when: () => this.canAct(), run: () => this.actions.openPrompt('priority', this.targets()) },
    { keys: 'a', label: 'Assign to…', group: 'Issues', when: () => this.canAct(), run: () => this.actions.openPrompt('assignee', this.targets()) },
    { keys: 'i', label: 'Assign to me', group: 'Issues', when: () => this.canAct(), run: () => this.actions.toggleAssignMe(this.targets()) },
    { keys: 'l', label: 'Toggle labels…', group: 'Issues', when: () => this.canAct(), run: () => this.actions.openPrompt('label', this.targets()) },
    { keys: 'shift+p', label: 'Move to project…', group: 'Issues', when: () => this.canAct(), run: () => this.actions.openPrompt('project', this.targets()) },
    { keys: 'w', label: 'Add to workstream', group: 'Issues', when: () => this.canAct(), run: () => this.actions.openPrompt('workstream', this.targets()) },
    { keys: 'mod+.', label: 'Copy issue key', group: 'Issues', when: () => this.targets().length > 0 && !this.typing(), run: () => this.actions.copyKeys(this.targets()) },
    { keys: 'mod+shift+l', label: 'Copy issue link', group: 'Issues', when: () => this.targets().length > 0 && !this.typing(), run: () => this.actions.copyLinks(this.targets()) },
    { keys: 'mod+shift+g', label: 'Copy git branch name', group: 'Issues', when: () => this.targets().length === 1 && !this.typing(), run: () => this.actions.copyBranch(this.targets()[0]) },
    { keys: 'mod+shift+.', label: 'Copy git branch name', group: 'Issues', hidden: true, when: () => this.targets().length === 1 && !this.typing(), run: () => this.actions.copyBranch(this.targets()[0]) },
    { keys: 'mod+shift+>', label: 'Copy git branch name', group: 'Issues', hidden: true, when: () => this.targets().length === 1 && !this.typing(), run: () => this.actions.copyBranch(this.targets()[0]) },
    { keys: 'mod+backspace', label: 'Delete issue', group: 'Issues', when: () => this.canAct() && !this.typing(), run: () => this.actions.remove(this.targets()) },
    { keys: 'mod+a', label: 'Select all issues', group: 'Issues', when: () => this.canEdit() && this.shown() > 0 && !this.typing(), run: () => this.selectAll() },
    { keys: 'f', label: 'Filter issues', group: 'Issues', run: () => this.focusSearch() },
  ]);

  constructor() {
    // Display options follow the storage key (one set per board context) and persist on change.
    let loadedKey = '';
    effect(() => {
      const key = this.storageKey();
      const d = this.d();
      if (key !== loadedKey) {
        loadedKey = key;
        this.d.set(readDisplay(key));
        return;
      }
      writeDisplay(key, d);
    });
    // `?status=` / `?team=` from links (sidebar team links, attention, saved links).
    // On open, a link's params override the remembered filters; with no params the remembered ones stay.
    let opening = true;
    effect(() => {
      const status = this.status();
      const team = this.team();
      const project = this.project();
      const initial = opening;
      opening = false;
      this.filters.update((f) => {
        let next = team || !initial ? setFilter(f, 'teamId', 'in', team ? [team] : []) : f;
        if (project) next = setFilter(next, 'projectId', 'in', [project]);
        if (status && (ISSUE_STATUSES as readonly string[]).includes(status)) next = setFilter(next, 'status', 'in', [status]);
        return next;
      });
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
    this.d.update((d) => ({ ...d, ...p }));
  }

  protected resetDisplay(): void {
    this.d.set({ ...DEFAULT_DISPLAY, hidden: [] });
  }

  protected isShown(p: IssueProp): boolean {
    return !this.d().hidden.includes(p);
  }

  protected toggleProp(p: IssueProp): void {
    this.patch({ hidden: this.isShown(p) ? [...this.d().hidden, p] : this.d().hidden.filter((x) => x !== p) });
  }

  protected label(key: string): string {
    return groupLabel(this.store, this.effectiveGroup(), key);
  }

  // ───────────────────────── filters ─────────────────────────

  protected fv(field: string): string[] {
    return filterValues(this.filters(), field);
  }

  protected setF(field: string, values: string[]): void {
    this.filters.update((f) => setFilter(f, field, 'in', values));
  }

  protected clearFilters(): void {
    const team = this.team();
    this.filters.set(team ? setFilter([], 'teamId', 'in', [team]) : []);
    this.search.set('');
  }

  private focusSearch(): void {
    this.document.querySelector<HTMLInputElement>('input[aria-label="Filter issues"]')?.focus();
  }

  // ───────────────────────── create / move ─────────────────────────

  protected create(): void {
    this.ui.openCreate('issue', this.team() ? { teamId: this.team() } : {});
  }

  /** "+" in a group header: prefill what the group means. */
  protected createIn(key: string): void {
    const defaults: Record<string, unknown> = {};
    if (this.team()) defaults['teamId'] = this.team();
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
      case 'teamId':
        if (key) defaults['teamId'] = key;
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
        if (issue.status !== value) void this.store.updateIssue(issue.id, { status: value as IssueStatus });
        break;
      case 'priority':
        if (issue.priority !== value) void this.store.updateIssue(issue.id, { priority: value as Priority });
        break;
      case 'teamId':
        if ((issue.teamId ?? '') !== value) void this.store.updateIssue(issue.id, { teamId: value || null });
        break;
      case 'assigneeId':
        if ((issue.assigneeId ?? '') !== value) void this.store.updateIssue(issue.id, { assigneeId: value || null });
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

  protected allHave(ids: readonly string[], field: 'status' | 'priority' | 'assigneeId' | 'teamId', value: string): boolean {
    const list = this.actions.issues(ids);
    return list.length > 0 && list.every((i) => (i[field] ?? '') === value);
  }

  protected allLinked(ids: readonly string[], wsId: string): boolean {
    const list = this.actions.issues(ids);
    return list.length > 0 && list.every((i) => i.workstreamIds.includes(wsId));
  }

  private canAct(): boolean {
    return this.canEdit() && this.targets().length > 0;
  }

  private typing(): boolean {
    return isTypingTarget(this.document.activeElement);
  }
}
