import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDownload, LucideDynamicIcon, LucideFolderGit2, LucidePlus, LucideSearch, LucideX } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { NablaStore, UiStore } from '../../core';
import { ListStateStore } from '../../core/stores/list-state.store';
import { GIT_PROVIDERS, GIT_PROVIDER_META } from '../../core/contracts/domain';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { PageHeader } from '../../shared/page-header';
import { ProviderIcon } from '../../shared/provider-icon';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusIcon } from '../../shared/status';
import { Picker, type PickOption } from '../workstreams/picker';
import { ImportRepositoriesDialog } from './import-repositories-dialog';
import { teamOptions } from '../workstreams/ws-model';
import { LabelPicker } from '../../shared/label-picker';
import { LabelChips } from '../../shared/label-chip';
import { SearchInput } from '../../shared/search-input';

const PROVIDERS: PickOption[] = GIT_PROVIDERS.map((p) => ({ value: p, label: GIT_PROVIDER_META[p].label, kind: 'provider', provider: p }));

@Component({
  selector: 'app-repository-list-page',
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
    ProviderIcon,
    TopBarActions,
    StatusIcon,
    RelativeTimePipe,
    ImportRepositoriesDialog,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canAdmin()) {
        <button hlmBtn variant="outline" size="sm" (click)="importOpen.set(true)">
          <svg [lucideIcon]="download" [size]="14"></svg>
          <span class="max-sm:hidden">Import</span>
        </button>
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>New repository</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Repositories" [description]="description()" />

    <div class="flex flex-wrap items-center gap-x-2 gap-y-2 border-b px-4 py-2 sm:px-6">
      <app-search-input noun="repositories" [(value)]="search" />
      <div class="scrollbar-none flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto max-sm:basis-full">
        <app-picker variant="chip" label="Provider" [multiple]="true" [searchable]="false" [options]="providers" [value]="providerFilter()" (valueChange)="providerFilter.set($event)" />
        <app-picker variant="chip" label="Team" [multiple]="true" [options]="teams()" [value]="teamFilter()" (valueChange)="teamFilter.set($event)" />
        <app-label-picker variant="chip" label="Label" [creatable]="false" [manageLink]="false" [value]="labelFilter()" (valueChange)="labelFilter.set($event)" />
        @if (hasFilters()) {
          <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7 shrink-0 gap-1 px-2 text-xs" (click)="clearFilters()">
            <svg [lucideIcon]="xIcon" [size]="12"></svg>Clear
          </button>
        }
      </div>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="folder" title="No repositories yet" description="A repository on GitHub, GitLab or Bitbucket that a workstream can land in. Import them from a connected account, or add one by hand.">
        @if (canAdmin()) {
          <button hlmBtn size="sm" (click)="importOpen.set(true)"><svg [lucideIcon]="download" [size]="14"></svg>Import from a git host</button>
          <button hlmBtn size="sm" variant="outline" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>Add manually</button>
        }
      </app-empty-state>
    } @else if (shown().length === 0) {
      <app-empty-state [icon]="searchIcon" title="No repositories match" description="Try another name, provider or team.">
        <button hlmBtn size="sm" variant="outline" (click)="clearFilters()">Clear filters</button>
      </app-empty-state>
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        <div class="text-muted-foreground bg-muted/30 hidden items-center gap-3 border-b px-4 py-1.5 text-xs sm:px-6 md:flex">
          <span class="flex-1">Repository</span>
          <span class="w-28">Branch</span>
          <span class="w-36">Teams</span>
          <span class="w-24 text-right">Workstreams</span>
          <span class="w-24 text-right">Activity</span>
        </div>
        @for (row of rows(); track row.repo.id) {
          @let r = row.repo;
          <a
            [routerLink]="['/', slug(), 'repositories', r.id]"
            [attr.data-row-id]="r.id"
            role="listitem"
            class="hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-ring flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-6 md:min-h-10 md:flex-nowrap md:py-2"
            [class.bg-muted]="ui.focusedRowId() === r.id"
          >
            <span class="flex min-w-0 flex-1 items-center gap-2.5">
              <app-provider-icon [provider]="r.provider" [size]="18" />
              <span class="min-w-0 truncate font-mono text-sm">
                <span class="text-muted-foreground">{{ row.owner }}/</span><span class="text-foreground font-medium">{{ row.name }}</span>
              </span>
              @if (r.labels.length) {
                <app-label-chips class="max-md:hidden" [ids]="r.labels" [max]="2" />
              }
            </span>
            <span class="text-muted-foreground flex items-center gap-3 text-xs max-md:basis-full max-md:flex-wrap max-md:gap-x-4 max-md:gap-y-1 max-md:pl-[30px] max-md:text-[13px] md:contents">
              <span class="w-28 truncate font-mono max-md:w-auto">{{ r.defaultBranch }}</span>
              <span class="flex w-36 min-w-0 items-center gap-1.5 max-md:w-auto">
                @for (t of row.teams; track t.id) {
                  <span class="flex min-w-0 items-center gap-1" [title]="t.name">
                    <span class="size-2 shrink-0 rounded-full" [style.background]="t.color"></span>
                    @if (row.teams.length === 1) {
                      <span class="truncate">{{ t.name }}</span>
                    } @else {
                      <span class="font-mono text-[11px]">{{ t.key }}</span>
                    }
                  </span>
                } @empty {
                  <span class="opacity-60">No team</span>
                }
              </span>
              <span class="flex w-24 items-center justify-end gap-1.5 tabular-nums max-md:w-auto max-md:justify-start">
                <app-status-icon status="working" entity="workstream" [size]="12" />{{ row.active }}<span class="opacity-60">/ {{ row.total }}</span>
              </span>
              <span class="w-24 text-right tabular-nums max-md:hidden">{{ row.lastActivity ? (row.lastActivity | relativeTime) : '—' }}</span>
            </span>
          </a>
        }
      </div>
    }
    <app-import-repositories-dialog [open]="importOpen()" (closed)="importOpen.set(false)" />
  `,
})
export class RepositoryListPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();

  private readonly store = inject(NablaStore);
  private readonly listState = inject(ListStateStore);
  protected readonly ui = inject(UiStore);

  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly xIcon = LucideX;
  protected readonly folder = LucideFolderGit2;
  protected readonly download = LucideDownload;
  protected readonly importOpen = signal(false);
  protected readonly providers = PROVIDERS;

  // Filters survive navigation inside the app (see ListStateStore).
  protected readonly search = this.listState.remember('repositories.search', '');
  protected readonly providerFilter = this.listState.remember<string[]>('repositories.provider', []);
  protected readonly teamFilter = this.listState.remember<string[]>('repositories.team', []);
  protected readonly labelFilter = this.listState.remember<string[]>('repositories.labels', []);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canAdmin = computed(() => this.store.allowed('manageRepositories'));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly total = computed(() => this.store.repositories().length);
  protected readonly hasFilters = computed(
    () => !!this.search().trim() || this.providerFilter().length > 0 || this.teamFilter().length > 0 || this.labelFilter().length > 0,
  );

  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    const providers = new Set(this.providerFilter());
    const teams = new Set(this.teamFilter());
    const labels = this.labelFilter();
    return this.store
      .repositories()
      .filter((r) => {
        if (providers.size && !providers.has(r.provider)) return false;
        if (teams.size && !r.teamIds.some((id) => teams.has(id))) return false;
        if (labels.length && !labels.some((id) => r.labels.includes(id))) return false;
        if (!q) return true;
        const names = r.teamIds.map((id) => this.store.teamById().get(id)?.name ?? '').join(' ');
        return `${r.fullName} ${r.url} ${r.defaultBranch} ${names}`.toLowerCase().includes(q);
      })
      .slice()
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  });

  protected readonly rows = computed(() => {
    const teams = this.store.teamById();
    const wsBy = this.store.workstreamsByRepository();
    const arBy = this.store.artifactsByRepository();
    return this.shown().map((repo) => {
      const ws = wsBy.get(repo.id) ?? [];
      const slash = repo.fullName.lastIndexOf('/');
      let last = '';
      for (const a of arBy.get(repo.id) ?? []) if (a.updatedAt > last) last = a.updatedAt;
      for (const w of ws) if (w.updatedAt > last) last = w.updatedAt;
      return {
        repo,
        owner: slash > 0 ? repo.fullName.slice(0, slash) : '',
        name: slash > 0 ? repo.fullName.slice(slash + 1) : repo.fullName,
        teams: repo.teamIds.map((id) => teams.get(id)).filter((t) => !!t),
        total: ws.length,
        active: ws.filter((w) => w.status !== 'shipped' && w.status !== 'canceled' && w.status !== 'draft').length,
        lastActivity: last || null,
      };
    });
  });

  protected readonly description = computed(() => {
    const n = this.total();
    const visible = this.shown().length;
    const noun = n === 1 ? 'repository' : 'repositories';
    return this.hasFilters() ? `${visible} of ${n} ${noun}` : `${n} ${noun}`;
  });

  protected create(): void {
    this.ui.openCreate('repository');
  }

  protected clearFilters(): void {
    this.search.set('');
    this.providerFilter.set([]);
    this.teamFilter.set([]);
    this.labelFilter.set([]);
  }
}
