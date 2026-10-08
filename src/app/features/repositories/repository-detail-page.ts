import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideEllipsis, LucideExternalLink, LucideFolderGit2, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { NablaStore, UiStore, type Artifact } from '../../core';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { PropertyRow } from '../../shared/property-row';
import { ProviderIcon, providerLabel } from '../../shared/provider-icon';
import { StatusBadge } from '../../shared/status';
import { CommentThread } from '../workstreams/comments';
import { InlineText } from '../workstreams/inline-edit';
import { Picker } from '../workstreams/picker';
import { buildSummary, teamOptions } from '../workstreams/ws-model';
import { WorkstreamRow } from '../workstreams/workstream-items';

@Component({
  selector: 'app-repository-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    LucideDynamicIcon,
    TopBarActions,
    EmptyState,
    PropertyRow,
    ProviderIcon,
    StatusBadge,
    CommentThread,
    InlineText,
    Picker,
    WorkstreamRow,
  ],
  host: { class: 'flex min-h-full flex-col' },
  template: `
    @if (repo(); as r) {
      <ng-template appTopBarActions>
        @if (r.url) {
          <a hlmBtn variant="outline" size="sm" [href]="r.url" target="_blank" rel="noopener noreferrer">
            Open <svg [lucideIcon]="external" [size]="13"></svg>
          </a>
        }
        @if (canAdmin()) {
          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="more" aria-label="Project actions">
            <svg [lucideIcon]="moreIcon" [size]="16"></svg>
          </button>
          <ng-template #more>
            <hlm-dropdown-menu class="w-44">
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete project
              </button>
            </hlm-dropdown-menu>
          </ng-template>
        }
      </ng-template>

      <header class="border-b px-4 pt-3 sm:px-6">
        <div class="flex min-w-0 items-center gap-2">
          <app-provider-icon [provider]="r.provider" [size]="16" />
          <h1 class="min-w-0 truncate font-mono text-lg font-semibold tracking-tight">{{ r.fullName }}</h1>
        </div>
        <p class="text-muted-foreground pb-3 text-xs">{{ providerName() }} · {{ r.defaultBranch }}</p>
      </header>

      <div class="grid gap-x-8 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="flex min-w-0 flex-col gap-8">
          <section>
            <h2 class="mb-1 text-sm font-semibold">Workstreams</h2>
            @if (workstreams().length) {
              <div class="-mx-4 sm:-mx-6">
                @for (s of workstreams(); track s.ws.id) {
                  <app-workstream-row [summary]="s" />
                }
              </div>
            } @else {
              <p class="text-muted-foreground text-sm">No workstream points at this project yet.</p>
            }
          </section>

          <section>
            <h2 class="mb-2 text-sm font-semibold">Artifacts</h2>
            @if (artifacts().length) {
              <div class="flex flex-col">
                @for (a of artifacts(); track a.id) {
                  <a
                    class="hover:bg-muted/60 flex items-center gap-2 border-b py-1.5 text-sm"
                    [routerLink]="['/', slug(), 'workstreams', workstreamKey(a.workstreamId)]"
                    [queryParams]="{ tab: 'artifacts' }"
                  >
                    <app-status-badge [status]="a.state" />
                    <span class="min-w-0 flex-1 truncate">{{ a.title }}</span>
                    @if (a.externalId) {
                      <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ a.externalId }}</span>
                    }
                  </a>
                }
              </div>
            } @else {
              <p class="text-muted-foreground text-sm">No pull requests, commits or other artifacts linked here.</p>
            }
          </section>

          <section>
            <h2 class="mb-2 text-sm font-semibold">Comments</h2>
            <app-comment-thread [subject]="{ type: 'repository', id: r.id }" />
          </section>
        </div>

        <aside class="flex flex-col lg:pt-1">
          <app-property-row label="Provider">
            <app-provider-icon [provider]="r.provider" [size]="14" [showLabel]="true" />
          </app-property-row>
          <app-property-row label="Default branch">
            <app-inline-text
              class="min-w-0 flex-1"
              label="default branch"
              textClass="font-mono text-xs"
              [mono]="true"
              [value]="r.defaultBranch"
              [canEdit]="canAdmin()"
              (save)="saveBranch($event)"
            />
          </app-property-row>
          <app-property-row label="URL">
            <app-inline-text
              class="min-w-0 flex-1"
              label="url"
              placeholder="https://…"
              textClass="truncate text-xs"
              [value]="r.url"
              [canEdit]="canAdmin()"
              (save)="saveUrl($event)"
            />
          </app-property-row>
          <app-property-row label="Teams">
            <app-picker
              variant="field"
              label="Teams"
              placeholder="No team"
              [multiple]="true"
              [disabled]="!canAdmin()"
              [options]="teams()"
              [value]="r.teamIds"
              (valueChange)="saveTeams($event)"
            />
          </app-property-row>
        </aside>
      </div>
    } @else {
      <app-empty-state [icon]="folder" title="Project not found" description="It may have been deleted.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'projects']">Back to projects</a>
      </app-empty-state>
    }
  `,
})
export class RepositoryDetailPage {
  /** From the parent `:workspaceSlug` route segment. */
  readonly workspaceSlug = input<string>();
  readonly id = input<string>();

  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);

  protected readonly external = LucideExternalLink;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly folder = LucideFolderGit2;

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly repo = computed(() => this.store.getRepository(this.id()));
  protected readonly providerName = computed(() => {
    const r = this.repo();
    return r ? providerLabel(r.provider) : '';
  });
  protected readonly workstreams = computed(() => {
    const id = this.repo()?.id;
    if (!id) return [];
    return (this.store.workstreamsByRepository().get(id) ?? []).map((ws) => buildSummary(this.store, ws));
  });
  protected readonly artifacts = computed(() => {
    const id = this.repo()?.id;
    if (!id) return [] as Artifact[];
    return [...(this.store.artifactsByRepository().get(id) ?? [])].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : -1,
    );
  });

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Projects', link: ['/', this.slug(), 'projects'] },
    { label: this.repo()?.fullName ?? this.id() ?? '', mono: true },
  ]);

  protected workstreamKey(id: string): string {
    return this.store.workstreamById().get(id)?.key ?? id;
  }

  protected saveBranch(value: string): void {
    const repo = this.repo();
    const next = value.trim();
    if (!repo || !next || next === repo.defaultBranch) return;
    void this.store.updateRepository(repo.id, { defaultBranch: next });
  }

  protected saveUrl(value: string): void {
    const repo = this.repo();
    const next = value.trim();
    if (!repo || !next || next === repo.url) return;
    void this.store.updateRepository(repo.id, { url: next });
  }

  protected saveTeams(ids: string[]): void {
    const repo = this.repo();
    if (!repo) return;
    const same = ids.length === repo.teamIds.length && ids.every((id, i) => id === repo.teamIds[i]);
    if (same) return;
    void this.store.updateRepository(repo.id, { teamIds: ids });
  }

  protected remove(): void {
    const repo = this.repo();
    if (!repo) return;
    this.ui.setConfirmDelete({
      title: `Delete ${repo.fullName}?`,
      description: 'Workstreams keep their history. They just stop pointing at this project.',
      onConfirm: async () => {
        const ok = await this.store.deleteRepository(repo.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'projects']);
      },
    });
  }
}
