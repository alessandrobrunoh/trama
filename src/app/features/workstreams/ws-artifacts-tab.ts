import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { LucideDynamicIcon, LucideEllipsis, LucideExternalLink, LucidePackage, LucidePlus, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDialogImports } from '@spartan-ng/helm/dialog';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmLabelImports } from '@spartan-ng/helm/label';
import {
  ARTIFACT_KINDS,
  ARTIFACT_KIND_META,
  NablaStore,
  UiStore,
  type Artifact,
  type ArtifactKind,
  type ArtifactProvider,
  type ArtifactState,
  type CiState,
  type ReviewState,
  type Workstream,
} from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { ArtifactIcon, CiChip, ConflictChip, ReviewChip } from '../../shared/artifact';
import { EmptyState } from '../../shared/empty-state';
import { RelativeTimePipe } from '../../shared/pipes';
import { ProviderIcon, providerLabel } from '../../shared/provider-icon';
import { StatusBadge, statusLabel } from '../../shared/status';
import { Picker, type PickOption } from './picker';
import { ARTIFACT_GROUPS } from './ws-model';

const KIND_STATES: Record<ArtifactKind, ArtifactState[]> = {
  pull_request: ['draft', 'open', 'merged', 'closed'],
  merge_request: ['draft', 'open', 'merged', 'closed'],
  commit: ['merged', 'open', 'closed'],
  branch: ['open', 'merged', 'closed'],
  document: ['draft', 'published'],
  design: ['draft', 'published'],
  image: ['draft', 'published'],
  file: ['draft', 'published'],
  build: ['pending', 'running', 'succeeded', 'failed'],
  test_report: ['pending', 'running', 'succeeded', 'failed'],
  deployment: ['pending', 'running', 'healthy', 'degraded', 'failed'],
  release: ['draft', 'published'],
};
const PROVIDERS: ArtifactProvider[] = ['github', 'gitlab', 'delta', 'figma', 'docs', 'ci', 'other'];
const DEFAULT_PROVIDER: Partial<Record<ArtifactKind, ArtifactProvider>> = {
  pull_request: 'github',
  merge_request: 'gitlab',
  commit: 'github',
  branch: 'github',
  document: 'docs',
  design: 'figma',
  image: 'other',
  file: 'other',
  build: 'ci',
  test_report: 'ci',
  deployment: 'ci',
  release: 'github',
};

@Component({
  selector: 'app-ws-artifacts-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmDialogImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmLabelImports,
    LucideDynamicIcon,
    ActorAvatar,
    ArtifactIcon,
    CiChip,
    ReviewChip,
    ConflictChip,
    EmptyState,
    ProviderIcon,
    StatusBadge,
    RelativeTimePipe,
    Picker,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex items-center gap-2 border-b px-4 py-2 sm:px-6">
      <span class="text-muted-foreground text-xs">{{ all().length }} artifact{{ all().length === 1 ? '' : 's' }}</span>
      @if (canEdit()) {
        <button hlmBtn size="sm" class="ml-auto" (click)="openAttach()"><svg [lucideIcon]="plus" [size]="14"></svg>Attach artifact</button>
      }
    </div>

    @for (g of groups(); track g.id) {
      <section>
        <h2 class="bg-muted/40 flex min-h-8 items-center gap-2 border-b px-4 text-xs font-medium sm:px-6">
          {{ g.title }} <span class="text-muted-foreground font-normal tabular-nums">{{ g.items.length }}</span>
        </h2>
        @for (a of g.items; track a.id) {
          <div class="hover:bg-muted/40 group flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 sm:px-6">
            <span class="flex min-w-0 flex-1 items-center gap-2.5 max-sm:basis-full">
              <app-artifact-icon [kind]="a.kind" [state]="a.state" [size]="16" />
              @if (a.externalId) {
                <span class="text-muted-foreground shrink-0 font-mono text-xs">{{ a.externalId }}</span>
              }
              @if (a.url) {
                <a [href]="a.url" target="_blank" rel="noopener" class="min-w-0 truncate text-sm hover:underline">{{ a.title }}</a>
                <svg [lucideIcon]="ext" [size]="11" class="text-muted-foreground shrink-0"></svg>
              } @else {
                <span class="min-w-0 truncate text-sm">{{ a.title }}</span>
              }
            </span>
            <span class="flex flex-wrap items-center gap-1.5 max-sm:pl-[26px]">
              <app-status-badge [status]="a.state" />
              @if (a.ci) {
                <app-ci-chip [ci]="a.ci" />
              }
              @if (a.review) {
                <app-review-chip [review]="a.review" />
              }
              @if (a.hasConflicts) {
                <app-conflict-chip />
              }
              @if (a.environment) {
                <span class="text-muted-foreground bg-muted rounded-md px-1.5 py-0.5 font-mono text-[11px]">{{ a.environment }}</span>
              }
            </span>
            <span class="text-muted-foreground flex items-center gap-2 text-xs max-sm:pl-[26px]">
              @if (repoName(a); as r) {
                <span class="inline-flex items-center gap-1 max-lg:hidden"><app-provider-icon [provider]="repoProvider(a)" [size]="12" />{{ r }}</span>
              }
              <span class="max-sm:hidden">{{ a.updatedAt | relativeTime }}</span>
              @if (a.authorRef) {
                <app-actor-avatar [actor]="a.authorRef" [size]="18" />
              }
            </span>
            @if (canEdit()) {
              <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground size-7" [hlmDropdownMenuTrigger]="menu" aria-label="Artifact actions">
                <svg [lucideIcon]="more" [size]="15"></svg>
              </button>
              <ng-template #menu>
                <hlm-dropdown-menu class="w-48">
                  <hlm-dropdown-menu-label>Set state</hlm-dropdown-menu-label>
                  <hlm-dropdown-menu-group>
                    @for (s of statesFor(a.kind); track s) {
                      <button hlmDropdownMenuItem (triggered)="setState(a, s)">{{ stateLabel(s) }}</button>
                    }
                  </hlm-dropdown-menu-group>
                  <hlm-dropdown-menu-separator />
                  <button hlmDropdownMenuItem variant="destructive" (triggered)="remove(a)"><svg [lucideIcon]="trash" [size]="14"></svg>Remove</button>
                </hlm-dropdown-menu>
              </ng-template>
            }
          </div>
        }
      </section>
    } @empty {
      <app-empty-state [icon]="pkg" title="No artifacts yet" description="Pull requests, documents, builds and deployments show up here, linked by branch name, PR title or manually.">
        @if (canEdit()) {
          <button hlmBtn size="sm" (click)="openAttach()">Attach artifact</button>
        }
      </app-empty-state>
    }

    <hlm-dialog [state]="attachOpen() ? 'open' : 'closed'" (closed)="attachOpen.set(false)">
      <hlm-dialog-content *hlmDialogPortal="let ctx" class="max-h-[92svh] overflow-y-auto sm:max-w-lg" (keydown.meta.enter)="attach()">
        <hlm-dialog-header>
          <h2 hlmDialogTitle>Attach artifact</h2>
          <p hlmDialogDescription>Link something that was produced or delivered by this workstream.</p>
        </hlm-dialog-header>
        <div class="grid gap-3">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Kind</label>
              <app-picker label="Kind" [searchable]="false" [options]="kindOptions" [value]="[kind()]" (valueChange)="setKind($event[0])" />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>Provider</label>
              <app-picker label="Provider" [searchable]="false" [options]="providerOptions" [value]="[provider()]" (valueChange)="provider.set($any($event[0] ?? 'other'))" />
            </div>
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="aa-title">Title</label>
            <input hlmInput id="aa-title" autocomplete="off" placeholder="Add scheduled JWT key rotation" [value]="title()" (input)="title.set($any($event.target).value)" />
          </div>
          <div class="grid gap-1.5">
            <label hlmLabel for="aa-url">URL</label>
            <input hlmInput id="aa-url" autocomplete="off" placeholder="https://github.com/acme/api/pull/171" [value]="url()" (input)="url.set($any($event.target).value)" />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-1.5">
              <label hlmLabel for="aa-ext">External id</label>
              <input hlmInput id="aa-ext" autocomplete="off" placeholder="#171, sha, ADR-21…" [value]="externalId()" (input)="externalId.set($any($event.target).value)" />
            </div>
            <div class="grid min-w-0 gap-1.5">
              <label hlmLabel>State</label>
              <app-picker label="State" [searchable]="false" [options]="stateOptions()" [value]="[state()]" (valueChange)="state.set($any($event[0] ?? 'open'))" />
            </div>
          </div>
          @if (kind() === 'deployment' || kind() === 'release') {
            <div class="grid gap-1.5">
              <label hlmLabel for="aa-env">Environment</label>
              <input hlmInput id="aa-env" autocomplete="off" placeholder="staging, production…" [value]="environment()" (input)="environment.set($any($event.target).value)" />
            </div>
          }
          @if (isPrKind()) {
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid min-w-0 gap-1.5">
                <label hlmLabel>CI</label>
                <app-picker label="CI" [searchable]="false" [clearable]="true" clearLabel="Unknown" placeholder="Unknown" [options]="ciOptions" [value]="ci() ? [ci()] : []" (valueChange)="ci.set($any($event[0] ?? ''))" />
              </div>
              <div class="grid min-w-0 gap-1.5">
                <label hlmLabel>Review</label>
                <app-picker label="Review" [searchable]="false" [options]="reviewOptions" [value]="[review()]" (valueChange)="review.set($any($event[0] ?? 'none'))" />
              </div>
            </div>
          }
        </div>
        <hlm-dialog-footer>
          <button hlmBtn variant="outline" hlmDialogClose type="button">Cancel</button>
          <button hlmBtn type="button" [disabled]="!title().trim() || busy()" (click)="attach()">Attach</button>
        </hlm-dialog-footer>
      </hlm-dialog-content>
    </hlm-dialog>
  `,
})
export class WsArtifactsTab {
  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  readonly ws = input.required<Workstream>();

  protected readonly plus = LucidePlus;
  protected readonly more = LucideEllipsis;
  protected readonly ext = LucideExternalLink;
  protected readonly trash = LucideTrash2;
  protected readonly pkg = LucidePackage;
  protected readonly stateLabel = statusLabel;
  protected readonly canEdit = computed(() => this.store.can('member'));
  protected readonly all = computed(() => this.store.artifactsByWorkstream().get(this.ws().id) ?? []);
  protected readonly groups = computed(() => {
    const all = this.all();
    return ARTIFACT_GROUPS.map((g) => ({
      id: g.id,
      title: g.title,
      items: all
        .filter((a) => g.kinds.includes(a.kind))
        .sort((a, b) => g.kinds.indexOf(a.kind) - g.kinds.indexOf(b.kind) || (a.updatedAt < b.updatedAt ? 1 : -1)),
    })).filter((g) => g.items.length > 0);
  });

  // attach form
  protected readonly attachOpen = signal(false);
  protected readonly busy = signal(false);
  protected readonly kind = signal<ArtifactKind>('pull_request');
  protected readonly provider = signal<ArtifactProvider>('github');
  protected readonly title = signal('');
  protected readonly url = signal('');
  protected readonly externalId = signal('');
  protected readonly state = signal<ArtifactState>('open');
  protected readonly environment = signal('');
  protected readonly ci = signal<CiState | ''>('');
  protected readonly review = signal<ReviewState>('none');
  protected readonly kindOptions: PickOption[] = ARTIFACT_KINDS.map((k) => ({ value: k, label: ARTIFACT_KIND_META[k].label }));
  protected readonly providerOptions: PickOption[] = PROVIDERS.map((p) => ({ value: p, label: providerLabel(p), kind: 'provider' }));
  protected readonly ciOptions: PickOption[] = (['pending', 'passing', 'failing'] as const).map((c) => ({ value: c, label: statusLabel(c), kind: 'status' }));
  protected readonly reviewOptions: PickOption[] = [
    { value: 'none', label: 'No review' },
    { value: 'requested', label: 'Review requested' },
    { value: 'approved', label: 'Approved' },
    { value: 'changes_requested', label: 'Changes requested' },
  ];
  protected readonly stateOptions = computed<PickOption[]>(() =>
    KIND_STATES[this.kind()].map((s) => ({ value: s, label: statusLabel(s), kind: 'status' })),
  );
  protected readonly isPrKind = computed(() => this.kind() === 'pull_request' || this.kind() === 'merge_request');

  constructor() {
    effect(() => {
      if (!this.attachOpen()) return;
      untracked(() => this.resetForm());
    });
  }

  protected statesFor(k: ArtifactKind): ArtifactState[] {
    return KIND_STATES[k];
  }

  protected repoName(a: Artifact): string | undefined {
    return this.store.getRepository(a.repositoryId)?.fullName;
  }
  protected repoProvider(a: Artifact) {
    return this.store.getRepository(a.repositoryId)?.provider ?? 'github';
  }

  protected openAttach(): void {
    this.attachOpen.set(true);
  }

  private resetForm(): void {
    this.kind.set('pull_request');
    this.provider.set('github');
    this.title.set('');
    this.url.set('');
    this.externalId.set('');
    this.state.set('open');
    this.environment.set('');
    this.ci.set('');
    this.review.set('none');
    this.busy.set(false);
  }

  protected setKind(k: string | undefined): void {
    if (!k) return;
    const kind = k as ArtifactKind;
    this.kind.set(kind);
    this.provider.set(DEFAULT_PROVIDER[kind] ?? 'other');
    this.state.set(KIND_STATES[kind][kind === 'pull_request' || kind === 'merge_request' ? 1 : 0]);
  }

  protected setState(a: Artifact, s: ArtifactState): void {
    void this.store.updateArtifact(a.id, { state: s });
  }

  protected remove(a: Artifact): void {
    this.ui.setConfirmDelete({
      title: `Remove “${a.title}”?`,
      description: 'The artifact is unlinked from this workstream. The external item is not touched.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.removeArtifact(a.id);
      },
    });
  }

  protected async attach(): Promise<void> {
    if (!this.title().trim() || this.busy()) return;
    this.busy.set(true);
    const pr = this.isPrKind();
    const created = await this.store.attachArtifact({
      workstreamId: this.ws().id,
      kind: this.kind(),
      provider: this.provider(),
      title: this.title().trim(),
      url: this.url().trim() || undefined,
      externalId: this.externalId().trim() || undefined,
      state: this.state(),
      environment: this.environment().trim() || undefined,
      ci: pr && this.ci() ? (this.ci() as CiState) : undefined,
      review: pr ? this.review() : undefined,
    });
    this.busy.set(false);
    if (created) this.attachOpen.set(false);
  }
}

