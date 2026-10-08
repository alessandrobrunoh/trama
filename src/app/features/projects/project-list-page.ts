import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideBox, LucideDynamicIcon, LucidePlus, LucideSearch, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, UiStore } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { FullDatePipe } from '../../shared/pipes';
import { PriorityIcon } from '../../shared/priority-icon';
import { Picker } from '../workstreams/picker';
import { teamOptions } from '../workstreams/ws-model';
import { PROJECT_STATUS_META, isClosed, isOverdue, projectStatusOptions } from './project-model';

@Component({
  selector: 'app-project-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, PageHeader, Picker, Kbd, EmptyState, TopBarActions, PriorityIcon, FullDatePipe],
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
      <div class="relative w-full sm:w-52">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input
          hlmInput
          class="h-10 w-full pl-9 text-sm"
          placeholder="Search projects…"
          aria-label="Search projects"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
      </div>
      <div class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full">
        <app-picker variant="chip" label="Status" [multiple]="true" [searchable]="false" [options]="statuses" [value]="statusFilter()" (valueChange)="statusFilter.set($event)" />
        <app-picker variant="chip" label="Team" [multiple]="true" [options]="teams()" [value]="teamFilter()" (valueChange)="teamFilter.set($event)" />
        @if (hasFilters()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs" (click)="clearFilters()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="boxIcon" title="No projects yet" description="A project is a planned outcome with a lead, a target date and the repositories it touches. Workstreams carry out the work.">
        @if (canManage()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New project</button>
        }
      </app-empty-state>
    } @else if (rows().length === 0) {
      <app-empty-state [icon]="searchIcon" title="No projects match" description="Try another name, status or team.">
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        <div class="text-muted-foreground bg-muted/30 hidden items-center gap-3 border-b px-4 py-1.5 text-xs sm:px-6 md:flex">
          <span class="flex-1">Name</span>
          <span class="w-24">Priority</span>
          <span class="w-28">Status</span>
          <span class="w-32">Lead</span>
          <span class="w-28">Target</span>
          <span class="w-20 text-right">Repos</span>
        </div>
        @for (row of rows(); track row.project.id) {
          @let p = row.project;
          <a
            [routerLink]="['/', slug(), 'projects', p.id]"
            [attr.data-row-id]="p.id"
            role="listitem"
            class="hover:bg-muted/60 focus-visible:bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 outline-none sm:px-6 md:min-h-10 md:flex-nowrap md:py-2"
            [class.bg-muted]="ui.focusedRowId() === p.id"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2.5">
              <span class="size-3 shrink-0 rounded-sm" [style.background]="p.color"></span>
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium">{{ p.name }}</span>
                @if (p.summary) {
                  <span class="text-muted-foreground block truncate text-xs">{{ p.summary }}</span>
                }
              </span>
            </span>
            <span class="text-muted-foreground flex items-center gap-3 text-xs max-md:basis-full max-md:flex-wrap max-md:gap-x-4 max-md:gap-y-1 max-md:pl-[22px] max-md:text-[13px] md:contents">
              <span class="flex w-24 items-center max-md:w-auto"><app-priority-icon [priority]="p.priority" [showLabel]="true" /></span>
              <span class="flex w-28 items-center gap-1.5 max-md:w-auto" [class]="row.status.text">
                <span class="size-2 shrink-0 rounded-full" [class]="row.status.dot"></span>{{ row.status.label }}
              </span>
              <span class="w-32 truncate max-md:w-auto max-md:max-w-32">{{ row.lead ?? '—' }}</span>
              <span class="w-28 whitespace-nowrap max-md:w-auto" [class.text-status-blocked]="row.overdue">
                {{ p.targetDate ? (p.targetDate | fullDate) : '—' }}
              </span>
              <span class="w-20 text-right whitespace-nowrap tabular-nums max-md:w-auto">
                {{ p.repositoryIds.length }}<span class="md:hidden"> {{ p.repositoryIds.length === 1 ? 'repo' : 'repos' }}</span>
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

  private readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly boxIcon = LucideBox;
  protected readonly statuses = projectStatusOptions();

  protected readonly search = signal('');
  protected readonly statusFilter = signal<string[]>([]);
  protected readonly teamFilter = signal<string[]>([]);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageProjects'));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly total = computed(() => this.store.projects().length);
  protected readonly hasFilters = computed(
    () => !!this.search().trim() || this.statusFilter().length > 0 || this.teamFilter().length > 0,
  );

  protected readonly rows = computed(() => {
    const q = this.search().trim().toLowerCase();
    const statuses = new Set(this.statusFilter());
    const teams = new Set(this.teamFilter());
    const users = this.store.userById();
    return this.store
      .projects()
      .filter((p) => {
        if (statuses.size && !statuses.has(p.status)) return false;
        if (teams.size && !p.teamIds.some((id) => teams.has(id))) return false;
        return !q || `${p.name} ${p.summary ?? ''}`.toLowerCase().includes(q);
      })
      .slice()
      // Open projects first, then by name.
      .sort((a, b) => Number(isClosed(a)) - Number(isClosed(b)) || a.name.localeCompare(b.name))
      .map((project) => ({
        project,
        status: PROJECT_STATUS_META[project.status],
        lead: project.leadId ? users.get(project.leadId)?.name : undefined,
        overdue: isOverdue(project),
      }));
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
    this.teamFilter.set([]);
  }
}
