import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideBox, LucideDynamicIcon, LucidePlus, LucideSearch, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaStore, UiStore } from '../../core';
import { ListStateStore } from '../../core/stores/list-state.store';
import { TopBarActions } from '../../layout/page-chrome';
import { ActorAvatar } from '../../shared/actor-avatar';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { FullDatePipe } from '../../shared/pipes';
import { milestoneStats, usesPoints } from '../milestones/milestone-model';
import { Picker } from '../../shared/picker';
import { V3Priority } from '../../shared/v3';
import { ProjectGlyph } from './project-glyph';
import { tasksQuery } from './project-tasks-link';
import { isClosed, isOverdue, projectStatusOptions } from './project-model';
import { LabelPicker } from '../../shared/label-picker';
import { LabelChips } from '../../shared/label-chip';
import { SearchInput } from '../../shared/search-input';

/**
 * `/:workspace/projects`: the projects as the Tasks list draws its tasks (v3 "04 · Tasks"): a filter bar, a band
 * per project status and one hairline row per project (priority, tag, name and summary, labels, progress, lead,
 * target date).
 */
@Component({
  selector: 'app-project-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    SearchInput,
    LabelPicker,
    LabelChips,
    RouterLink,
    HlmButtonImports,
    LucideDynamicIcon,
    PageHeader,
    Picker,
    Kbd,
    EmptyState,
    TopBarActions,
    ActorAvatar,
    FullDatePipe,
    ProjectGlyph,
    V3Priority,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canManage()) {
        <button hlmBtn (click)="create()">
          New project <app-kbd keys="c" class="max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Projects" [description]="description()" />

    <div class="border-border flex min-h-[41.5px] flex-wrap items-center gap-x-2.5 gap-y-2 border-b px-4 py-2.5 sm:px-5">
      <app-search-input noun="projects" [(value)]="search" />
      <div
        class="scrollbar-none scroll-fade-x flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto max-sm:basis-full"
      >
        <app-picker
          variant="chip"
          label="Status"
          [multiple]="true"
          [searchable]="false"
          [options]="statuses"
          [value]="statusFilter()"
          (valueChange)="statusFilter.set($event)"
        />
        <app-label-picker
          variant="chip"
          label="Label"
          scope="project"
          [creatable]="false"
          [manageLink]="false"
          [value]="labelFilter()"
          (valueChange)="labelFilter.set($event)"
        />
        @if (hasFilters()) {
          <button
            hlmBtn
            variant="ghost"
            size="sm"
            class="h-7 shrink-0 gap-1 px-2"
            (click)="clearFilters()"
          >
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
      <span class="text-faint ml-auto font-mono text-[11px] max-lg:hidden">Group: status · Sort: name</span>
    </div>

    @if (total() === 0) {
      <app-empty-state
        [icon]="boxIcon"
        title="No projects yet"
        description="A project groups planned tasks and milestones."
      >
        @if (canManage()) {
          <button hlmBtn size="sm" (click)="create()">
            <svg [lucideIcon]="plus" [size]="14"></svg>New project
          </button>
        }
      </app-empty-state>
    } @else if (rows().length === 0) {
      <app-empty-state
        [icon]="searchIcon"
        title="No projects match"
        description="Try another name, status or repository."
      >
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto pb-4" role="list">
        @for (g of groups(); track g.id) {
          <section [attr.aria-label]="g.label">
            <h2 class="bg-card border-border flex h-[30.5px] items-center gap-2.5 border-b px-4 font-normal">
              <span class="size-2 shrink-0" [style.background]="g.color" aria-hidden="true"></span>
              <span class="text-foreground font-mono text-[11.5px] leading-[14px]">{{ g.label }}</span>
              <span class="text-faint font-mono text-[11px] leading-[14px] tabular-nums">{{ g.rows.length }}</span>
            </h2>
            @for (row of g.rows; track row.project.id) {
              @let p = row.project;
              <a
                [routerLink]="['/', slug(), 'projects', p.id]"
                [attr.data-row-id]="p.id"
                role="listitem"
                class="border-border focus-visible:ring-ring flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 outline-none focus-visible:ring-1 focus-visible:ring-inset md:min-h-[39.5px] md:flex-nowrap md:py-0"
                [class]="ui.focusedRowId() === p.id ? 'bg-selected' : 'hover:bg-hover'"
              >
                <v3-priority class="w-[84px] shrink-0 max-md:w-auto" [priority]="p.priority" />
                <span class="text-faint w-14 shrink-0 font-mono text-[11px] leading-[14px] max-sm:hidden">{{ p.key }}</span>
                <span class="flex min-w-0 flex-1 items-center gap-2.5">
                  <app-project-glyph [project]="p" [size]="14" />
                  <span class="text-foreground max-w-[16rem] min-w-0 shrink-0 truncate text-[13.5px] leading-4">{{ p.name }}</span>
                  @if (p.summary) {
                    <span class="text-muted-foreground min-w-0 flex-1 truncate text-xs max-lg:hidden">{{ p.summary }}</span>
                  }
                  @if (p.labels.length) {
                    <app-label-chips class="shrink-0 max-xl:hidden" [ids]="p.labels" [max]="2" />
                  }
                </span>
                <span
                  class="flex items-center gap-3 max-md:basis-full max-md:flex-wrap max-md:gap-x-4 max-md:gap-y-1 max-md:pl-[26px] md:contents"
                >
                  <span
                    class="hover:bg-hover -my-1 flex w-28 shrink-0 items-center gap-2 py-1 max-md:w-auto"
                    role="link"
                    title="Open the tasks of this project"
                    [attr.aria-label]="row.percent + '% complete, open the tasks'"
                    (click)="openTasks($event, p.id)"
                  >
                    <span class="bg-line h-1 w-14" aria-hidden="true">
                      <span class="bg-status-done block h-full" [style.width.%]="row.percent"></span>
                    </span>
                    <span class="text-muted-foreground font-mono text-[11px] leading-[14px] tabular-nums">{{ row.percent }}%</span>
                  </span>
                  <span class="flex w-[22px] shrink-0 items-center justify-center max-md:w-auto" [attr.title]="row.lead ?? null">
                    @if (p.leadId) {
                      <app-actor-avatar [actor]="{ type: 'user', id: p.leadId }" [size]="22" />
                    } @else {
                      <span class="text-faint font-mono text-[11px]">—</span>
                    }
                  </span>
                  <span
                    class="w-[92px] shrink-0 text-right font-mono text-[11px] leading-[14px] whitespace-nowrap max-md:hidden"
                    [class]="row.overdue ? 'text-red' : 'text-muted-foreground'"
                  >
                    {{ p.targetDate ? (p.targetDate | fullDate) : '—' }}
                  </span>
                </span>
              </a>
            }
          </section>
        }
      </div>
    }
  `,
})
export class ProjectListPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  protected readonly store = inject(TramaStore);
  private readonly listState = inject(ListStateStore);
  private readonly router = inject(Router);
  protected readonly ui = inject(UiStore);

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly boxIcon = LucideBox;
  protected get statuses() {
    return projectStatusOptions(this.store.settings().statuses.project);
  }

  // Filters survive navigation inside the app (see ListStateStore).
  protected readonly search = this.listState.remember('projects.search', '');
  protected readonly statusFilter = this.listState.remember<string[]>('projects.status', []);
  protected readonly labelFilter = this.listState.remember<string[]>('projects.labels', []);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly total = computed(() => this.store.projects().length);
  protected readonly hasFilters = computed(
    () =>
      !!this.search().trim() ||
      this.statusFilter().length > 0 ||
      this.labelFilter().length > 0,
  );

  protected readonly rows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const statuses = new Set(this.statusFilter());
    const labels = this.labelFilter();
    const users = this.store.userById();
    return this.store
      .projects()
      .filter((p) => {
        if (statuses.size && !statuses.has(p.status)) return false;
        if (labels.length && !labels.some((id) => p.labels.includes(id))) return false;
        return !q || `${p.name} ${p.summary ?? ''} ${p.repository ?? ''}`.toLowerCase().includes(q);
      })
      .slice()
      .sort((a, b) => {
        const entries = this.store.settings().statuses.project;
        return (
          Number(isClosed(a, entries)) - Number(isClosed(b, entries)) || a.name.localeCompare(b.name)
        );
      })
      .map((project) => {
        const issues = this.store.issuesByProject().get(project.id) ?? [];
        return {
          project,
          lead: project.leadId ? users.get(project.leadId)?.name : undefined,
          overdue: isOverdue(project),
          percent: milestoneStats(issues, usesPoints(issues, this.store.estimateScale())).percent,
        };
      });
  });

  /** Rows under a band per project status, in the workspace's status order. */
  protected readonly groups = computed(() => {
    const rows = this.rows();
    return this.store
      .settings()
      .statuses.project.map((entry) => ({
        id: entry.id,
        label: entry.name,
        color: entry.color,
        rows: rows.filter((r) => r.project.status === entry.id),
      }))
      .filter((g) => g.rows.length > 0);
  });

  protected readonly description = computed(() => {
    const n = this.total();
    const noun = n === 1 ? 'project' : 'projects';
    return this.hasFilters() ? `${this.rows().length} of ${n} ${noun}` : `${n} ${noun}`;
  });

  /** The progress of a row opens that project's Tasks tab instead of the row's own link. */
  protected openTasks(e: Event, projectId: string): void {
    e.preventDefault();
    e.stopPropagation();
    void this.router.navigate(['/', this.slug(), 'projects', projectId], { queryParams: tasksQuery() });
  }

  protected create(): void {
    this.ui.openCreate('project');
  }

  protected clearFilters(): void {
    this.search.set('');
    this.statusFilter.set([]);
    this.labelFilter.set([]);
  }
}
