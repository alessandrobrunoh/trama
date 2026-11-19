import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideChartGantt,
  LucideCopy,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideKanban,
  LucideLayers,
  LucideLink2,
  LucideList,
  LucideTrash2,
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
  groupItems,
  queryItems,
  type Priority,
  type Project,
  type Queryable,
  type ViewFilter,
  type ViewLayout,
} from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { FilterBar, type FilterBarSort } from '../../shared/filter-bar/filter-bar';
import { PageHeader } from '../../shared/page-header';
import { PriorityIcon } from '../../shared/priority-icon';
import { StatusIcon } from '../../shared/status';
import { IssueBoard } from '../issues/issue-board';
import type { IssueGroup, IssueSort } from '../issues/issue-model';
import { IssueCommandDialog } from '../issues/issue-prop';
import { TimelineView } from '../timeline/timeline-view';
import { InlineText } from '../../shared/inline-edit';
import { canEditSavedView, canManageViewSharing } from './view-access';
import { ViewShare } from './view-share';
import { ViewProjectCard, ViewProjectRow } from './view-project-items';
import {
  ENTITY_ICON,
  ENTITY_LABEL,
  STATUS_ENTITY,
  valueColor,
  valueGlyph,
  statusColumnIds,
  valueLabel,
  type ViewGroup,
} from './view-model';

/** Layouts the toggle offers; the timeline only for entities that have dates. */
type PageLayout = 'list' | 'board' | 'timeline';

/**
 * A saved view: renders its entity with the right rows, honours `layout` (list / board / timeline)
 * and `groupBy`, and lets the owner edit name, filters, sort,
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
    StatusIcon,
    PriorityIcon,
    ActorAvatar,
    InlineText,
    FilterBar,
    ViewShare,
    IssueBoard,
    IssueCommandDialog,
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
          <button
            hlmBtn
            variant="outline"
            size="sm"
            (click)="duplicate()"
            hlmTooltip="Save a copy you can change"
            position="bottom"
          >
            <svg [lucideIcon]="copyIcon" [size]="14"></svg>
            <span class="max-sm:hidden">Duplicate to edit</span>
          </button>
        }
        <button
          hlmBtn
          variant="ghost"
          size="icon-sm"
          class="text-muted-foreground"
          [hlmDropdownMenuTrigger]="more"
          aria-label="View actions"
        >
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
        <svg
          leading
          [lucideIcon]="entityIcon()"
          [size]="15"
          class="text-muted-foreground shrink-0"
        ></svg>
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
            <button
              hlmToggleGroupItem
              value="list"
              aria-label="List"
              class="h-7 px-2"
              hlmTooltip="List"
              position="bottom"
            >
              <svg [lucideIcon]="listIcon" [size]="14"></svg>
            </button>
            <button
              hlmToggleGroupItem
              value="board"
              aria-label="Board"
              class="h-7 px-2"
              hlmTooltip="Board"
              position="bottom"
            >
              <svg [lucideIcon]="boardIcon" [size]="14"></svg>
            </button>
            @if (supportsTimeline()) {
              <button
                hlmToggleGroupItem
                value="timeline"
                aria-label="Timeline"
                class="h-7 px-2"
                hlmTooltip="Timeline"
                position="bottom"
              >
                <svg [lucideIcon]="timelineIcon" [size]="14"></svg>
              </button>
            }
          </hlm-toggle-group>
        </span>

        <!-- filter / sort / group row: the shared filter bar -->
        <app-filter-bar
          class="px-4 py-2 sm:px-6"
          [entity]="v.entity"
          [filters]="v.filters"
          [sort]="v.sort ?? null"
          [groupBy]="effectiveGroup()"
          [columns]="layout() === 'board'"
          [canEdit]="canEdit()"
          (filtersChange)="setFilters($event)"
          (sortChange)="setSort($event)"
          (groupByChange)="setGroup($event)"
        />
      </app-page-header>

      @if (rows().length === 0) {
        <app-empty-state
          [icon]="layers"
          title="Nothing in this view"
          [description]="
            v.filters.length
              ? 'The filters do not match anything right now.'
              : 'There are no ' + entityLabel().toLowerCase() + ' yet.'
          "
        >
          @if (canEdit() && v.filters.length) {
            <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">
              Clear filters
            </button>
          }
        </app-empty-state>
      } @else if (v.entity === 'issue') {
        <!-- the one task table of the app, told the view's query instead of letting the user pick -->
        <div class="flex min-h-0 flex-1 flex-col">
          <app-issue-board
            [issues]="allIssues()"
            [baseFilters]="v.filters"
            [toolbar]="false"
            [statusBar]="false"
            [showCreate]="false"
            [forceLayout]="layout() === 'board' ? 'board' : 'list'"
            [forceGroup]="issueGroup()"
            [forceSort]="issueSort()"
            [stateKey]="'view.' + v.id"
            [dropPrefix]="'view-issue-col'"
          />
          <app-issue-command-dialog />
        </div>
      } @else if (layout() === 'board') {
        <div class="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 py-3 sm:px-5">
          @for (g of groups(); track g.key) {
            <section class="bg-muted flex w-72 shrink-0 flex-col rounded-lg" [attr.aria-label]="g.label">
              <header class="text-muted-foreground flex h-9 shrink-0 items-center gap-2 px-3 text-[13px]">
                <ng-container *ngTemplateOutlet="glyph; context: { $implicit: g }" />
                <span class="truncate">{{ g.label }}</span>
                <span class="tabular-nums">{{ g.items.length }}</span>
              </header>
              <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                @for (item of g.items; track item.id) {
                  <app-view-project-card
                    [project]="asProject(item)"
                    [focused]="ui.focusedRowId() === item.id"
                  />
                } @empty {
                  <p class="text-meta px-1 py-2">Empty</p>
                }
              </div>
            </section>
          }
        </div>
      } @else if (layout() === 'timeline') {
        <app-timeline-view
          entity="project"
          [groups]="groups()"
        />
      } @else {
        <div class="min-h-0 flex-1 overflow-y-auto">
          @for (g of groups(); track g.key) {
            @if (grouped()) {
              <div
                class="text-muted-foreground bg-background sticky top-0 z-10 mt-1 flex h-8 items-center gap-2 px-4 text-[13px] sm:px-5"
              >
                <ng-container *ngTemplateOutlet="glyph; context: { $implicit: g }" />
                <span>{{ g.label }}</span>
                <span class="tabular-nums">{{ g.items.length }}</span>
              </div>
            }
            @for (item of g.items; track item.id) {
              <app-view-project-row
                [project]="asProject(item)"
                [focused]="ui.focusedRowId() === item.id"
              />
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
      <app-empty-state
        [icon]="layers"
        title="View not found"
        description="It may have been deleted, or it is private to someone else."
      >
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'views']"
          >Back to views</a
        >
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

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly view = computed(() => this.store.getView(this.id()));
  private viewPower() {
    return { canWrite: this.store.can('member'), canAdmin: this.store.can('admin') };
  }
  protected readonly canEdit = computed(() => {
    const v = this.view();
    return !!v && canEditSavedView(v, this.store.me()?.id, this.store.myRole(), this.viewPower());
  });
  /** Delete the view / change who has access. */
  protected readonly canManage = computed(() => {
    const v = this.view();
    return (
      !!v && canManageViewSharing(v, this.store.me()?.id, this.store.myRole(), this.viewPower())
    );
  });

  protected readonly entityIcon = computed(() => ENTITY_ICON[this.view()?.entity ?? 'issue']);
  protected readonly entityLabel = computed(
    () => ENTITY_LABEL[this.view()?.entity ?? 'issue'],
  );
  protected readonly statusEntity = computed(
    () => STATUS_ENTITY[this.view()?.entity ?? 'issue'],
  );
  /** Projects have start and target dates, so they can be drawn as a timeline. */
  protected readonly supportsTimeline = computed(() => this.view()?.entity === 'project');
  protected readonly layout = computed<PageLayout>(() => {
    const l = this.view()?.layout;
    if (l === 'board') return 'board';
    return l === 'timeline' && this.supportsTimeline() ? 'timeline' : 'list';
  });

  // ── query ──
  private readonly queryCtx = computed(() => ({}));
  protected readonly rows = computed<Queryable[]>(() => {
    const v = this.view();
    if (!v) return [];
    // A timeline reads left to right: without an explicit order, earliest start first.
    const sort =
      v.sort ??
      (this.layout() === 'timeline'
        ? { field: 'startDate', direction: 'asc' as const }
        : undefined);
    const spec = { filters: v.filters, sort };
    const ctx = this.queryCtx();
    if (v.entity === 'project') return queryItems('project', this.store.projects(), spec, ctx);
    return queryItems('issue', this.store.issues(), spec, ctx);
  });

  /** Board always groups (default status); list groups only when `groupBy` is set. */
  protected readonly effectiveGroup = computed(() => {
    const v = this.view();
    if (!v) return null;
    return v.groupBy ?? (this.layout() === 'board' ? 'status' : null);
  });
  protected readonly grouped = computed(() => !!this.effectiveGroup());

  // ── what a task view tells the shared task table ──
  protected readonly allIssues = computed(() => this.store.issues());
  protected readonly issueGroup = computed<IssueGroup>(() => (this.effectiveGroup() ?? 'none') as IssueGroup);
  protected readonly issueSort = computed<{ field: IssueSort; direction: 'asc' | 'desc' }>(() => {
    const s = this.view()?.sort;
    return s ? { field: s.field as IssueSort, direction: s.direction } : { field: 'updatedAt', direction: 'desc' };
  });

  protected readonly groups = computed<ViewGroup[]>(() => {
    const v = this.view();
    if (!v) return [];
    const field = this.effectiveGroup();
    if (!field) return [{ key: '__all', label: '', items: this.rows() }];
    const def = FIELD_DEFS[v.entity].find((f) => f.field === field);
    const include =
      this.layout() === 'board' && field === 'status'
        ? statusColumnIds(this.store, v.entity, field)
        : this.layout() === 'board' && def?.kind === 'enum'
          ? def.values
          : undefined;
    const raw = groupItems(v.entity, this.rows() as never[], field, this.queryCtx(), include) as { key: string; items: Queryable[] }[];
    return raw.map((g) => {
      const glyph = valueGlyph(v.entity, field, g.key, this.store);
      return {
        key: g.key || '__none',
        label: valueLabel(this.store, v.entity, field, g.key),
        status: glyph.status,
        priority: field === 'priority' && g.key ? (g.key as Priority) : undefined,
        actor:
          glyph.actor?.type === 'user' && glyph.actor.id
            ? { type: 'user' as const, id: glyph.actor.id }
            : undefined,
        color: valueColor(v.entity, field, g.key),
        items: g.items,
      };
    });
  });

  protected readonly description = computed(() => {
    const v = this.view();
    if (!v) return '';
    const n = this.rows().length;
    const access = { private: 'Private', workspace: 'Shared', link: 'Public' }[
      v.sharing.visibility
    ];
    return `${access} view · ${n} ${ENTITY_LABEL[v.entity].toLowerCase()}`;
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Views', link: ['/', this.slug(), 'views'] },
    { label: this.view()?.name ?? 'View' },
  ]);

  // ── template casts ──
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
    const next: ViewLayout =
      value === 'board'
        ? 'board'
        : value === 'timeline' && this.supportsTimeline()
          ? 'timeline'
          : 'list';
    if (!value || next === this.layout()) return;
    this.patch({ layout: next });
  }
  protected setGroup(field: string | null): void {
    this.patch({ groupBy: field });
  }
  protected setSort(sort: FilterBarSort | null): void {
    this.patch({ sort });
  }
  protected setFilters(filters: ViewFilter[]): void {
    this.patch({ filters });
  }
  protected clearFilters(): void {
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
