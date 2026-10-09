import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideArrowDownWideNarrow,
  LucideArrowUpNarrowWide,
  LucideChartGantt,
  LucideCheck,
  LucideCopy,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideKanban,
  LucideLayers,
  LucideLink2,
  LucideList,
  LucideListFilter,
  LucidePlus,
  LucideRows3,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  Clipboard,
  FIELD_DEFS,
  TramaStore,
  Notifier,
  UiStore,
  filterValues,
  groupItems,
  queryItems,
  setFilter,
  type Decision,
  type Issue,
  type Priority,
  type Project,
  type Queryable,
  type SavedView,
  type ViewFilter,
  type ViewLayout,
  type Workstream,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { KeyChip } from '../../shared/key-chip';
import { PageHeader } from '../../shared/page-header';
import { RelativeTimePipe } from '../../shared/pipes';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { IssueCard, IssueRow } from '../issues/issue-items';
import { TimelineView } from '../timeline/timeline-view';
import { InlineText } from '../workstreams/inline-edit';
import { buildSummary, type WsSummary } from '../workstreams/ws-model';
import { WorkstreamCard, WorkstreamRow } from '../workstreams/workstream-items';
import { OptionMenu } from './option-controls';
import { canEditSavedView, canManageViewSharing } from './view-access';
import { ViewShare } from './view-share';
import { ViewProjectCard, ViewProjectRow } from './view-project-items';
import {
  ENTITY_ICON,
  ENTITY_LABEL,
  STATUS_ENTITY,
  describeFilter,
  fieldLabel,
  fieldOptions,
  filterableFields,
  isEditableFilter,
  isNumberField,
  valueColor,
  valueGlyph,
  valueLabel,
  type ViewGroup,
} from './view-model';

/** Layouts the toggle offers; the timeline only for entities that have dates. */
type PageLayout = 'list' | 'board' | 'timeline';

/**
 * A saved view: renders its entity with the right rows (issues = circles, workstreams = hexagons,
 * projects = glyphs), honours `layout` (list / board / timeline) and `groupBy`, and lets the owner edit name, filters, sort,
 * grouping, layout and visibility in place. Every change is saved immediately.
 */
@Component({
  selector: 'app-view-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmToggleGroupImports,
    HlmTooltip,
    LucideDynamicIcon,
    PageHeader,
    EmptyState,
    KeyChip,
    StatusIcon,
    PriorityIcon,
    ActorAvatar,
    RelativeTimePipe,
    InlineText,
    OptionMenu,
    ViewShare,
    WorkstreamRow,
    WorkstreamCard,
    IssueRow,
    IssueCard,
    ViewProjectRow,
    ViewProjectCard,
    TimelineView,
    TopBarActions,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    @if (view(); as v) {
      <ng-template appTopBarActions>
        @if (!canEdit()) {
          <button hlmBtn variant="outline" size="sm" (click)="duplicate()" hlmTooltip="Save a copy you can change" position="bottom">
            <svg [lucideIcon]="copyIcon" [size]="14"></svg>
            <span class="max-sm:hidden">Duplicate to edit</span>
          </button>
        }
        <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="more" aria-label="View actions">
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        <ng-template #more>
          <hlm-dropdown-menu class="w-52">
            <button hlmDropdownMenuItem (triggered)="duplicate()">
              <svg [lucideIcon]="copyIcon" [size]="14"></svg> Duplicate view
            </button>
            <button hlmDropdownMenuItem (triggered)="copyLink()">
              <svg [lucideIcon]="linkIcon" [size]="14"></svg> Copy link
            </button>
            @if (canManage()) {
              <hlm-dropdown-menu-separator />
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete view
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <app-page-header [title]="v.name" [description]="description()">
        <svg leading [lucideIcon]="entityIcon()" [size]="15" class="text-muted-foreground shrink-0"></svg>
        <span meta class="flex min-w-0 items-center gap-2">
          <app-inline-text
            class="-mx-1.5 w-56 max-w-full"
            label="view name"
            textClass="text-sm font-medium"
            [value]="v.name"
            [canEdit]="canEdit()"
            (save)="rename($event)"
          />
          <span class="text-meta shrink-0">{{ entityLabel() }}</span>
        </span>
        <span actions class="flex items-center gap-1.5">
          <app-view-share [view]="v" />
          <hlm-toggle-group
            type="single"
            variant="outline"
            size="sm"
            [value]="layout()"
            (valueChange)="setLayout($event)"
            [disabled]="!canEdit()"
            aria-label="Layout"
          >
            <button hlmToggleGroupItem value="list" aria-label="List" class="h-7 px-2" hlmTooltip="List" position="bottom">
              <svg [lucideIcon]="listIcon" [size]="14"></svg>
            </button>
            <button hlmToggleGroupItem value="board" aria-label="Board" class="h-7 px-2" hlmTooltip="Board" position="bottom">
              <svg [lucideIcon]="boardIcon" [size]="14"></svg>
            </button>
            @if (supportsTimeline()) {
              <button hlmToggleGroupItem value="timeline" aria-label="Timeline" class="h-7 px-2" hlmTooltip="Timeline" position="bottom">
                <svg [lucideIcon]="timelineIcon" [size]="14"></svg>
              </button>
            }
          </hlm-toggle-group>
        </span>

        <!-- filter / sort / group row -->
        <div class="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 sm:px-6">
          @for (f of activeFilters(); track f.field) {
            @if (f.numeric) {
              <span class="border-border-strong bg-secondary/60 divide-border-strong inline-flex h-7 items-stretch divide-x overflow-hidden rounded-md border text-xs">
                <span class="text-muted-foreground flex items-center px-2">{{ f.label }}</span>
                <span class="text-muted-foreground flex items-center px-2">at least</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  class="bg-transparent w-20 px-2 text-xs tabular-nums outline-none"
                  [attr.aria-label]="f.label + ' minimum'"
                  [value]="f.min"
                  [disabled]="!canEdit()"
                  (change)="setMin(f.field, $any($event.target).value)"
                />
                @if (canEdit()) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex w-7 items-center justify-center"
                    [attr.aria-label]="'Remove ' + f.label + ' filter'"
                    (click)="removeFilter(f.field)"
                  >
                    <svg [lucideIcon]="xIcon" [size]="12"></svg>
                  </button>
                }
              </span>
            } @else if (f.editable) {
              <!-- Linear-style chip: field · operator · value · × -->
              <span class="border-border-strong bg-secondary/60 divide-border-strong inline-flex h-7 items-stretch divide-x overflow-hidden rounded-md border text-xs">
                <span class="text-muted-foreground flex items-center px-2">{{ f.label }}</span>
                <span class="text-muted-foreground flex items-center px-2">{{ f.values.length > 1 ? 'is any of' : 'is' }}</span>
                <app-option-menu
                  variant="segment"
                  [label]="f.label"
                  [options]="f.options"
                  [selected]="f.values"
                  (selectedChange)="setValues(f.field, $event)"
                  [multi]="true"
                  [class.pointer-events-none]="!canEdit()"
                />
                @if (canEdit()) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex w-7 items-center justify-center"
                    [attr.aria-label]="'Remove ' + f.label + ' filter'"
                    (click)="removeFilter(f.field)"
                  >
                    <svg [lucideIcon]="xIcon" [size]="12"></svg>
                  </button>
                }
              </span>
            } @else {
              <span class="border-border-strong bg-secondary/60 inline-flex h-7 items-center gap-1 rounded-md border ps-2 pe-1 text-xs">
                {{ f.text }}
                @if (canEdit()) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-5 items-center justify-center rounded"
                    [attr.aria-label]="'Remove ' + f.label + ' filter'"
                    (click)="removeFilter(f.field)"
                  >
                    <svg [lucideIcon]="xIcon" [size]="11"></svg>
                  </button>
                }
              </span>
            }
          }
          @if (canEdit() && addableFields().length) {
            <button
              hlmBtn
              variant="ghost"
              size="sm"
              class="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
              [hlmDropdownMenuTrigger]="addFilter"
            >
              <svg [lucideIcon]="activeFilters().length ? plusIcon : filterIcon" [size]="13"></svg>
              {{ activeFilters().length ? 'Filter' : 'Add filter' }}
            </button>
            <ng-template #addFilter>
              <hlm-dropdown-menu class="w-56">
                <hlm-dropdown-menu-label>Filter by</hlm-dropdown-menu-label>
                @for (fd of addableFields(); track fd.field) {
                  <button hlmDropdownMenuItem (triggered)="addPending(fd.field)">{{ fd.label }}</button>
                }
              </hlm-dropdown-menu>
            </ng-template>
          }
          @if (!activeFilters().length && !canEdit()) {
            <span class="text-meta">No filters</span>
          }

          <span class="flex-1"></span>

          <button
            hlmBtn
            variant="ghost"
            size="sm"
            class="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
            [disabled]="!canEdit()"
            [hlmDropdownMenuTrigger]="groupMenu"
          >
            <svg [lucideIcon]="groupIcon" [size]="13"></svg>
            <span class="max-sm:hidden">{{ layout() === 'board' ? 'Columns' : 'Group' }}:</span>
            <span class="text-foreground">{{ groupLabel() }}</span>
          </button>
          <ng-template #groupMenu>
            <hlm-dropdown-menu class="w-52">
              <hlm-dropdown-menu-label>{{ layout() === 'board' ? 'Columns by' : 'Group by' }}</hlm-dropdown-menu-label>
              @if (layout() !== 'board') {
                <button hlmDropdownMenuRadio [checked]="!v.groupBy" [keepOpen]="false" (triggered)="setGroup(null)">
                  No grouping
                  <hlm-dropdown-menu-radio-indicator />
                </button>
              }
              @for (fd of groupableFields(); track fd.field) {
                <button hlmDropdownMenuRadio [checked]="effectiveGroup() === fd.field" [keepOpen]="false" (triggered)="setGroup(fd.field)">
                  {{ fd.label }}
                  <hlm-dropdown-menu-radio-indicator />
                </button>
              }
            </hlm-dropdown-menu>
          </ng-template>

          <button
            hlmBtn
            variant="ghost"
            size="sm"
            class="text-muted-foreground h-7 gap-1.5 px-2 text-xs"
            [disabled]="!canEdit()"
            [hlmDropdownMenuTrigger]="sortMenu"
          >
            <svg [lucideIcon]="v.sort?.direction === 'asc' ? sortAscIcon : sortDescIcon" [size]="13"></svg>
            <span class="max-sm:hidden">Sort:</span>
            <span class="text-foreground">{{ sortLabel() }}</span>
          </button>
          <ng-template #sortMenu>
            <hlm-dropdown-menu class="w-52">
              <hlm-dropdown-menu-label>Order by</hlm-dropdown-menu-label>
              <button hlmDropdownMenuRadio [checked]="!v.sort" [keepOpen]="false" (triggered)="setSort(null)">
                Default
                <hlm-dropdown-menu-radio-indicator />
              </button>
              @for (fd of sortableFields(); track fd.field) {
                <button hlmDropdownMenuRadio [checked]="v.sort?.field === fd.field" [keepOpen]="false" (triggered)="setSort(fd.field)">
                  {{ fd.label }}
                  <hlm-dropdown-menu-radio-indicator />
                </button>
              }
              @if (v.sort) {
                <hlm-dropdown-menu-separator />
                <button hlmDropdownMenuItem (triggered)="flipDirection()">
                  <svg [lucideIcon]="v.sort.direction === 'asc' ? sortDescIcon : sortAscIcon" [size]="14"></svg>
                  {{ v.sort.direction === 'asc' ? 'Descending' : 'Ascending' }}
                </button>
              }
            </hlm-dropdown-menu>
          </ng-template>
        </div>
      </app-page-header>

      @if (rows().length === 0) {
        <app-empty-state
          [icon]="layers"
          title="Nothing in this view"
          [description]="v.filters.length ? 'The filters do not match anything right now.' : 'There are no ' + entityLabel().toLowerCase() + ' yet.'"
        >
          @if (canEdit() && v.filters.length) {
            <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
          }
        </app-empty-state>
      } @else if (layout() === 'board') {
        <div class="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 py-3 sm:px-6">
          @for (g of groups(); track g.key) {
            <section class="flex w-72 shrink-0 flex-col" [attr.aria-label]="g.label">
              <header class="flex h-8 shrink-0 items-center gap-2 px-1">
                <ng-container *ngTemplateOutlet="glyph; context: { $implicit: g }" />
                <span class="truncate text-xs font-medium">{{ g.label }}</span>
                <span class="text-muted-foreground text-xs tabular-nums">{{ g.items.length }}</span>
              </header>
              <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4">
                @for (item of g.items; track item.id) {
                  @switch (v.entity) {
                    @case ('workstream') {
                      <app-workstream-card [summary]="summary(item)" [focused]="ui.focusedRowId() === item.id" />
                    }
                    @case ('issue') {
                      <app-issue-card [issue]="asIssue(item)" [focused]="ui.focusedRowId() === item.id" />
                    }
                    @case ('project') {
                      <app-view-project-card [project]="asProject(item)" [focused]="ui.focusedRowId() === item.id" />
                    }
                    @default {
                      @let d = asDecision(item);
                      <a
                        [routerLink]="['/', slug(), 'decisions', d.key]"
                        [attr.data-row-id]="d.id"
                        class="bg-card hover:border-foreground/25 block rounded-lg border p-2.5 transition-colors"
                        [class.border-primary]="ui.focusedRowId() === d.id"
                      >
                        <span class="flex items-center gap-1.5">
                          <app-status-icon [status]="d.status" entity="other" />
                          <app-key-chip [value]="d.key" />
                        </span>
                        <span class="mt-1.5 line-clamp-2 text-sm leading-snug font-medium">{{ d.title }}</span>
                      </a>
                    }
                  }
                } @empty {
                  <p class="text-meta px-1 py-2">Empty</p>
                }
              </div>
            </section>
          }
        </div>
      } @else if (layout() === 'timeline') {
        <app-timeline-view [entity]="v.entity === 'project' ? 'project' : 'workstream'" [groups]="groups()" [grouped]="grouped()" />
      } @else {
        <div class="min-h-0 flex-1 overflow-y-auto">
          @for (g of groups(); track g.key) {
            @if (grouped()) {
              <div class="bg-muted/40 sticky top-0 z-10 flex h-8 items-center gap-2 border-b px-4 backdrop-blur sm:px-6">
                <ng-container *ngTemplateOutlet="glyph; context: { $implicit: g }" />
                <span class="text-xs font-medium">{{ g.label }}</span>
                <span class="text-muted-foreground text-xs tabular-nums">{{ g.items.length }}</span>
              </div>
            }
            @for (item of g.items; track item.id) {
              @switch (v.entity) {
                @case ('workstream') {
                  <app-workstream-row [summary]="summary(item)" [focused]="ui.focusedRowId() === item.id" />
                }
                @case ('issue') {
                  <app-issue-row [issue]="asIssue(item)" [focused]="ui.focusedRowId() === item.id" />
                }
                @case ('project') {
                  <app-view-project-row [project]="asProject(item)" [focused]="ui.focusedRowId() === item.id" />
                }
                @default {
                  @let d = asDecision(item);
                  <a
                    [routerLink]="['/', slug(), 'decisions', d.key]"
                    [attr.data-row-id]="d.id"
                    class="hover:bg-hover flex min-h-9 items-center gap-3 border-b px-4 py-1.5 sm:px-6"
                    [class.bg-selected]="ui.focusedRowId() === d.id"
                  >
                    <app-status-icon [status]="d.status" entity="other" />
                    <app-key-chip [value]="d.key" class="w-14" />
                    <span class="min-w-0 flex-1 truncate text-sm">{{ d.title }}</span>
                    @for (t of d.tags.slice(0, 2); track t) {
                      <span class="border-border-strong text-muted-foreground hidden h-5 items-center rounded-full border px-1.5 text-[11px] md:inline-flex">{{ t }}</span>
                    }
                    <span class="text-meta w-24 text-end whitespace-nowrap tabular-nums max-sm:hidden">{{ d.updatedAt | relativeTime }}</span>
                  </a>
                }
              }
            }
          }
        </div>
      }

      <ng-template #glyph let-g>
        @if (g.status) {
          <app-status-icon [status]="g.status" [entity]="statusEntity()" [size]="13" />
        } @else if (g.priority) {
          <app-priority-icon [priority]="g.priority" />
        } @else if (g.actor) {
          <app-actor-avatar [actor]="g.actor" [size]="16" />
        } @else if (g.color) {
          <span class="size-2 shrink-0 rounded-full" [style.background]="g.color"></span>
        }
      </ng-template>
    } @else {
      <app-empty-state [icon]="layers" title="View not found" description="It may have been deleted, or it is private to someone else.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'views']">Back to views</a>
      </app-empty-state>
    }
  `,
})
export class ViewDetailPage {
  readonly workspaceSlug = input<string>();
  readonly id = input<string>();

  private readonly store = inject(TramaStore);
  protected readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);
  private readonly clipboard = inject(Clipboard);

  protected readonly trash = LucideTrash2;
  protected readonly layers = LucideLayers;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly copyIcon = LucideCopy;
  protected readonly linkIcon = LucideLink2;
  protected readonly listIcon = LucideList;
  protected readonly boardIcon = LucideKanban;
  protected readonly timelineIcon = LucideChartGantt;
  protected readonly xIcon = LucideX;
  protected readonly plusIcon = LucidePlus;
  protected readonly filterIcon = LucideListFilter;
  protected readonly groupIcon = LucideRows3;
  protected readonly sortAscIcon = LucideArrowUpNarrowWide;
  protected readonly sortDescIcon = LucideArrowDownWideNarrow;
  protected readonly checkIcon = LucideCheck;

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly view = computed(() => this.store.getView(this.id()));
  protected readonly canEdit = computed(() => {
    const v = this.view();
    return !!v && canEditSavedView(v, this.store.me()?.id, this.store.myRole());
  });
  /** Delete the view / change who has access. */
  protected readonly canManage = computed(() => {
    const v = this.view();
    return !!v && canManageViewSharing(v, this.store.me()?.id, this.store.myRole());
  });

  protected readonly entityIcon = computed(() => ENTITY_ICON[this.view()?.entity ?? 'workstream']);
  protected readonly entityLabel = computed(() => ENTITY_LABEL[this.view()?.entity ?? 'workstream']);
  protected readonly statusEntity = computed(() => STATUS_ENTITY[this.view()?.entity ?? 'workstream']);
  /** Workstreams and projects have dates, so they can be drawn as a timeline. */
  protected readonly supportsTimeline = computed(() => {
    const e = this.view()?.entity;
    return e === 'workstream' || e === 'project';
  });
  protected readonly layout = computed<PageLayout>(() => {
    const l = this.view()?.layout;
    if (l === 'board') return 'board';
    return l === 'timeline' && this.supportsTimeline() ? 'timeline' : 'list';
  });

  /** Fields a user added via "+ Filter" that have no values yet (not persisted). */
  private readonly pending = signal<string[]>([]);

  // ── query ──
  /** An issue's project filter / grouping also counts the projects of its workstreams. */
  private readonly queryCtx = computed(() => ({ workstreamById: this.store.workstreamById(), demand: this.store.demand() }));
  protected readonly rows = computed<Queryable[]>(() => {
    const v = this.view();
    if (!v) return [];
    // A timeline reads left to right: without an explicit order, earliest start first.
    const sort = v.sort ?? (this.layout() === 'timeline' ? { field: 'startDate', direction: 'asc' as const } : undefined);
    const spec = { filters: v.filters, sort };
    const ctx = this.queryCtx();
    if (v.entity === 'workstream') return queryItems('workstream', this.store.workstreams(), spec, ctx);
    if (v.entity === 'issue') return queryItems('issue', this.store.issues(), spec, ctx);
    if (v.entity === 'project') return queryItems('project', this.store.projects(), spec, ctx);
    return queryItems('decision', this.store.decisions(), spec, ctx);
  });

  /** Board always groups (default status); list groups only when `groupBy` is set. */
  protected readonly effectiveGroup = computed(() => {
    const v = this.view();
    if (!v) return null;
    return v.groupBy ?? (this.layout() === 'board' ? 'status' : null);
  });
  protected readonly grouped = computed(() => !!this.effectiveGroup());

  protected readonly groups = computed<ViewGroup[]>(() => {
    const v = this.view();
    if (!v) return [];
    const field = this.effectiveGroup();
    if (!field) return [{ key: '__all', label: '', items: this.rows() }];
    const def = FIELD_DEFS[v.entity].find((f) => f.field === field);
    const include = this.layout() === 'board' && def?.kind === 'enum' ? def.values : undefined;
    const raw = groupItems(v.entity, this.rows() as never[], field, this.queryCtx(), include) as { key: string; items: Queryable[] }[];
    return raw.map((g) => {
      const glyph = valueGlyph(v.entity, field, g.key, this.store);
      return {
        key: g.key || '__none',
        label: valueLabel(this.store, v.entity, field, g.key),
        status: glyph.status,
        priority: field === 'priority' && g.key ? (g.key as Priority) : undefined,
        actor: glyph.actor?.id ? { type: glyph.actor.type as 'team' | 'user', id: glyph.actor.id } : undefined,
        color: valueColor(v.entity, field, g.key),
        items: g.items,
      };
    });
  });

  private readonly summaries = computed(() => {
    const map = new Map<string, WsSummary>();
    if (this.view()?.entity !== 'workstream') return map;
    for (const w of this.rows() as Workstream[]) map.set(w.id, buildSummary(this.store, w));
    return map;
  });

  // ── toolbar state ──
  protected readonly activeFilters = computed(() => {
    const v = this.view();
    if (!v) return [];
    const fromView = v.filters.map((f) => this.chip(v, f.field, f));
    const pending = this.pending()
      .filter((field) => !v.filters.some((f) => f.field === field))
      .map((field) => this.chip(v, field, undefined));
    return [...fromView, ...pending];
  });
  protected readonly addableFields = computed(() => {
    const v = this.view();
    if (!v) return [];
    const used = new Set(this.activeFilters().map((f) => f.field));
    return filterableFields(v.entity).filter((f) => !used.has(f.field));
  });
  protected readonly groupableFields = computed(() => FIELD_DEFS[this.view()?.entity ?? 'workstream'].filter((f) => f.groupable));
  protected readonly sortableFields = computed(() => FIELD_DEFS[this.view()?.entity ?? 'workstream'].filter((f) => f.sortable));
  protected readonly groupLabel = computed(() => {
    const v = this.view();
    const g = this.effectiveGroup();
    return v && g ? fieldLabel(v.entity, g) : 'None';
  });
  protected readonly sortLabel = computed(() => {
    const v = this.view();
    return v?.sort ? fieldLabel(v.entity, v.sort.field) : 'Default';
  });

  protected readonly description = computed(() => {
    const v = this.view();
    if (!v) return '';
    const n = this.rows().length;
    const access = { private: 'Private', workspace: 'Shared', link: 'Public' }[v.sharing.visibility];
    return `${access} view · ${n} ${ENTITY_LABEL[v.entity].toLowerCase()}`;
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Views', link: ['/', this.slug(), 'views'] },
    { label: this.view()?.name ?? 'View' },
  ]);

  constructor() {
    // Forget half-added filter chips when switching views.
    effect(() => {
      this.id();
      this.pending.set([]);
    });
  }

  private chip(v: SavedView, field: string, f: ViewFilter | undefined) {
    const numeric = isNumberField(v.entity, field);
    const editable = !numeric && (!f || isEditableFilter(f));
    return {
      field,
      label: fieldLabel(v.entity, field),
      numeric,
      min: numeric && f?.op === 'gte' ? String(f.value) : '',
      editable,
      options: editable ? fieldOptions(this.store, v.entity, field) : [],
      values: f ? filterValues(v.filters, field) : [],
      text: f ? describeFilter(this.store, v.entity, f) : '',
    };
  }

  // ── template casts ──
  protected summary(item: Queryable): WsSummary {
    return this.summaries().get(item.id) ?? buildSummary(this.store, item as Workstream);
  }
  protected asIssue(item: Queryable): Issue {
    return item as Issue;
  }
  protected asDecision(item: Queryable): Decision {
    return item as Decision;
  }
  protected asProject(item: Queryable): Project {
    return item as Project;
  }

  // ── edits (persisted immediately) ──
  private patch(p: Parameters<TramaStore['updateView']>[1]): void {
    const v = this.view();
    if (v && this.canEdit()) void this.store.updateView(v.id, p);
  }
  protected rename(name: string): void {
    if (name.trim()) this.patch({ name: name.trim() });
  }
  protected setLayout(value: unknown): void {
    const next: ViewLayout = value === 'board' ? 'board' : value === 'timeline' && this.supportsTimeline() ? 'timeline' : 'list';
    if (!value || next === this.layout()) return;
    this.patch({ layout: next });
  }
  protected setGroup(field: string | null): void {
    this.patch({ groupBy: field });
  }
  protected setSort(field: string | null): void {
    const v = this.view();
    if (!v) return;
    if (!field) return this.patch({ sort: null });
    const def = FIELD_DEFS[v.entity].find((f) => f.field === field);
    const direction = v.sort?.field === field ? v.sort.direction : def?.kind === 'date' || def?.kind === 'number' ? 'desc' : 'asc';
    this.patch({ sort: { field, direction } });
  }
  protected flipDirection(): void {
    const s = this.view()?.sort;
    if (s) this.patch({ sort: { field: s.field, direction: s.direction === 'asc' ? 'desc' : 'asc' } });
  }
  protected addPending(field: string): void {
    this.pending.update((p) => (p.includes(field) ? p : [...p, field]));
  }
  protected setValues(field: string, values: string[]): void {
    const v = this.view();
    if (!v) return;
    this.patch({ filters: setFilter(v.filters, field, 'in', values) });
    if (!values.length) this.pending.update((p) => p.filter((x) => x !== field));
  }
  /** "At least N" on a numeric (customer demand) field; empty or invalid removes the filter. */
  protected setMin(field: string, raw: string): void {
    const v = this.view();
    if (!v) return;
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n < 0) return this.removeFilter(field);
    this.patch({ filters: setFilter(v.filters, field, 'gte', String(Math.floor(n))) });
  }
  protected removeFilter(field: string): void {
    const v = this.view();
    this.pending.update((p) => p.filter((x) => x !== field));
    if (v?.filters.some((f) => f.field === field)) this.patch({ filters: v.filters.filter((f) => f.field !== field) });
  }
  protected clearFilters(): void {
    this.pending.set([]);
    this.patch({ filters: [] });
  }

  protected async duplicate(): Promise<void> {
    const v = this.view();
    if (!v || !this.store.can('member')) return;
    const copy = await this.store.createView({
      name: `${v.name} (copy)`,
      entity: v.entity,
      filters: v.filters,
      sort: v.sort,
      groupBy: v.groupBy,
      layout: v.layout,
      shared: false,
    });
    if (!copy) return;
    const commands = ['/', this.slug(), 'views', copy.id];
    this.notifier.success(`Saved “${copy.name}”`, {
      description: 'A private copy you can change.',
      action: { label: 'Open', run: () => void this.router.navigate(commands) },
    });
    await this.router.navigate(commands);
  }

  protected copyLink(): void {
    void this.clipboard.copy(location.href, 'Link copied');
  }

  protected remove(): void {
    const v = this.view();
    if (!v) return;
    this.ui.setConfirmDelete({
      title: `Delete “${v.name}”?`,
      description: 'The view goes away. The work it lists does not.',
      onConfirm: async () => {
        const ok = await this.store.deleteView(v.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'views']);
      },
    });
  }
}
