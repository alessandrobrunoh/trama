import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  LucideArrowRight,
  LucideCheck,
  LucideDownload,
  LucideDynamicIcon,
  LucideGitBranch,
  LucideKeyRound,
  LucideLayers,
  LucidePlus,
  LucideRefreshCw,
  LucideRotateCw,
  LucideTrash2,
  LucideTriangleAlert,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmCheckbox } from '@spartan-ng/helm/checkbox';
import { ApiClient } from '../../../core/api/api-client';
import { ApiError } from '../../../core/api/api-error';
import {
  EXTERNAL_PROVIDER_META,
  EXTERNAL_PROVIDERS,
  type ExternalProvider,
  type ImportCredential,
  type ImportJob,
  type ImportOptions,
  type ImportPreview,
  type IssueStatus,
} from '../../../core/contracts/domain';
import { ISSUE_STATUS_META, ISSUE_STATUSES } from '../../../core/meta';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { AppSelect, type Option } from '../../../shared/app-select';
import { RelativeTimePipe } from '../../../shared/pipes';
import {
  PHASE_LABEL,
  STATUS_TEXT,
  draftFromPreview,
  emptyDraft,
  importPercent,
  isActiveImport,
  mappingFromDraft,
  type MappingDraft,
} from './import-model';
import { SECTION_KIT, SETTINGS_FIELD, SETTINGS_SELECT, type SegmentedOption, type StatCell } from './section-kit';

const POLL_MS = 2000;

/** What a row of the mapping tables edits in the draft. */
type MapKind = 'projects' | 'labels' | 'users' | 'statuses';

/**
 * Settings → Import (v4 frame "Import"): bring issues from GitHub Issues or Linear into Trama in three steps:
 * Source (tracker, credential, repository), Map and preview (counts and an editable mapping of statuses, people,
 * projects and labels), Import (a background job that is followed here). Nothing is ever written back to the
 * tracker, and running it again skips what exists.
 */
@Component({
  selector: 'app-import-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AppSelect, HlmButtonImports, HlmCheckbox, LucideDynamicIcon, NgTemplateOutlet, RelativeTimePipe, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="Import"
      description="Bring work from another tool. Nothing is written until you confirm, and running an import again skips what exists."
    />
    @if (!canManage()) {
      <app-readonly-note class="mb-0!">Only admins can import. You can still see past imports.</app-readonly-note>
    }

    <div class="flex flex-col gap-9">
      @if (canManage()) {
        <ol class="flex items-center gap-3.5" aria-label="Import steps">
          @for (s of steps; track s.n) {
            <li class="flex items-center gap-2" [attr.aria-current]="step() === s.n ? 'step' : null">
              <span class="grid size-5 shrink-0 place-items-center font-mono text-[10.5px]" [class]="stepClass(s.n)">
                @if (step() > s.n) {
                  <svg [lucideIcon]="checkIcon" [size]="11"></svg>
                } @else {
                  {{ s.n }}
                }
              </span>
              <span class="text-[13px] leading-[normal] whitespace-nowrap" [class]="step() >= s.n ? 'text-foreground' : 'text-faint'">{{ s.label }}</span>
            </li>
            @if (!$last) {
              <li class="bg-border h-px min-w-4 flex-1" aria-hidden="true"></li>
            }
          }
        </ol>
      }

      @if (active(); as job) {
        <app-settings-block title="Import in progress">
          <app-settings-card>
            <div class="flex flex-col gap-3 px-4 py-4" role="status" aria-live="polite">
              <div class="flex flex-wrap items-center gap-2 text-[13px]">
                <svg [lucideIcon]="spinner" [size]="14" class="text-muted-foreground animate-spin"></svg>
                <span class="text-foreground">{{ job.sourceLabel }}</span>
                <span class="text-faint font-mono text-[10.5px]">{{ phase(job) }}</span>
              </div>
              <div class="bg-secondary h-1 overflow-hidden" role="progressbar" [attr.aria-valuenow]="percent(job)" aria-valuemin="0" aria-valuemax="100" aria-label="Import progress">
                <div class="bg-primary h-full transition-all" [class.animate-pulse]="percent(job) === null" [style.width.%]="percent(job) ?? 100"></div>
              </div>
              <p class="text-faint font-mono text-[10.5px] tabular-nums">
                {{ job.progress.processed }}@if (job.progress.total) { of {{ job.progress.total }} }
                issues · {{ job.progress.created }} created · {{ job.progress.skipped }} already there
                @if (job.progress.comments) { · {{ job.progress.comments }} comments }
                @if (job.progress.failed) { · <span class="text-red">{{ job.progress.failed }} failed</span> }
              </p>
              @if (job.waitingUntil) {
                <p class="text-status-needs-input font-mono text-[10.5px]">Waiting for the tracker’s rate limit; it continues {{ job.waitingUntil | relativeTime }}.</p>
              }
              @if (canManage()) {
                <div class="flex justify-end">
                  <button hlmBtn size="sm" variant="outline" [disabled]="job.cancelRequested" (click)="cancel(job)">
                    {{ job.cancelRequested ? 'Stopping after this page…' : 'Cancel import' }}
                  </button>
                </div>
              }
            </div>
          </app-settings-card>
        </app-settings-block>
      }

      @if (canManage()) {
        @if (preview(); as p) {
          <!-- step 2: map and preview -->
          <div class="bg-card border-border flex items-center gap-3 border px-3.5 py-3">
            <span class="bg-secondary border-border text-foreground grid size-8 shrink-0 place-items-center border">
              <svg [lucideIcon]="p.provider === 'github' ? githubIcon : linearIcon" [size]="16"></svg>
            </span>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span class="text-foreground truncate text-[13.5px] leading-[normal]">{{ p.sourceLabel }}</span>
              <span class="text-faint truncate font-mono text-[10.5px] leading-[normal]">Read as {{ p.account }} · nothing has been written yet</span>
            </div>
            <button type="button" class="text-muted-foreground hover:text-foreground shrink-0 text-[12.5px] leading-[normal]" (click)="resetPreview()">Change</button>
          </div>

          <app-stat-strip large valueFirst [cells]="statCells()" />

          @if (p.provider === 'linear') {
            <app-settings-block title="Teams">
              <app-settings-card>
                @for (t of p.teams; track t.id) {
                  <app-card-row [label]="t.name + (t.key ? ' (' + t.key + ')' : '')" [description]="t.count !== undefined ? t.count + ' issues' : ''">
                    <hlm-checkbox [checked]="!excludedTeams().has(t.id)" [aria-label]="'Include ' + t.name" (checkedChange)="toggleTeam(t.id, $event)" />
                  </app-card-row>
                }
                @if (teamsChanged()) {
                  <div class="flex justify-end px-4 py-3">
                    <button hlmBtn size="sm" variant="outline" [disabled]="busy()" (click)="runPreview(true)">Refresh preview with these teams</button>
                  </div>
                }
              </app-settings-card>
            </app-settings-block>
          }

          <div class="grid items-start gap-x-5 gap-y-9 lg:grid-cols-2">
            <section class="flex flex-col gap-2">
              <div class="flex items-center gap-2"><h3 class="text-foreground text-[13px] leading-[normal] font-medium">Status</h3></div>
              <div class="bg-card border-border divide-border divide-y border" [class]="selectField">
                @for (s of p.statuses; track s.id) {
                  <ng-container
                    [ngTemplateOutlet]="mapRow"
                    [ngTemplateOutletContext]="{
                      name: s.name,
                      hint: s.type + (s.count !== undefined ? ' · ' + s.count : ''),
                      options: statusOptions,
                      value: draft().statuses[s.id] ?? '',
                      label: 'Trama status for ' + s.name,
                      kind: 'statuses',
                      id: s.id
                    }"
                  />
                }
              </div>
            </section>

            <section class="flex flex-col gap-2">
              <div class="flex items-center gap-2">
                <h3 class="text-foreground text-[13px] leading-[normal] font-medium">People</h3>
                <span class="flex-1"></span>
                @if (unmatched() > 0) {
                  <span class="text-primary flex items-center gap-1.5 font-mono text-[10.5px] leading-[normal]">
                    <svg [lucideIcon]="warnIcon" [size]="12"></svg>{{ unmatched() }} not matched
                  </span>
                }
              </div>
              <div class="bg-card border-border divide-border max-h-96 divide-y overflow-y-auto border" [class]="selectField">
                @for (u of p.users; track u.id) {
                  <ng-container
                    [ngTemplateOutlet]="mapRow"
                    [ngTemplateOutletContext]="{
                      name: u.login ? '@' + u.login : u.name || u.id,
                      hint: u.login ? u.name || u.email || '' : u.email || '',
                      options: memberOptions(),
                      value: draft().users[u.id] ?? '',
                      label: 'Trama member for ' + (u.name || u.login || u.id),
                      kind: 'users',
                      id: u.id
                    }"
                  />
                } @empty {
                  <p class="text-faint px-3.5 py-3 font-mono text-[10.5px]">No people to map.</p>
                }
              </div>
            </section>
          </div>

          <div class="flex flex-wrap items-center gap-2">
            <span class="flex-1"></span>
            <button hlmBtn variant="outline" (click)="resetPreview()">Back</button>
            <button hlmBtn [disabled]="busy() || !!active()" (click)="start()">
              @if (active()) {
                Another import is running
              } @else {
                <svg [lucideIcon]="downloadIcon" [size]="13"></svg>
                {{ importLabel() }}
              }
            </button>
          </div>
        } @else {
          <!-- step 1: source -->
          <app-settings-block title="Source">
            <app-settings-card>
              <app-card-row label="Tracker">
                <app-segmented aria-label="Tracker" [options]="providerOptions" [value]="provider()" (valueChange)="setProvider($any($event))" />
              </app-card-row>

              <app-card-row label="Credential" wide>
                <div class="flex w-full items-center gap-2">
                  <app-select
                    class="min-w-0 flex-1"
                    size="sm"
                    label="Credential"
                    [options]="credentialOptions()"
                    [value]="credential()"
                    (valueChange)="setCredential($event)"
                  />
                  <button hlmBtn size="icon-sm" variant="outline" aria-label="Add a credential" (click)="addingCredential.set(!addingCredential())">
                    <svg [lucideIcon]="plus" [size]="14"></svg>
                  </button>
                </div>
              </app-card-row>

              @if (addingCredential()) {
                <form class="bg-secondary flex flex-col gap-3 px-4 py-3" (submit)="saveCredential($event)">
                  <div class="flex flex-col gap-1.5">
                    <label class="text-faint font-mono text-[10.5px]" for="import-token">{{ provider() === 'github' ? 'PERSONAL ACCESS TOKEN' : 'API KEY' }}</label>
                    <input
                      id="import-token"
                      type="password"
                      autocomplete="off"
                      [class]="field + ' font-mono'"
                      [value]="token()"
                      (input)="token.set($any($event.target).value)"
                      [placeholder]="provider() === 'github' ? 'github_pat_… (needs read access to issues)' : 'lin_api_…'"
                    />
                  </div>
                  @if (provider() === 'github') {
                    <div class="flex flex-col gap-1.5">
                      <label class="text-faint font-mono text-[10.5px]" for="import-base">GITHUB ENTERPRISE URL (OPTIONAL)</label>
                      <input id="import-base" [class]="field" placeholder="https://github.example.com" [value]="baseUrl()" (input)="baseUrl.set($any($event.target).value)" />
                    </div>
                  }
                  <div class="flex justify-end gap-2">
                    <button hlmBtn type="button" variant="ghost" size="sm" (click)="addingCredential.set(false)">Cancel</button>
                    <button hlmBtn type="submit" size="sm" [disabled]="!token().trim() || busy()">Check and save</button>
                  </div>
                </form>
              }

              @for (c of credentialsOf(provider()); track c.id) {
                <div class="hover:bg-secondary flex min-h-11 items-center gap-3 px-4 py-2">
                  <svg [lucideIcon]="keyIcon" [size]="14" class="text-muted-foreground shrink-0"></svg>
                  <div class="min-w-0 flex-1 text-[13px]">
                    <span class="text-foreground">{{ c.account }}</span>
                  </div>
                  <button hlmBtn size="icon-sm" variant="ghost" class="text-muted-foreground" [attr.aria-label]="'Delete the credential of ' + c.account" (click)="confirmRemoveCredential(c)">
                    <svg [lucideIcon]="trash" [size]="14"></svg>
                  </button>
                </div>
              }

              @if (provider() === 'github') {
                <app-card-row label="Repository" wide>
                  <input
                    [class]="field + ' font-mono'"
                    placeholder="acme/api"
                    aria-label="Repository"
                    [value]="repository()"
                    (input)="repository.set($any($event.target).value); resetPreview()"
                    (keydown.enter)="runPreview()"
                  />
                </app-card-row>
              }

              <div class="flex items-center justify-end gap-2 px-4 py-3">
                <button hlmBtn [disabled]="!canPreview() || busy()" (click)="runPreview()">
                  @if (busy() && !preview()) { Reading… } @else { Preview }
                </button>
              </div>
            </app-settings-card>
          </app-settings-block>
        }
      }

      <app-settings-block title="History" [caption]="'' + jobs().length">
        <div class="bg-card border-border border">
          <div class="bg-bg-deep text-faint hidden items-center gap-4 px-4 py-2 font-mono text-[10.5px] leading-[normal] md:grid md:grid-cols-[minmax(0,1fr)_90px_180px_90px_60px]">
            <span>SOURCE</span>
            <span>WHEN</span>
            <span>RESULT</span>
            <span>STATUS</span>
            <span></span>
          </div>
          @for (j of jobs(); track j.id) {
            <div class="border-border hover:bg-secondary flex flex-col gap-1.5 border-t px-4 py-2.5 first:border-t-0 md:first:border-t">
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1 md:grid md:grid-cols-[minmax(0,1fr)_90px_180px_90px_60px]">
                <span class="text-foreground min-w-0 truncate text-[13px] leading-[normal]">{{ j.sourceLabel }}</span>
                <span class="text-muted-foreground font-mono text-[10.5px] leading-[normal]">{{ j.createdAt | relativeTime }}</span>
                <span class="text-text-2 truncate font-mono text-[10.5px] leading-[normal] tabular-nums">
                  {{ j.progress.created }} created · {{ j.progress.skipped }} skipped@if (j.progress.failed) { · {{ j.progress.failed }} failed }
                </span>
                <span class="border-border text-text-2 inline-flex w-fit items-center gap-[5px] border px-[7px] py-0.5 font-mono text-[10.5px] leading-[normal]">
                  <span class="size-1.5" [class]="dotClass(j)"></span>{{ statusText[j.status] }}
                </span>
                <span class="flex items-center justify-end gap-1">
                  @if (canManage()) {
                    @if (j.status === 'failed') {
                      <button hlmBtn size="icon-sm" variant="ghost" class="text-muted-foreground" [attr.aria-label]="'Resume ' + j.sourceLabel" (click)="retry(j)"><svg [lucideIcon]="retryIcon" [size]="13"></svg></button>
                    }
                    @if (!isActive(j)) {
                      <button hlmBtn size="icon-sm" variant="ghost" class="text-muted-foreground" [attr.aria-label]="'Remove ' + j.sourceLabel + ' from history'" (click)="confirmRemove(j)"><svg [lucideIcon]="close" [size]="14"></svg></button>
                    }
                  }
                </span>
              </div>
              @if (j.lastError) {
                <p class="text-red font-mono text-[10.5px]">{{ j.lastError }}</p>
              }
              @if (j.errors.length) {
                <details class="text-[12px]">
                  <summary class="text-muted-foreground hover:text-foreground cursor-pointer font-mono text-[10.5px] select-none">{{ j.progress.failed }} issues could not be imported</summary>
                  <ul class="bg-secondary border-border mt-1.5 max-h-40 space-y-0.5 overflow-y-auto border px-3 py-2">
                    @for (e of j.errors; track $index) {
                      <li><span class="font-mono">{{ e.ref }}</span> {{ e.message }}</li>
                    }
                  </ul>
                </details>
              }
            </div>
          } @empty {
            <p class="text-faint px-4 py-6 text-center font-mono text-[10.5px]">No imports yet.</p>
          }
        </div>
      </app-settings-block>
    </div>

    <!-- one row of a mapping table: the tracker's value, an arrow, the Trama target -->
    <ng-template #mapRow let-name="name" let-hint="hint" let-options="options" let-value="value" let-label="label" let-kind="kind" let-id="id">
      <div class="flex items-center gap-4 px-3.5 py-2">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <span class="text-text-2 truncate font-mono text-[12px] leading-[normal]">{{ name }}</span>
          @if (hint) {
            <span class="text-faint shrink-0 font-mono text-[10.5px] leading-[normal]">{{ hint }}</span>
          }
        </div>
        <svg [lucideIcon]="arrow" [size]="13" class="text-faint shrink-0"></svg>
        <div class="w-[150px] shrink-0 sm:w-[170px]">
          <app-select size="sm" [label]="label" [options]="options" [value]="value" (valueChange)="setMap(kind, id, $event)" />
        </div>
      </div>
    </ng-template>
  `,
})
export class ImportSection {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly api = inject(ApiClient);
  private readonly notify = inject(Notifier);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly field = SETTINGS_FIELD;
  protected readonly selectField = SETTINGS_SELECT;
  protected readonly steps = [
    { n: 1, label: 'Source' },
    { n: 2, label: 'Map and preview' },
    { n: 3, label: 'Import' },
  ] as const;
  protected readonly providerOptions: SegmentedOption[] = EXTERNAL_PROVIDERS.map((p) => ({
    value: p,
    label: EXTERNAL_PROVIDER_META[p].label,
  }));
  protected readonly statusOptions: Option[] = ISSUE_STATUSES.map((s) => ({ value: s, label: ISSUE_STATUS_META[s].label }));
  protected readonly statusText = STATUS_TEXT;
  protected readonly plus = LucidePlus;
  protected readonly trash = LucideTrash2;
  protected readonly close = LucideX;
  protected readonly keyIcon = LucideKeyRound;
  protected readonly warnIcon = LucideTriangleAlert;
  protected readonly spinner = LucideRefreshCw;
  protected readonly retryIcon = LucideRotateCw;
  protected readonly checkIcon = LucideCheck;
  protected readonly arrow = LucideArrowRight;
  protected readonly downloadIcon = LucideDownload;
  protected readonly githubIcon = LucideGitBranch;
  protected readonly linearIcon = LucideLayers;

  protected readonly canManage = computed(() => this.store.allowed('manageIntegrations'));
  protected readonly members = computed(() => this.store.members().map((m) => ({ id: m.user.id, name: m.user.name })));
  protected readonly githubConnections = computed(() => this.store.integrations().filter((c) => c.provider === 'github'));

  protected readonly credentialOptions = computed<Option[]>(() => {
    const github = this.provider() === 'github';
    return [
      ...(github ? [{ value: '', label: 'Public repository (no token)' }] : []),
      ...this.credentialsOf(this.provider()).map((c) => ({ value: `c:${c.id}`, label: `${c.account}${c.baseUrl ? ' · ' + c.baseUrl : ''}` })),
      ...(github ? this.githubConnections().map((c) => ({ value: `n:${c.id}`, label: `GitHub integration · ${c.account}` })) : []),
    ];
  });
  protected readonly memberOptions = computed<Option[]>(() => [
    { value: '', label: 'Leave unassigned' },
    ...this.members().map((m) => ({ value: m.id, label: m.name })),
  ]);

  protected readonly provider = signal<ExternalProvider>('github');
  protected readonly credentials = signal<readonly ImportCredential[]>([]);
  /** '' = unauthenticated (GitHub), 'c:<credential id>', 'n:<GitHub connection id>'. */
  protected readonly credential = signal('');
  protected readonly repository = signal('');
  protected readonly addingCredential = signal(false);
  protected readonly token = signal('');
  protected readonly baseUrl = signal('');

  protected readonly preview = signal<ImportPreview | null>(null);
  protected readonly draft = signal<MappingDraft>(emptyDraft());
  protected readonly excludedTeams = signal<ReadonlySet<string>>(new Set());
  /** Teams the current preview was read with (to know when "refresh" is needed). */
  private readonly previewedTeams = signal<readonly string[]>([]);
  /** The frame has no option toggles: comments and closed issues come along, kinds default to feature. */
  protected readonly options = signal<ImportOptions>({ includeComments: true, includeClosed: true, defaultKind: 'feature' });
  protected readonly busy = signal(false);

  protected readonly jobs = signal<readonly ImportJob[]>([]);
  protected readonly active = computed(() => this.jobs().find(isActiveImport) ?? null);

  /** The stepper: 1 Source, 2 Map and preview (a preview is open), 3 Import (a job runs). */
  protected readonly step = computed(() => (this.preview() ? 2 : this.active() ? 3 : 1));

  protected readonly canPreview = computed(() => {
    if (this.provider() === 'github') return this.repository().trim().length > 2;
    return this.credential().startsWith('c:');
  });
  protected readonly teamsChanged = computed(() => {
    const p = this.preview();
    if (!p) return false;
    const wanted = p.teams.filter((t) => !this.excludedTeams().has(t.id)).map((t) => t.id).sort();
    return wanted.join() !== [...this.previewedTeams()].sort().join();
  });
  protected readonly statCells = computed<StatCell[]>(() => {
    const p = this.preview();
    if (!p) return [];
    const n = (v: number | null) => (v === null ? '–' : String(v));
    return [
      { label: 'issues', value: n(p.counts.issues) },
      { label: p.counts.open === null ? 'open' : `open · ${n(p.counts.closed)} closed`, value: n(p.counts.open) },
      { label: 'projects · milestones', value: `${p.counts.projects} · ${p.counts.milestones}` },
      { label: 'labels · people', value: `${p.counts.labels} · ${p.counts.users}` },
    ];
  });
  /** People of the source with no Trama member picked. */
  protected readonly unmatched = computed(() => {
    const p = this.preview();
    if (!p) return 0;
    const users = this.draft().users;
    return p.users.filter((u) => !users[u.id]).length;
  });
  protected readonly importLabel = computed(() => {
    const n = this.preview()?.counts.issues;
    return n === null || n === undefined ? 'Start import' : `Import ${n} issues`;
  });

  private poll: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const slug = this.store.slug();
      if (!slug || !this.store.ready()) return;
      untracked(() => void this.load(slug));
    });
    // While an import runs, follow it; stop when it is over.
    effect(() => {
      const running = !!this.active();
      untracked(() => {
        if (running && !this.poll) this.poll = setInterval(() => void this.refreshJobs(), POLL_MS);
        else if (!running && this.poll) this.stopPolling();
      });
    });
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private async load(slug: string): Promise<void> {
    await this.refreshJobs();
    if (!this.canManage()) return;
    try {
      this.credentials.set(await this.api.imports.credentials.list(slug, { quiet: true }));
    } catch {
      /* the actions report their own errors */
    }
  }

  private async refreshJobs(): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    const before = this.active();
    try {
      const jobs = await this.api.imports.list(slug, { quiet: true });
      if (this.store.slug() !== slug) return;
      this.jobs.set(jobs);
      // An import that just finished changed the workspace: bring its issues in.
      if (before && !jobs.some((j) => j.id === before.id && isActiveImport(j))) void this.store.refetch();
    } catch {
      /* try again on the next tick */
    }
  }

  protected credentialsOf(p: ExternalProvider) {
    return this.credentials().filter((c) => c.provider === p);
  }
  protected isActive = isActiveImport;
  protected percent = importPercent;
  protected phase(job: ImportJob): string {
    return PHASE_LABEL[job.progress.phase] ?? job.progress.phase;
  }
  protected stepClass(n: number): string {
    const step = this.step();
    if (step > n) return 'bg-secondary border-border text-foreground border';
    if (step === n) return 'bg-primary text-primary-foreground';
    return 'border-border text-faint border';
  }
  protected dotClass(j: ImportJob): string {
    switch (j.status) {
      case 'completed':
        return 'bg-status-shipped';
      case 'failed':
        return 'bg-status-blocked';
      case 'canceled':
        return 'bg-faint';
      default:
        return 'bg-primary';
    }
  }

  // ───── credentials
  protected setProvider(p: ExternalProvider): void {
    if (this.provider() === p) return;
    this.provider.set(p);
    this.credential.set(p === 'linear' ? (this.credentialsOf('linear')[0] ? `c:${this.credentialsOf('linear')[0].id}` : '') : '');
    this.addingCredential.set(false);
    this.resetPreview();
  }

  protected async saveCredential(event: Event): Promise<void> {
    event.preventDefault();
    const slug = this.store.slug();
    const token = this.token().trim();
    if (!slug || !token) return;
    this.busy.set(true);
    try {
      const created = await this.api.imports.credentials.create(slug, {
        provider: this.provider(),
        token,
        ...(this.provider() === 'github' && this.baseUrl().trim() ? { baseUrl: this.baseUrl().trim() } : {}),
      });
      this.credentials.update((list) => [...list.filter((c) => c.id !== created.id), created]);
      this.credential.set(`c:${created.id}`);
      this.token.set('');
      this.baseUrl.set('');
      this.addingCredential.set(false);
      this.notify.success(`Connected as ${created.account}`);
    } catch (e) {
      this.fail('Could not save the credential', e);
    } finally {
      this.busy.set(false);
    }
  }

  protected confirmRemoveCredential(c: ImportCredential): void {
    this.ui.setConfirmDelete({
      title: `Delete the credential of ${c.account}?`,
      description: 'Imports that use it can no longer reach the source. You can add it again later.',
      onConfirm: () => this.removeCredential(c),
    });
  }

  protected confirmRemove(job: ImportJob): void {
    this.ui.setConfirmDelete({
      title: `Remove ${job.sourceLabel} from history?`,
      description: 'Only the history entry is removed. The tasks it already imported stay.',
      confirmLabel: 'Remove',
      onConfirm: () => this.remove(job),
    });
  }

  protected async removeCredential(c: ImportCredential): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    try {
      await this.api.imports.credentials.remove(slug, c.id);
      this.credentials.update((list) => list.filter((x) => x.id !== c.id));
      if (this.credential() === `c:${c.id}`) this.credential.set('');
      this.notify.success('Credential deleted');
    } catch (e) {
      this.fail('Could not delete the credential', e);
    }
  }

  // ───── preview
  protected setCredential(value: string): void {
    this.credential.set(value);
    this.resetPreview();
  }

  protected resetPreview(): void {
    this.preview.set(null);
    this.excludedTeams.set(new Set());
  }

  private target(teamIds?: string[]) {
    const c = this.credential();
    const ref = c.startsWith('c:') ? { credentialId: c.slice(2) } : c.startsWith('n:') ? { connectionId: c.slice(2) } : {};
    return {
      provider: this.provider(),
      ...ref,
      source: this.provider() === 'github' ? { repository: this.repository().trim() } : { teamIds: teamIds ?? [] },
    };
  }

  protected async runPreview(refresh = false): Promise<void> {
    const slug = this.store.slug();
    if (!slug || !this.canPreview() || this.busy()) return;
    const current = this.preview();
    const teamIds = refresh && current ? current.teams.filter((t) => !this.excludedTeams().has(t.id)).map((t) => t.id) : [];
    this.busy.set(true);
    try {
      const p = await this.api.imports.preview(slug, this.target(teamIds));
      this.preview.set(p);
      this.draft.set(draftFromPreview(p));
      this.excludedTeams.set(new Set());
      this.previewedTeams.set(p.teams.map((t) => t.id));
    } catch (e) {
      this.fail('Could not read the source', e);
    } finally {
      this.busy.set(false);
    }
  }

  protected toggleTeam(id: string, included: boolean): void {
    this.excludedTeams.update((s) => {
      const next = new Set(s);
      if (included) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ───── mapping edits
  /** One select of a mapping table. Statuses hold a Trama status, the other kinds a target value. */
  protected setMap(kind: MapKind, id: string, value: string): void {
    this.draft.update((d) => {
      if (kind === 'statuses') return { ...d, statuses: { ...d.statuses, [id]: value as IssueStatus } };
      return { ...d, [kind]: { ...d[kind], [id]: value } };
    });
  }

  // ───── run
  protected async start(): Promise<void> {
    const slug = this.store.slug();
    const p = this.preview();
    if (!slug || !p || this.busy()) return;
    this.busy.set(true);
    try {
      const teamIds = p.teams.filter((t) => !this.excludedTeams().has(t.id)).map((t) => t.id);
      const job = await this.api.imports.start(slug, {
        ...this.target(p.provider === 'linear' ? teamIds : undefined),
        mapping: mappingFromDraft(this.draft()),
        options: this.options(),
      });
      this.jobs.update((list) => [job, ...list.filter((j) => j.id !== job.id)]);
      this.resetPreview();
      this.notify.success('Import started', { description: 'It keeps running if you leave this page.' });
    } catch (e) {
      this.fail('Could not start the import', e);
    } finally {
      this.busy.set(false);
    }
  }

  protected async cancel(job: ImportJob): Promise<void> {
    await this.act(job, 'cancel', 'Could not cancel the import');
  }
  protected async retry(job: ImportJob): Promise<void> {
    await this.act(job, 'retry', 'Could not resume the import');
  }
  protected async remove(job: ImportJob): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    try {
      await this.api.imports.remove(slug, job.id);
      this.jobs.update((list) => list.filter((j) => j.id !== job.id));
    } catch (e) {
      this.fail('Could not remove the import', e);
    }
  }

  private async act(job: ImportJob, verb: 'cancel' | 'retry', error: string): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    try {
      const updated = await this.api.imports[verb](slug, job.id);
      this.jobs.update((list) => list.map((j) => (j.id === updated.id ? updated : j)));
    } catch (e) {
      this.fail(error, e);
    }
  }

  private fail(title: string, e: unknown): void {
    this.notify.error(title, { description: ApiError.from(e).message });
  }
}
