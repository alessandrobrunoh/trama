import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  LucideCalendar,
  LucideDynamicIcon,
  LucideEllipsis,
  LucidePencil,
  LucidePlus,
  LucideRocket,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmTabsImports } from '@spartan-ng/helm/tabs';
import { TramaStore, UiStore, shortDate, type Release, type ReleasePipeline } from '../../core';
import { TopBarActions } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { Markdown } from '../../shared/markdown';
import { PageHeader } from '../../shared/page-header';
import { ReleasePipelineDialog, ReleaseFormDialog } from './release-dialogs';
import { changelogReleases, PIPELINE_TYPE_LABEL, sortReleases } from './release-model';
import { ReleaseStatusBadge } from './release-status';

type ReleaseView = 'releases' | 'changelog';

@Component({
  selector: 'app-release-list-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmTabsImports,
    LucideDynamicIcon,
    EmptyState,
    PageHeader,
    TopBarActions,
    Markdown,
    ReleaseStatusBadge,
    ReleasePipelineDialog,
    ReleaseFormDialog,
  ],
  host: { class: 'flex h-full min-h-0 flex-col' },
  template: `
    <ng-template appTopBarActions>
      @if (canEdit()) {
        <button hlmBtn variant="outline" size="sm" (click)="openPipeline()">
          <svg [lucideIcon]="plus" [size]="14"></svg>
          <span>Pipeline</span>
        </button>
        @if (pipeline()) {
          <button hlmBtn size="sm" (click)="openRelease()">
            <svg [lucideIcon]="plus" [size]="14"></svg>
            <span>Release</span>
          </button>
        }
      }
    </ng-template>

    <app-page-header title="Releases" [description]="description()">
      @if (pipelines().length) {
        <div class="px-4 sm:px-6">
          <hlm-tabs [tab]="pipelineTab()" (tabActivated)="selectPipeline($event)">
            <div class="scrollbar-none overflow-x-auto">
              <hlm-tabs-list class="h-8 w-max" aria-label="Release pipelines">
                @for (p of pipelines(); track p.id) {
                  <button [hlmTabsTrigger]="p.id" class="px-2.5">{{ p.name }}</button>
                }
              </hlm-tabs-list>
            </div>
          </hlm-tabs>
        </div>
        @if (pipeline(); as p) {
          <div class="flex flex-wrap items-center gap-2 border-b px-4 py-1.5 sm:px-6">
            <hlm-tabs [tab]="currentView()" (tabActivated)="selectView($event)">
              <hlm-tabs-list variant="line" class="-mb-px h-8 p-0">
                <button hlmTabsTrigger="releases" class="px-2">Releases</button>
                <button hlmTabsTrigger="changelog" class="px-2">Changelog</button>
              </hlm-tabs-list>
            </hlm-tabs>
            <span class="text-muted-foreground ms-auto text-xs">
              {{ typeLabel() }}
              @if (teamName()) {
                <span> · {{ teamName() }}</span>
              }
            </span>
            @if (canEdit()) {
              <button
                hlmBtn
                variant="ghost"
                size="icon-xs"
                class="text-muted-foreground"
                [hlmDropdownMenuTrigger]="pipelineMenu"
                aria-label="Pipeline actions"
              >
                <svg [lucideIcon]="moreIcon" [size]="14"></svg>
              </button>
              <ng-template #pipelineMenu>
                <hlm-dropdown-menu class="w-48">
                  <button hlmDropdownMenuItem (triggered)="openPipeline(p)">
                    <svg [lucideIcon]="pencil" [size]="14"></svg> Edit pipeline
                  </button>
                  <button
                    hlmDropdownMenuItem
                    variant="destructive"
                    [disabled]="pipelineHasActive()"
                    (triggered)="confirmDeletePipeline(p)"
                  >
                    <svg [lucideIcon]="trash" [size]="14"></svg> Delete pipeline
                  </button>
                </hlm-dropdown-menu>
              </ng-template>
            }
          </div>
        }
      }
    </app-page-header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      @if (store.status() === 'error') {
        <app-empty-state
          [icon]="releaseIcon"
          title="Could not load releases"
          description="The workspace failed to load. Check your connection and try again."
        >
          <button hlmBtn size="sm" variant="outline" (click)="retry()">Try again</button>
        </app-empty-state>
      } @else if (store.status() !== 'ready') {
        <p class="text-muted-foreground p-8 text-center text-sm" role="status">Loading releases…</p>
      } @else if (!pipelines().length) {
        <app-empty-state
          [icon]="releaseIcon"
          title="No pipelines yet"
          description="Create a pipeline, then add versions and attach issues to them."
        >
          @if (canEdit()) {
            <button hlmBtn size="sm" (click)="openPipeline()">
              <svg [lucideIcon]="plus" [size]="14"></svg>New pipeline
            </button>
          }
        </app-empty-state>
      } @else if (!pipeline()) {
        <p class="text-muted-foreground p-8 text-center text-sm" role="status">Loading pipeline…</p>
      } @else if (currentView() === 'changelog') {
        @if (changelog().length) {
          <ol class="mx-auto max-w-3xl px-4 py-6 sm:px-6">
            @for (r of changelog(); track r.id) {
              <li
                class="border-border grid gap-3 border-b py-6 last:border-b-0 sm:grid-cols-[9rem_1fr]"
              >
                <div class="text-muted-foreground text-xs sm:pt-1">
                  <a [routerLink]="releaseLink(r)" class="hover:text-foreground font-medium">{{
                    r.name
                  }}</a>
                  <div class="mt-1">{{ releasedLabel(r) }}</div>
                </div>
                <article class="min-w-0">
                  @if (r.notes?.trim()) {
                    <app-markdown [source]="r.notes!" />
                  } @else {
                    <p class="text-muted-foreground text-sm">No release notes.</p>
                  }
                </article>
              </li>
            }
          </ol>
        } @else {
          <app-empty-state
            [icon]="releaseIcon"
            title="No released versions yet"
            description="Completed releases in this pipeline appear here with their notes, newest first."
          />
        }
      } @else if (shown().length) {
        <ul role="list" aria-label="Releases">
          @for (r of shown(); track r.id) {
            <li>
              <a
                [routerLink]="releaseLink(r)"
                class="hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-ring flex min-h-16 items-center gap-3 border-b px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset sm:px-6 md:min-h-11 md:py-2"
              >
                <span class="min-w-0 flex-1">
                  <span class="flex min-w-0 items-center gap-2">
                    <span class="truncate text-sm font-medium">{{ r.name }}</span>
                    <app-release-status [status]="r.status" />
                  </span>
                  @if (r.notes?.trim()) {
                    <span class="text-muted-foreground mt-0.5 block truncate text-xs">{{
                      notePreview(r.notes!)
                    }}</span>
                  }
                </span>
                <span
                  class="text-muted-foreground hidden items-center gap-1.5 text-xs tabular-nums sm:flex"
                >
                  @if (r.targetAt) {
                    <svg [lucideIcon]="cal" [size]="12"></svg>
                    {{ shortDate(r.targetAt) }}
                  }
                </span>
                <span class="text-muted-foreground w-16 shrink-0 text-right text-xs tabular-nums">
                  {{ issueCount(r) }}
                </span>
              </a>
            </li>
          }
        </ul>
      } @else {
        <app-empty-state
          [icon]="releaseIcon"
          title="No releases in this pipeline"
          description="Add a version, then attach issues from the issue sidebar."
        >
          @if (canEdit()) {
            <button hlmBtn size="sm" (click)="openRelease()">
              <svg [lucideIcon]="plus" [size]="14"></svg>New release
            </button>
          }
        </app-empty-state>
      }
    </div>

    <app-release-pipeline-dialog
      [(open)]="pipelineOpen"
      [pipeline]="editingPipeline()"
      [(created)]="createdPipeline"
    />
    <app-release-form-dialog
      [(open)]="releaseOpen"
      [pipeline]="pipeline()"
      [release]="editingRelease()"
      [(created)]="createdRelease"
    />
  `,
})
export class ReleaseListPage {
  readonly workspaceSlug = input<string>();
  readonly pipelineId = input<string>();
  readonly view = input<string>();

  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly plus = LucidePlus;
  protected readonly cal = LucideCalendar;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly releaseIcon = LucideRocket;
  protected readonly shortDate = shortDate;

  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly pipelines = computed(() =>
    this.store
      .releasePipelines()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
  protected readonly pipeline = computed(() => {
    const id = this.pipelineId();
    return (id && this.store.getReleasePipeline(id)) || undefined;
  });
  protected readonly pipelineTab = computed(
    () => this.pipeline()?.id ?? this.pipelines()[0]?.id ?? '',
  );
  protected readonly currentView = computed<ReleaseView>(() =>
    this.view() === 'changelog' ? 'changelog' : 'releases',
  );
  protected readonly shown = computed(() => {
    const p = this.pipeline();
    if (!p) return [];
    return sortReleases(this.store.releasesByPipeline().get(p.id) ?? []);
  });
  protected readonly changelog = computed(() => changelogReleases(this.shown()));
  protected readonly typeLabel = computed(() => {
    const p = this.pipeline();
    return p ? PIPELINE_TYPE_LABEL[p.type] : '';
  });
  protected readonly teamName = computed(() => {
    const id = this.pipeline()?.teamId;
    return id ? this.store.getTeam(id)?.name : undefined;
  });
  protected readonly pipelineHasActive = computed(() =>
    this.shown().some((r) => r.status === 'draft' || r.status === 'released'),
  );
  protected readonly description = computed(() => {
    const n = this.pipelines().length;
    if (!n) return 'Pipelines group versions; issues ship in a release';
    return n === 1 ? '1 pipeline' : `${n} pipelines`;
  });

  protected readonly pipelineOpen = signal(false);
  protected readonly releaseOpen = signal(false);
  protected readonly editingPipeline = signal<ReleasePipeline | undefined>(undefined);
  protected readonly editingRelease = signal<Release | undefined>(undefined);
  protected readonly createdPipeline = signal<ReleasePipeline | undefined>(undefined);
  protected readonly createdRelease = signal<Release | undefined>(undefined);

  constructor() {
    effect(() => {
      const list = this.pipelines();
      const id = this.pipelineId();
      const slug = this.slug();
      if (!slug || this.store.status() !== 'ready' || !list.length) return;
      if (id && list.some((p) => p.id === id)) return;
      untracked(() => {
        void this.router.navigate(['/', slug, 'releases', list[0].id], {
          replaceUrl: true,
          queryParamsHandling: 'preserve',
        });
      });
    });
    effect(() => {
      const created = this.createdPipeline();
      const slug = this.slug();
      if (!created || !slug) return;
      untracked(() => {
        this.createdPipeline.set(undefined);
        void this.router.navigate(['/', slug, 'releases', created.id]);
      });
    });
    effect(() => {
      const created = this.createdRelease();
      const slug = this.slug();
      const pipelineId = this.pipeline()?.id;
      if (!created || !slug || !pipelineId) return;
      untracked(() => {
        this.createdRelease.set(undefined);
        void this.router.navigate(['/', slug, 'releases', pipelineId, created.id]);
      });
    });
  }

  protected retry(): void {
    void this.store.refetch();
  }

  protected issueCount(r: Release): string {
    const n = this.store.issuesByRelease().get(r.id)?.length ?? r.issueCount ?? 0;
    return n === 1 ? '1 issue' : `${n} issues`;
  }

  protected notePreview(notes: string): string {
    return notes.replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  protected releasedLabel(r: Release): string {
    return r.releasedAt ? shortDate(r.releasedAt) : '';
  }

  protected releaseLink(r: Release): string[] {
    return ['/', this.slug(), 'releases', r.pipelineId, r.id];
  }

  protected selectPipeline(id: unknown): void {
    if (typeof id !== 'string' || id === this.pipelineId()) return;
    void this.router.navigate(['/', this.slug(), 'releases', id], {
      queryParamsHandling: 'preserve',
    });
  }

  protected selectView(tab: unknown): void {
    if (tab !== 'releases' && tab !== 'changelog') return;
    if (tab === this.currentView()) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: tab === 'releases' ? null : tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected openPipeline(pipeline?: ReleasePipeline): void {
    this.editingPipeline.set(pipeline);
    this.pipelineOpen.set(true);
  }

  protected openRelease(release?: Release): void {
    this.editingRelease.set(release);
    this.releaseOpen.set(true);
  }

  protected confirmDeletePipeline(p: ReleasePipeline): void {
    if (this.pipelineHasActive()) return;
    this.ui.setConfirmDelete({
      title: `Delete ${p.name}?`,
      description: 'Canceled releases in this pipeline are removed. This cannot be undone.',
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const ok = await this.store.deleteReleasePipeline(p.id);
        if (!ok) return;
        const next = this.pipelines().find((x) => x.id !== p.id);
        void this.router.navigate(['/', this.slug(), 'releases', ...(next ? [next.id] : [])]);
      },
    });
  }
}
