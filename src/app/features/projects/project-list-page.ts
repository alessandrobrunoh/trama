import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideBox, LucideDynamicIcon, LucidePlus, LucideSearch, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { PROJECT_HEALTH_META, TramaStore, UiStore, applyFilters, sortItems, type Project, type ViewFilter } from '../../core';
import { ListStateStore } from '../../core/stores/list-state.store';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { PriorityIcon } from '../../shared/priority-icon';
import { FullDatePipe, RelativeTimePipe } from '../../shared/pipes';
import { compactNumber, describeDemand } from '../customers/customer-model';
import { DemandFilters } from '../customers/demand-filters';
import { Picker } from '../workstreams/picker';
import { teamOptions } from '../workstreams/ws-model';
import { ProjectGlyph } from './project-glyph';
import { ProjectHealthBadge } from './project-health';
import {
  HEALTH_ORDER,
  PROJECT_STATUS_META,
  isClosed,
  isOverdue,
  isUpdateOverdue,
  projectStatusOptions,
} from './project-model';
import { LabelPicker } from '../../shared/label-picker';
import { LabelChips } from '../../shared/label-chip';
import { SearchInput } from '../../shared/search-input';

const NO_UPDATES = 'none';

type ProjectSort = 'name' | 'customerCount' | 'customerRevenue' | 'requestCount';

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
    DemandFilters,
    Kbd,
    EmptyState,
    TopBarActions,
    PriorityIcon,
    FullDatePipe,
    RelativeTimePipe,
    ProjectGlyph,
    ProjectHealthBadge,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canManage()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New project</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Projects" [description]="description()" />

    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2 sm:px-6">
      <app-search-input noun="projects" [(value)]="search" />
      <div
        class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full"
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
        <app-picker
          variant="chip"
          label="Health"
          [multiple]="true"
          [searchable]="false"
          [options]="healths"
          [value]="healthFilter()"
          (valueChange)="healthFilter.set($event)"
        />
        <app-picker
          variant="chip"
          label="Team"
          [multiple]="true"
          [options]="teams()"
          [value]="teamFilter()"
          (valueChange)="teamFilter.set($event)"
        />
        <app-label-picker variant="chip" label="Label" [creatable]="false" [manageLink]="false" [value]="labelFilter()" (valueChange)="labelFilter.set($event)" />
        <app-demand-filters [filters]="demandFilters()" (filtersChange)="demandFilters.set($event)" />
        @if (hasFilters()) {
          <button
            hlmBtn
            variant="ghost"
            size="sm"
            class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs"
            (click)="clearFilters()"
          >
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
      @if (store.customerRequests().length) {
        <label class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
          Sort
          <select
            class="border-input bg-background text-foreground h-7 rounded-md border px-1.5 text-xs"
            aria-label="Sort projects"
            [value]="sort()"
            (change)="sort.set($any($event.target).value)"
          >
            @for (o of sorts; track o.value) {
              <option [value]="o.value">{{ o.label }}</option>
            }
          </select>
        </label>
      }
    </div>

    @if (total() === 0) {
      <app-empty-state
        [icon]="boxIcon"
        title="No projects yet"
        description="A project is a planned outcome with a lead, a target date and the repositories it touches. Workstreams carry out the work."
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
        description="Try another name, status or team."
      >
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        <div
          class="text-muted-foreground bg-muted/30 hidden items-center gap-3 border-b px-4 py-1.5 text-xs sm:px-6 md:flex"
        >
          <span class="flex-1">Name</span>
          <span class="w-24">Priority</span>
          <span class="w-28">Status</span>
          <span class="w-24">Health</span>
          <span class="w-24">Updated</span>
          <span class="w-32">Lead</span>
          <span class="w-28">Target</span>
          @if (showCustomers()) {
            <span class="w-24 text-right">Customers</span>
          }
          <span class="w-20 text-right">Repos</span>
        </div>
        @for (row of rows(); track row.project.id) {
          @let p = row.project;
          <a
            [routerLink]="['/', slug(), 'projects', p.id]"
            [attr.data-row-id]="p.id"
            role="listitem"
            class="hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-ring flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-6 md:min-h-10 md:flex-nowrap md:py-2"
            [class.bg-muted]="ui.focusedRowId() === p.id"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2.5">
              <app-project-glyph [project]="p" [size]="16" />
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium">{{ p.name }}</span>
                @if (p.summary) {
                  <span class="text-muted-foreground block truncate text-xs">{{ p.summary }}</span>
                }
                @if (p.labels.length) {
                  <app-label-chips class="mt-1" [ids]="p.labels" />
                }
              </span>
            </span>
            <span
              class="text-muted-foreground flex items-center gap-3 text-xs max-md:basis-full max-md:flex-wrap max-md:gap-x-4 max-md:gap-y-1 max-md:pl-[22px] max-md:text-[13px] md:contents"
            >
              <span class="flex w-24 items-center max-md:w-auto"
                ><app-priority-icon [priority]="p.priority" [showLabel]="true"
              /></span>
              <span class="flex w-28 items-center gap-1.5 max-md:w-auto" [class]="row.status.text">
                <span class="size-2 shrink-0 rounded-full" [class]="row.status.dot"></span
                >{{ row.status.label }}
              </span>
              <span class="flex w-24 items-center max-md:w-auto">
                @if (p.health) {
                  <app-project-health [health]="p.health" [compact]="true" />
                } @else {
                  <span aria-label="No update yet">—</span>
                }
              </span>
              <span
                class="w-24 whitespace-nowrap max-md:w-auto"
                [class.text-status-needs-input]="row.updateOverdue"
              >
                {{ p.lastUpdateAt ? (p.lastUpdateAt | relativeTime) : '—' }}
              </span>
              <span class="w-32 truncate max-md:w-auto max-md:max-w-32">{{ row.lead ?? '—' }}</span>
              <span
                class="w-28 whitespace-nowrap max-md:w-auto"
                [class.text-status-blocked]="row.overdue"
              >
                {{ p.targetDate ? (p.targetDate | fullDate) : '—' }}
              </span>
              @if (showCustomers()) {
                <span class="w-24 text-right whitespace-nowrap tabular-nums max-md:w-auto" [title]="row.demandText">
                  @if (row.demand; as d) {
                    {{ d.customerCount }}<span class="text-muted-foreground"> · {{ compact(d.revenue) }}</span>
                  } @else {
                    <span class="text-muted-foreground">—</span>
                  }
                </span>
              }
              <span class="w-20 text-right whitespace-nowrap tabular-nums max-md:w-auto">
                {{ p.repositoryIds.length
                }}<span class="md:hidden">
                  {{ p.repositoryIds.length === 1 ? 'repo' : 'repos' }}</span
                >
              </span>
            </span>
          </a>
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
  protected readonly ui = inject(UiStore);

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly boxIcon = LucideBox;
  protected readonly statuses = projectStatusOptions();
  protected readonly healths = [
    ...HEALTH_ORDER.map((h) => ({ value: h as string, label: PROJECT_HEALTH_META[h].label })),
    { value: NO_UPDATES, label: 'No updates' },
  ];

  // Filters survive navigation inside the app (see ListStateStore).
  protected readonly search = this.listState.remember('projects.search', '');
  protected readonly statusFilter = this.listState.remember<string[]>('projects.status', []);
  protected readonly healthFilter = this.listState.remember<string[]>('projects.health', []);
  protected readonly teamFilter = this.listState.remember<string[]>('projects.team', []);
  protected readonly labelFilter = this.listState.remember<string[]>('projects.labels', []);
  protected readonly demandFilters = this.listState.remember<ViewFilter[]>('projects.demand', []);
  protected readonly sort = this.listState.remember<ProjectSort>('projects.sort', 'name');
  protected readonly sorts: { value: ProjectSort; label: string }[] = [
    { value: 'name', label: 'Name' },
    { value: 'customerCount', label: 'Most customers' },
    { value: 'customerRevenue', label: 'Most revenue' },
    { value: 'requestCount', label: 'Most requests' },
  ];
  protected readonly compact = compactNumber;
  /** The customers column appears once any customer has asked for something. */
  protected readonly showCustomers = computed(() => this.store.demand().size > 0);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly total = computed(() => this.store.projects().length);
  protected readonly hasFilters = computed(
    () =>
      !!this.search().trim() ||
      this.statusFilter().length > 0 ||
      this.healthFilter().length > 0 ||
      this.teamFilter().length > 0 ||
      this.labelFilter().length > 0 ||
      this.demandFilters().length > 0,
  );

  protected readonly rows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const statuses = new Set(this.statusFilter());
    const teams = new Set(this.teamFilter());
    const healths = new Set(this.healthFilter());
    const labels = this.labelFilter();
    const users = this.store.userById();
    const demand = this.store.demand();
    const ctx = { demand };
    const sort = this.sort();
    const matching = applyFilters('project', this.store.projects(), this.demandFilters(), ctx);
    // "Most customers / revenue / requests" first; the others stay as before (open first, then by name).
    const ordered: readonly Project[] =
      sort === 'name' ? matching : sortItems('project', matching, { field: sort, direction: 'desc' }, ctx);
    return (
      ordered
        .filter((p) => {
          if (statuses.size && !statuses.has(p.status)) return false;
          if (healths.size && !healths.has(p.health ?? NO_UPDATES)) return false;
          if (teams.size && !p.teamIds.some((id) => teams.has(id))) return false;
          if (labels.length && !labels.some((id) => p.labels.includes(id))) return false;
          return !q || `${p.name} ${p.summary ?? ''}`.toLowerCase().includes(q);
        })
        .slice()
        // Open projects first, then by name (or by demand when asked).
        .sort((a, b) => (sort === 'name' ? Number(isClosed(a)) - Number(isClosed(b)) || a.name.localeCompare(b.name) : 0))
        .map((project) => ({
          project,
          status: PROJECT_STATUS_META[project.status],
          lead: project.leadId ? users.get(project.leadId)?.name : undefined,
          overdue: isOverdue(project),
          updateOverdue: isUpdateOverdue(project),
          demand: demand.get(project.id),
          demandText: demand.has(project.id) ? describeDemand(demand.get(project.id)!) : '',
        }))
    );
  });

  protected readonly description = computed(() => {
    const n = this.total();
    const noun = n === 1 ? 'project' : 'projects';
    return this.hasFilters() ? `${this.rows().length} of ${n} ${noun}` : `${n} ${noun}`;
  });

  protected create(): void {
    this.ui.openCreate('project');
  }

  protected clearFilters(): void {
    this.search.set('');
    this.statusFilter.set([]);
    this.healthFilter.set([]);
    this.teamFilter.set([]);
    this.labelFilter.set([]);
    this.demandFilters.set([]);
  }
}
