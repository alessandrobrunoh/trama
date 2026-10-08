import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideDynamicIcon, LucideLock, LucideRefreshCw, LucideSearch } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { ApiError } from '../../core/api/api-error';
import type { RemoteRepository } from '../../core/api/api.types';
import type { Repository } from '../../core/contracts/domain';
import { NablaStore } from '../../core/stores/nabla.store';

/**
 * Lists the repositories a GitHub / GitLab connection can see (`GET /integrations/:id/remote-repositories`)
 * and links them as projects (`POST /integrations/:id/link-repository`). Used by Settings → Integrations
 * and the Projects "Import" dialog.
 *   <app-remote-repo-browser [connectionId]="c.id" [teamIds]="teams()" (linked)="onLinked($event)" />
 */
@Component({
  selector: 'app-remote-repo-browser',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, HlmSpinner, LucideDynamicIcon],
  host: { class: 'flex min-h-0 flex-col' },
  template: `
    <div class="relative mb-2">
      <svg [lucideIcon]="searchIcon" [size]="14" class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"></svg>
      <input
        hlmInput
        class="h-8 w-full pl-8 text-[13px]"
        placeholder="Filter repositories…"
        aria-label="Filter repositories"
        [value]="filter()"
        (input)="filter.set($any($event.target).value)"
      />
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto rounded-md border" [style.max-height]="maxHeight()">
      @if (error(); as e) {
        <div class="flex flex-col items-center gap-2 px-4 py-8 text-center">
          <p class="text-destructive text-[13px]">{{ e }}</p>
          <button hlmBtn size="sm" variant="outline" (click)="reload()">
            <svg [lucideIcon]="refresh" [size]="13"></svg> Try again
          </button>
        </div>
      } @else if (loading() && !items().length) {
        <div class="text-muted-foreground flex items-center justify-center gap-2 py-10 text-[13px]"><hlm-spinner class="size-4" /> Loading repositories…</div>
      } @else {
        <ul class="divide-y">
          @for (r of shown(); track r.fullName) {
            <li class="flex items-center gap-3 px-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-1.5">
                  <span class="truncate font-mono text-[13px]">{{ r.fullName }}</span>
                  @if (r.private) {
                    <svg [lucideIcon]="lock" [size]="11" class="text-muted-foreground shrink-0" aria-label="Private"></svg>
                  }
                </div>
                <div class="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
                  <span class="shrink-0 font-mono">{{ r.defaultBranch }}</span>
                  @if (r.description) {
                    <span class="truncate">· {{ r.description }}</span>
                  }
                </div>
              </div>
              @if (isLinked(r); as id) {
                <a class="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 text-xs" [routerLink]="['/', slug(), 'projects', id]">
                  <svg [lucideIcon]="check" [size]="13" class="text-status-shipped"></svg> Linked
                </a>
              } @else {
                <button hlmBtn size="sm" variant="outline" class="h-7 shrink-0" [disabled]="linking().has(r.fullName)" (click)="link(r)">
                  @if (linking().has(r.fullName)) {
                    <hlm-spinner class="size-3.5" />
                  }
                  {{ r.linked ? 'Attach' : 'Link' }}
                </button>
              }
            </li>
          } @empty {
            <li class="text-muted-foreground px-3 py-8 text-center text-[13px]">
              {{ filter().trim() ? 'No loaded repository matches “' + filter().trim() + '”.' : 'This token cannot see any repository.' }}
            </li>
          }
        </ul>
        @if (hasMore()) {
          <div class="border-t p-2 text-center">
            <button hlmBtn size="sm" variant="ghost" class="text-muted-foreground" [disabled]="loading()" (click)="more()">
              @if (loading()) {
                <hlm-spinner class="size-3.5" />
              }
              Load more
            </button>
          </div>
        }
      }
    </div>
  `,
})
export class RemoteRepoBrowser {
  private readonly store = inject(NablaStore);

  readonly connectionId = input.required<string>();
  /** Teams assigned to newly created projects. */
  readonly teamIds = input<readonly string[]>([]);
  readonly maxHeight = input('22rem');
  readonly linked = output<Repository>();

  protected readonly searchIcon = LucideSearch;
  protected readonly lock = LucideLock;
  protected readonly check = LucideCheck;
  protected readonly refresh = LucideRefreshCw;

  protected readonly filter = signal('');
  protected readonly items = signal<RemoteRepository[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly hasMore = signal(false);
  protected readonly linking = signal<ReadonlySet<string>>(new Set());
  /** fullName (lower case) → project id, for repositories linked in this session. */
  private readonly justLinked = signal<ReadonlyMap<string, string>>(new Map());
  private page = 1;
  private gen = 0;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly shown = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.items();
    return q ? list.filter((r) => `${r.fullName} ${r.description ?? ''}`.toLowerCase().includes(q)) : list;
  });

  constructor() {
    effect(() => {
      this.connectionId();
      untracked(() => this.reload());
    });
  }

  /** Project id when the repository is attached to this connection (or exists and was linked here). */
  protected isLinked(r: RemoteRepository): string | null {
    const mine = this.justLinked().get(r.fullName.toLowerCase());
    if (mine) return mine;
    if (!r.linked || !r.repositoryId) return null;
    const conn = this.store.integrationDetails().find((c) => c.id === this.connectionId());
    // Without details (non-admin view) treat an existing project as linked.
    return !conn || conn.repositoryIds.includes(r.repositoryId) ? r.repositoryId : null;
  }

  protected reload(): void {
    this.page = 1;
    this.items.set([]);
    void this.load(1);
  }

  protected more(): void {
    void this.load(this.page + 1);
  }

  private async load(page: number): Promise<void> {
    const gen = ++this.gen;
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.store.remoteRepositories(this.connectionId(), page, 50);
      if (gen !== this.gen) return;
      this.page = res.page;
      this.hasMore.set(res.hasMore);
      this.items.update((cur) => (page === 1 ? res.items : [...cur, ...res.items]));
    } catch (e) {
      if (gen === this.gen) this.error.set(ApiError.from(e).message || 'Could not load repositories.');
    } finally {
      if (gen === this.gen) this.loading.set(false);
    }
  }

  protected async link(r: RemoteRepository): Promise<void> {
    this.linking.update((s) => new Set([...s, r.fullName]));
    const teamIds = this.teamIds();
    const repo = await this.store.linkRepository(this.connectionId(), {
      fullName: r.fullName,
      teamIds: teamIds.length ? [...teamIds] : undefined,
    });
    this.linking.update((s) => {
      const next = new Set(s);
      next.delete(r.fullName);
      return next;
    });
    if (repo) {
      this.justLinked.update((m) => new Map([...m, [r.fullName.toLowerCase(), repo.id]]));
      this.items.update((list) => list.map((x) => (x.fullName === r.fullName ? { ...x, linked: true, repositoryId: repo.id } : x)));
      this.linked.emit(repo);
    }
  }
}
