import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucidePlus, LucideSearch, LucideUsers } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore, UiStore } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Kbd } from '../../shared/kbd';
import { KeyChip } from '../../shared/key-chip';
import { PageHeader } from '../../shared/page-header';

@Component({
  selector: 'app-team-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, PageHeader, Kbd, EmptyState, KeyChip, TopBarActions],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canAdmin()) {
        <button hlmBtn size="sm" (click)="create()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span class="max-sm:hidden">New team</span>
          <app-kbd keys="c" class="opacity-70 max-sm:hidden" />
        </button>
      }
    </ng-template>

    <app-page-header title="Teams" [description]="description()" />

    <div class="border-b px-4 py-2 sm:px-6">
      <div class="relative w-full sm:w-52">
        <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
        <input hlmInput class="h-7 w-full pl-8 text-xs" placeholder="Search teams…" aria-label="Search teams" [value]="search()" (input)="search.set($any($event.target).value)" />
      </div>
    </div>

    @if (total() === 0) {
      <app-empty-state [icon]="users" title="No teams yet" description="Teams own workstreams. Their key becomes the prefix, like AUTH-12.">
        @if (canAdmin()) {
          <button hlmBtn size="sm" (click)="create()"><svg [lucideIcon]="plus" [size]="14"></svg>New team</button>
        }
      </app-empty-state>
    } @else if (shown().length === 0) {
      <app-empty-state [icon]="searchIcon" title="No teams match" description="Try another name or key." />
    } @else {
      <div class="min-h-0 flex-1 overflow-y-auto" role="list">
        @for (t of shown(); track t.id) {
          <a
            [routerLink]="['/', slug(), 'teams', t.key]"
            [attr.data-row-id]="t.id"
            class="hover:bg-muted/60 focus-visible:bg-muted/60 flex items-center gap-3 border-b px-4 py-2 outline-none sm:px-6"
            [class.bg-muted]="ui.focusedRowId() === t.id"
          >
            <span class="size-2.5 shrink-0 rounded-full" [style.background]="t.color"></span>
            <span class="min-w-0 flex-1 truncate text-sm">{{ t.name }}</span>
            <app-key-chip [value]="t.key" />
            <span class="text-muted-foreground w-24 shrink-0 text-right text-xs tabular-nums">{{ t.memberIds.length }} members</span>
            <span class="text-muted-foreground hidden w-28 shrink-0 text-right text-xs tabular-nums sm:inline">{{ owned(t.id) }} workstreams</span>
          </a>
        }
      </div>
    }
  `,
})
export class TeamListPage {
  readonly workspaceSlug = input<string>();

  private readonly store = inject(NablaStore);
  protected readonly ui = inject(UiStore);
  protected readonly plus = LucidePlus;
  protected readonly searchIcon = LucideSearch;
  protected readonly users = LucideUsers;
  protected readonly search = signal('');
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly total = computed(() => this.store.teams().length);
  protected readonly shown = computed(() => {
    const q = this.search().trim().toLowerCase();
    return this.store
      .teams()
      .filter((t) => !q || `${t.name} ${t.key} ${t.description ?? ''}`.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  });
  protected readonly description = computed(() => {
    const n = this.total();
    return n === 1 ? '1 team' : `${n} teams`;
  });

  protected owned(id: string): number {
    return this.store.workstreamsByOwnerTeam().get(id)?.length ?? 0;
  }
  protected create(): void {
    this.ui.openCreate('team');
  }
}
