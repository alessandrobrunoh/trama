import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  LucideCopy,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideExternalLink,
  LucideFolderGit2,
  LucideHexagon,
  LucidePlug,
  LucideTrash2,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { NablaStore, UiStore, type Artifact, type DomainEvent, type Issue } from '../../core';
import { Clipboard } from '../../core/notify/notifier';
import { TopBarActions, usePageCrumbs } from '../../layout/page-chrome';
import { EmptyState } from '../../shared/empty-state';
import { PropertyRow } from '../../shared/property-row';
import { ProviderIcon, providerLabel } from '../../shared/provider-icon';
import { RelativeTimePipe } from '../../shared/pipes';
import { StatusBadge } from '../../shared/status';
import { EventLine } from '../overview/event-line';
import { IssueRow } from '../issues/issue-items';
import { StatsBoard } from '../stats/stats-board';
import { repositoryStats } from '../stats/stats-model';
import { CommentThread } from '../workstreams/comments';
import { InlineText } from '../workstreams/inline-edit';
import { Picker } from '../workstreams/picker';
import { buildSummary, labelOptions, teamOptions } from '../workstreams/ws-model';
import { WorkstreamRow } from '../workstreams/workstream-items';

const ACTIVITY_CAP = 20;
const ARTIFACT_CAP = 12;

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
    RelativeTimePipe,
    CommentThread,
    InlineText,
    Picker,
    WorkstreamRow,
    IssueRow,
    EventLine,
    StatsBoard,
  ],
  host: { class: 'flex min-h-full min-w-0 flex-col' },
  template: `
    @if (repo(); as r) {
      <ng-template appTopBarActions>
        @if (r.url) {
          <a hlmBtn variant="outline" size="sm" [href]="r.url" target="_blank" rel="noopener noreferrer">
            <svg [lucideIcon]="external" [size]="13"></svg> <span class="max-sm:hidden">Open in {{ providerName() }}</span>
          </a>
        }
        <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="more" aria-label="Repository actions">
          <svg [lucideIcon]="moreIcon" [size]="16"></svg>
        </button>
        <ng-template #more>
          <hlm-dropdown-menu class="w-48">
            @if (r.url) {
              <button hlmDropdownMenuItem (triggered)="copy(r.url, 'Repository URL copied')">
                <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy repository URL
              </button>
            }
            <button hlmDropdownMenuItem (triggered)="copy(r.fullName, 'Name copied')">
              <svg [lucideIcon]="copyIcon" [size]="14"></svg> Copy name
            </button>
            @if (canAdmin()) {
              <button hlmDropdownMenuItem variant="destructive" (triggered)="remove()">
                <svg [lucideIcon]="trash" [size]="14"></svg> Delete repository
              </button>
            }
          </hlm-dropdown-menu>
        </ng-template>
      </ng-template>

      <header class="border-b px-4 pt-5 pb-4 sm:px-6">
        <div class="flex min-w-0 items-center gap-2.5">
          <app-provider-icon [provider]="r.provider" [size]="18" />
          <h1 class="min-w-0 truncate font-mono text-xl font-semibold tracking-tight">
            <span class="text-muted-foreground font-normal">{{ owner() }}/</span>{{ name() }}
          </h1>
        </div>
        <p class="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 text-xs">
          <span>{{ providerName() }}</span>
          <span>·</span>
          <span class="font-mono">{{ r.defaultBranch }}</span>
          @if (connection(); as c) {
            <span>·</span>
            <span class="flex items-center gap-1"><svg [lucideIcon]="plug" [size]="11"></svg> Synced via {{ c.account }}</span>
          }
          <span>·</span>
          <span>{{ workstreams().length }} workstreams · {{ artifacts().length }} artifacts</span>
        </p>
      </header>

      <div class="grid min-w-0 grid-cols-1 gap-x-10 gap-y-6 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div class="flex min-w-0 flex-col gap-8">
          <section aria-label="Repository statistics">
            <app-stats-board [model]="stats()" />
          </section>

          <section class="min-w-0">
            <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
              Workstreams <span class="text-muted-foreground font-normal tabular-nums">{{ workstreams().length }}</span>
            </h2>
            @if (workstreams().length) {
              <div class="-mx-4 border-t sm:-mx-6">
                @for (s of workstreams(); track s.ws.id) {
                  <app-workstream-row [summary]="s" />
                }
              </div>
            } @else {
              <div class="text-muted-foreground flex items-center gap-2 rounded-md border border-dashed px-3 py-4 text-[13px]">
                <svg [lucideIcon]="hexagon" [size]="15" [strokeWidth]="1.5"></svg>
                No workstream lands in this repository yet. Add it to a workstream's Repositories property.
              </div>
            }
          </section>

          @if (issues().length) {
            <section>
              <h2 class="mb-1 flex items-center gap-2 text-[13px] font-semibold">
                Issues <span class="text-muted-foreground font-normal tabular-nums">{{ issues().length }}</span>
                <span class="text-muted-foreground text-xs font-normal">· demand addressed by these workstreams</span>
              </h2>
              <div class="-mx-4 border-t sm:-mx-6">
                @for (i of issues(); track i.id) {
                  <app-issue-row [issue]="i" />
                }
              </div>
            </section>
          }

          <section>
            <h2 class="mb-2 flex items-center gap-2 text-[13px] font-semibold">
              Artifacts <span class="text-muted-foreground font-normal tabular-nums">{{ artifacts().length }}</span>
            </h2>
            @if (artifacts().length) {
              <div class="flex flex-col border-t">
                @for (a of shownArtifacts(); track a.id) {
                  <a
                    class="hover:bg-muted/60 -mx-2 flex min-w-0 items-center gap-2.5 rounded-md border-b border-transparent px-2 py-2.5 text-sm md:py-1.5 md:text-[13px]"
                    [routerLink]="['/', slug(), 'workstreams', workstreamKey(a.workstreamId)]"
                    [queryParams]="{ tab: 'artifacts' }"
                  >
                    <app-status-badge [status]="a.state" />
                    <span class="min-w-0 flex-1 truncate">{{ a.title }}</span>
                    @if (a.externalId) {
                      <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ a.externalId }}</span>
                    }
                    <span class="text-muted-foreground w-20 shrink-0 text-right font-mono text-xs max-sm:hidden">{{ workstreamKey(a.workstreamId) }}</span>
                    <span class="text-muted-foreground w-24 shrink-0 text-right text-xs whitespace-nowrap max-sm:hidden">{{ a.updatedAt | relativeTime }}</span>
                  </a>
                }
              </div>
              @if (artifacts().length > artifactCap && !allArtifacts()) {
                <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground mt-1" (click)="allArtifacts.set(true)">
                  Show all {{ artifacts().length }}
                </button>
              }
            } @else {
              <p class="text-muted-foreground text-[13px]">No pull requests or deployments linked here yet. Once the repository is linked to an integration, webhook events create them.</p>
            }
          </section>

          <section>
            <h2 class="mb-1 text-[13px] font-semibold">Activity</h2>
            @if (activity().length) {
              <div class="flex flex-col">
                @for (e of shownActivity(); track e.id) {
                  <app-event-line [event]="e" [slug]="slug()" />
                }
              </div>
              @if (activity().length > activityCap && !allActivity()) {
                <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground mt-1" (click)="allActivity.set(true)">
                  Show all {{ activity().length }}
                </button>
              }
            } @else {
              <p class="text-muted-foreground text-[13px]">Nothing has happened here in the recent history.</p>
            }
          </section>

          <section>
            <h2 class="mb-2 text-[13px] font-semibold">Comments</h2>
            <app-comment-thread [subject]="{ type: 'repository', id: r.id }" />
          </section>
        </div>

        <aside class="flex min-w-0 flex-col gap-0.5 lg:sticky lg:top-4 lg:self-start">
          <h2 class="text-muted-foreground mb-1 text-xs font-medium">Properties</h2>
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
            @if (r.url) {
              <button hlmBtn variant="ghost" size="icon-xs" class="text-muted-foreground shrink-0" aria-label="Copy URL" (click)="copy(r.url, 'Repository URL copied')">
                <svg [lucideIcon]="copyIcon" [size]="12"></svg>
              </button>
            }
          </app-property-row>
          <app-property-row label="Labels">
            <app-picker
              variant="field"
              label="Labels"
              placeholder="None"
              [multiple]="true"
              [disabled]="!canAdmin()"
              [options]="labels()"
              [value]="r.labels"
              (valueChange)="saveLabels($event)"
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
          @if (repoTeams().length) {
            <div class="flex flex-wrap gap-1.5 pb-1 pl-30">
              @for (t of repoTeams(); track t.id) {
                <a
                  class="border-border-strong hover:bg-accent inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs"
                  [routerLink]="['/', slug(), 'teams', t.key]"
                >
                  <span class="size-2 rounded-full" [style.background]="t.color"></span>{{ t.name }}
                </a>
              }
            </div>
          }
          <app-property-row label="Integration">
            @if (connection(); as c) {
              <a class="hover:bg-accent -mx-1.5 flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs" [routerLink]="['/', slug(), 'settings', 'integrations']">
                <app-provider-icon [provider]="c.provider" [size]="12" />
                <span class="truncate">{{ c.account }}</span>
                @if (c.lastWebhookAt) {
                  <span class="text-muted-foreground shrink-0">· {{ c.lastWebhookAt | relativeTime }}</span>
                }
              </a>
            } @else if (canAdmin()) {
              <a class="text-muted-foreground hover:text-foreground text-xs" [routerLink]="['/', slug(), 'settings', 'integrations']">Not linked · Connect</a>
            } @else {
              <span class="text-muted-foreground text-xs">Not linked</span>
            }
          </app-property-row>
          <app-property-row label="Added">
            <span class="text-muted-foreground text-xs">{{ r.createdAt | relativeTime }}</span>
          </app-property-row>
        </aside>
      </div>
    } @else {
      <app-empty-state [icon]="folder" title="Repository not found" description="It may have been deleted.">
        <a hlmBtn size="sm" variant="outline" [routerLink]="['/', slug(), 'repositories']">Back to repositories</a>
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
  private readonly clipboard = inject(Clipboard);

  protected readonly external = LucideExternalLink;
  protected readonly moreIcon = LucideEllipsis;
  protected readonly trash = LucideTrash2;
  protected readonly folder = LucideFolderGit2;
  protected readonly copyIcon = LucideCopy;
  protected readonly plug = LucidePlug;
  protected readonly hexagon = LucideHexagon;
  protected readonly activityCap = ACTIVITY_CAP;
  protected readonly artifactCap = ARTIFACT_CAP;
  protected readonly allActivity = signal(false);
  protected readonly allArtifacts = signal(false);

  protected readonly slug = computed(() => this.store.slug() ?? this.workspaceSlug() ?? '');
  protected readonly canAdmin = computed(() => this.store.allowed('manageRepositories'));
  protected readonly teams = computed(() => teamOptions(this.store));
  protected readonly labels = computed(() => labelOptions(this.store));
  protected readonly repo = computed(() => this.store.getRepository(this.id()));
  protected readonly providerName = computed(() => {
    const r = this.repo();
    return r ? providerLabel(r.provider) : '';
  });
  protected readonly owner = computed(() => {
    const n = this.repo()?.fullName ?? '';
    const i = n.lastIndexOf('/');
    return i > 0 ? n.slice(0, i) : '';
  });
  protected readonly name = computed(() => {
    const n = this.repo()?.fullName ?? '';
    return n.slice(n.lastIndexOf('/') + 1);
  });
  protected readonly repoTeams = computed(() =>
    (this.repo()?.teamIds ?? []).map((id) => this.store.teamById().get(id)).filter((t) => !!t),
  );
  /** The integration this repository is linked to (admin only: details are not in the snapshot). */
  protected readonly connection = computed(() => {
    const id = this.repo()?.id;
    return id ? this.store.integrationDetails().find((c) => c.repositoryIds.includes(id)) : undefined;
  });
  protected readonly stats = computed(() => {
    const id = this.repo()?.id;
    return id ? repositoryStats(this.store, id) : { cards: [], distributions: [] };
  });
  protected readonly workstreams = computed(() => {
    const id = this.repo()?.id;
    if (!id) return [];
    return (this.store.workstreamsByRepository().get(id) ?? []).map((ws) => buildSummary(this.store, ws));
  });
  protected readonly issues = computed(() => {
    const byWs = this.store.issuesByWorkstream();
    const seen = new Map<string, Issue>();
    for (const s of this.workstreams()) for (const i of byWs.get(s.ws.id) ?? []) seen.set(i.id, i);
    return [...seen.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  });
  protected readonly artifacts = computed(() => {
    const id = this.repo()?.id;
    if (!id) return [] as Artifact[];
    return [...(this.store.artifactsByRepository().get(id) ?? [])].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : -1,
    );
  });
  protected readonly shownArtifacts = computed(() =>
    this.allArtifacts() ? this.artifacts() : this.artifacts().slice(0, ARTIFACT_CAP),
  );
  /** Events on the repository itself plus on its artifacts, newest first. */
  protected readonly activity = computed(() => {
    const id = this.repo()?.id;
    if (!id) return [] as DomainEvent[];
    const by = this.store.eventsBySubject();
    const out: DomainEvent[] = [...(by.get(`repository:${id}`) ?? [])];
    for (const a of this.artifacts()) out.push(...(by.get(`artifact:${a.id}`) ?? []));
    return out.sort((a, b) => (a.at < b.at ? 1 : -1));
  });
  protected readonly shownActivity = computed(() =>
    this.allActivity() ? this.activity() : this.activity().slice(0, ACTIVITY_CAP),
  );

  private readonly _crumbs = usePageCrumbs(() => [
    { label: 'Repositories', link: ['/', this.slug(), 'repositories'] },
    { label: this.repo()?.fullName ?? this.id() ?? '', mono: true },
  ]);

  constructor() {
    // Integration details are admin-only and not in the snapshot: load once per workspace.
    effect(() => {
      if (this.store.ready() && this.canAdmin() && this.store.slug()) untracked(() => void this.store.loadIntegrationDetails());
    });
  }

  /** Key of the workstream an artifact belongs to; empty for artifacts attached to a project or issue only. */
  protected workstreamKey(id: string | undefined): string {
    return id ? (this.store.workstreamById().get(id)?.key ?? id) : '';
  }

  protected copy(text: string, title: string): void {
    void this.clipboard.copy(text, title);
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

  protected saveLabels(ids: string[]): void {
    const repo = this.repo();
    if (!repo) return;
    const same = ids.length === repo.labels.length && ids.every((id, i) => id === repo.labels[i]);
    if (same) return;
    void this.store.updateRepository(repo.id, { labels: ids });
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
      description: 'Workstreams keep their history. They just stop pointing at this repository.',
      onConfirm: async () => {
        const ok = await this.store.deleteRepository(repo.id);
        if (ok) await this.router.navigate(['/', this.slug(), 'repositories']);
      },
    });
  }
}
