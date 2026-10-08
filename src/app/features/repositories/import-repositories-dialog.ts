import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucidePlug, LucidePlus } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import type { Repository } from '../../core/contracts/domain';
import { Notifier } from '../../core/notify/notifier';
import { NablaStore } from '../../core/stores/nabla.store';
import { UiStore } from '../../core/stores/ui.store';
import { ProviderIcon } from '../../shared/provider-icon';
import { Picker } from '../workstreams/picker';
import { teamOptions } from '../workstreams/ws-model';
import { RemoteRepoBrowser } from './remote-repo-browser';

/**
 * "Import from GitHub / GitLab": pick a connection, optionally the teams for new projects, then link
 * repositories the token can see. Falls back to the manual "New project" form.
 *   <app-import-repositories-dialog [open]="importOpen()" (closed)="importOpen.set(false)" />
 */
@Component({
  selector: 'app-import-repositories-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmDialogImports, LucideDynamicIcon, ProviderIcon, Picker, RemoteRepoBrowser],
  template: `
    <hlm-dialog [state]="open() ? 'open' : 'closed'" (closed)="closed.emit()">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="flex max-h-[85svh] flex-col gap-4 sm:max-w-xl">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Import projects</h2>
          <p hlmDialogDescription>Link repositories from a connected GitHub or GitLab account. Pull requests and CI then flow in through the webhook.</p>
        </hlm-dialog-header>

        @if (connections().length) {
          <div class="flex flex-col gap-1.5">
            <span class="text-muted-foreground text-xs font-medium">Connection</span>
            <div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Connection">
              @for (c of connections(); track c.id) {
                <button
                  type="button"
                  role="radio"
                  class="hover:bg-accent flex h-8 items-center gap-2 rounded-md border px-2.5 text-[13px] transition-colors"
                  [class]="selectedId() === c.id ? 'border-foreground/40 bg-accent' : 'border-border'"
                  [attr.aria-checked]="selectedId() === c.id"
                  (click)="selectedId.set(c.id)"
                >
                  <app-provider-icon [provider]="c.provider" [size]="14" />
                  <span class="font-medium">{{ c.account }}</span>
                  @if (c.baseUrl) {
                    <span class="text-muted-foreground text-xs">{{ host(c.baseUrl) }}</span>
                  }
                  @if (c.status !== 'connected') {
                    <span class="text-destructive text-xs">{{ c.status }}</span>
                  }
                </button>
              }
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <span class="text-muted-foreground text-xs font-medium">Assign new projects to</span>
            <app-picker variant="chip" label="Teams" [multiple]="true" [options]="teams()" [value]="teamIds()" (valueChange)="teamIds.set($event)" />
          </div>

          @if (selectedId(); as id) {
            <app-remote-repo-browser class="min-h-0 flex-1" [connectionId]="id" [teamIds]="teamIds()" maxHeight="min(22rem, 45svh)" (linked)="onLinked($event)" />
          }
        } @else {
          <div class="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-8 text-center">
            <span class="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-lg">
              <svg [lucideIcon]="plug" [size]="18" [strokeWidth]="1.5"></svg>
            </span>
            <div>
              <p class="text-[13px] font-medium">No GitHub or GitLab connection</p>
              <p class="text-muted-foreground mt-1 text-xs">Connect an account with a token to browse and import its repositories.</p>
            </div>
            <a hlmBtn size="sm" [routerLink]="['/', slug(), 'settings', 'integrations']" (click)="closed.emit()">Connect GitHub or GitLab</a>
          </div>
        }

        <div class="text-muted-foreground flex items-center justify-between gap-2 border-t pt-3 text-xs">
          <span>{{ linkedCount() ? linkedCount() + ' linked in this session' : 'Repository not listed?' }}</span>
          <span class="flex items-center gap-1">
            <button hlmBtn variant="ghost" size="sm" class="h-7" (click)="manual()">
              <svg [lucideIcon]="plus" [size]="13"></svg> Add manually
            </button>
            <button hlmBtn variant="outline" size="sm" class="h-7" (click)="closed.emit()">Done</button>
          </span>
        </div>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class ImportRepositoriesDialog {
  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly notifier = inject(Notifier);

  readonly open = input(false);
  readonly closed = output<void>();

  protected readonly plug = LucidePlug;
  protected readonly plus = LucidePlus;
  protected readonly selectedId = signal<string | null>(null);
  protected readonly teamIds = signal<string[]>([]);
  protected readonly linkedCount = signal(0);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly connections = computed(() =>
    this.store.integrations().filter((c) => c.provider === 'github' || c.provider === 'gitlab'),
  );

  constructor() {
    effect(() => {
      if (!this.open()) return;
      untracked(() => {
        this.linkedCount.set(0);
        void this.store.loadIntegrationDetails();
      });
    });
    // Keep a valid selection (first healthy connection) as connections load or change.
    effect(() => {
      const list = this.connections();
      untracked(() => {
        const current = this.selectedId();
        if (!current || !list.some((c) => c.id === current)) {
          this.selectedId.set((list.find((c) => c.status === 'connected') ?? list[0])?.id ?? null);
        }
      });
    });
  }

  protected host(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  protected onLinked(repo: Repository): void {
    this.linkedCount.update((n) => n + 1);
    const slug = this.slug();
    this.notifier.success(`Linked ${repo.fullName}`, {
      action: { label: 'Open', run: () => void this.router.navigate(['/', slug, 'projects', repo.id]) },
    });
  }

  protected manual(): void {
    this.closed.emit();
    this.ui.openCreate('repository');
  }
}
