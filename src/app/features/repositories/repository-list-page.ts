import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideFolderGit2, LucidePlus, LucideSearch, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, UiStore, type GitProvider, type Repository } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { ProviderIcon, providerLabel } from '../../shared/provider-icon';
import { Picker, type PickOption } from '../workstreams/picker';
import { teamOptions } from '../workstreams/ws-model';

const PROVIDERS: PickOption[] = [
  { value: 'github', label: 'GitHub', kind: 'provider', provider: 'github' },
  { value: 'gitlab', label: 'GitLab', kind: 'provider', provider: 'gitlab' },
];

@Component({
  selector: 'app-repository-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmInputImports,
    LucideDynamicIcon,
    PageHeader,
    Picker,
    Kbd,
    EmptyState,
    ProviderIcon,
    TopBarActions,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canAdmin()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New project</span>
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
          class="h-7 w-full pl-8 text-xs"
          placeholder="Search projects…"
          aria-label="Search projects"
          [value]="search()"
          (input)="search.set($any($event.target).value)"
        />
      </div>
      <div class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full">
        <app-picker variant="chip" label="Provider" [multiple]="true" [searchable]="false" [options]="providers" [value]="providerFilter()" (valueChange)="providerFilter.set($event)" />
        <app-picker variant="chip" label="Team" [multiple]="true" [options]="teams()" [value]="teamFilter()" (valueChange)="teamFilter.set($event)" />
        @if (hasFilters()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs" (click)="clearFilters()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="folder" title="No projects yet" description="A project is a GitHub or GitLab repository a workstream can land in. Nabla keeps the link, not the git history.">
        @if (canAdmin()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New project</button>
        }
      </app-empty-state>
    } @else if (shown().length === 0) {
      <app-empty-state [icon]="searchIcon" title="No projects match" description="Try another name, provider or team.">
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        @for (r of shown(); track r.id) {
          <a
            [routerLink]="['/', slug(), 'projects', r.id]"
            [attr.data-row-id]="r.id"
            class="hover:bg-muted/60 focus-visible:bg-muted/60 flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 outline-none sm:px-6 md:min-h-9 md:flex-nowrap"
            [class.bg-muted]="ui.focusedRowId() === r.id"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2.5">
              <app-provider-icon [provider]="r.provider" [size]="15" />
              <span class="min-w-0 truncate font-mono text-sm">{{ r.fullName }}</span>
            </span>
            <span class="text-muted-foreground flex items-center gap-3 text-xs max-md:basis-full max-md:pl-[26px]">
              <span class="hidden sm:inline">{{ providerName(r.provider) }}</span>
              <span class="font-mono">{{ r.defaultBranch }}</span>
              <span class="max-w-48 truncate">{{ teamNames(r) }}</span>
              <span class="tabular-nums">{{ workstreamCount(r.id) }} workstreams</span>
            </span>
          </a>
        }
      </div>
    }
  `,
})
export class RepositoryListPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  private readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly folder = LucideFolderGit2;
  protected readonly providers = PROVIDERS;

  protected readonly search = signal('');
  protected readonly providerFilter = signal<string[]>([]);
  protected readonly teamFilter = signal<string[]>([]);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly total = computed(() => this.store.repositories().length);
  protected readonly hasFilters = computed(
    () => !!this.search().trim() || this.providerFilter().length > 0 || this.teamFilter().length > 0,
  );

  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    const providers = new Set(this.providerFilter());
    const teams = new Set(this.teamFilter());
    return this.store
      .repositories()
      .filter((r) => {
        if (providers.size && !providers.has(r.provider)) return false;
        if (teams.size && !r.teamIds.some((id) => teams.has(id))) return false;
        if (!q) return true;
        const names = r.teamIds.map((id) => this.store.teamById().get(id)?.name ?? '').join(' ');
        return `${r.fullName} ${r.url} ${r.defaultBranch} ${names}`.toLowerCase().includes(q);
      })
      .slice()
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  protected readonly description = computed(() => {
    const n = this.total();
    const visible = this.shown().length;
    const noun = n === 1 ? 'project' : 'projects';
    return this.hasFilters() ? `${visible} of ${n} ${noun}` : `${n} ${noun}`;
  });

  protected providerName(provider: GitProvider): string {
    return providerLabel(provider);
  }

  protected teamNames(repo: Repository): string {
    const names = repo.teamIds
      .map((id) => this.store.teamById().get(id)?.name)
      .filter((n): n is string => !!n);
    return names.length ? names.join(', ') : 'No team';
  }

  protected workstreamCount(id: string): number {
    return this.store.workstreamsByRepository().get(id)?.length ?? 0;
  }

  protected create(): void {
    this.ui.openCreate('repository');
  }

  protected clearFilters(): void {
    this.search.set('');
    this.providerFilter.set([]);
    this.teamFilter.set([]);
  }
}
