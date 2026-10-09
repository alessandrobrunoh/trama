import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  LucideCircleAlert,
  LucideCircleCheck,
  LucideDynamicIcon,
  LucideKeyRound,
  LucideRefreshCw,
  LucidePlus,
  LucideRotateCw,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
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
  type IssueKind,
  type IssueStatus,
} from '../../../core/contracts/domain';
import { ISSUE_KIND_META, ISSUE_KINDS, ISSUE_STATUS_META, ISSUE_STATUSES } from '../../../core/meta';
import { Notifier } from '../../../core/notify/notifier';
import { NablaStore } from '../../../core/stores/nabla.store';
import { RelativeTimePipe } from '../../../shared/pipes';
import { ProviderIcon } from '../../../shared/provider-icon';
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
import { SECTION_KIT } from './section-kit';

const SELECT = 'border-border bg-background h-8 w-full rounded-md border px-2 text-[13px]';
const POLL_MS = 2000;

/**
 * Settings → Import: bring issues from GitHub Issues or Linear into Trama. Pick a source, read it (preview with
 * counts and an editable mapping of teams, projects, labels, people and statuses), run it as a background job and
 * follow its progress. Nothing is ever written back to the tracker, and running it again skips what exists.
 */
@Component({
  selector: 'app-import-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, HlmSwitchImports, LucideDynamicIcon, RelativeTimePipe, ProviderIcon, ...SECTION_KIT],
  template: `
    <app-section-header
      title="Import"
      description="Keep GitHub Issues or Linear and add Trama next to it, or move over in one go. Trama only reads from the tracker. Running an import again skips what was already imported."
    />
    @if (!canManage()) {
      <app-readonly-note>Only admins can import. You can still see past imports.</app-readonly-note>
    }

    <div class="flex flex-col gap-8">
      @if (active(); as job) {
        <app-settings-group title="Import in progress">
          <div class="flex flex-col gap-3 px-4 py-4" role="status" aria-live="polite">
            <div class="flex flex-wrap items-center gap-2 text-[13px] font-medium">
              <svg [lucideIcon]="spinner" [size]="14" class="text-muted-foreground animate-spin"></svg>
              <span>{{ job.sourceLabel }}</span>
              <span class="text-muted-foreground text-xs font-normal">{{ phase(job) }}</span>
            </div>
            <div class="bg-muted h-1.5 overflow-hidden rounded-full" role="progressbar" [attr.aria-valuenow]="percent(job)" aria-valuemin="0" aria-valuemax="100" aria-label="Import progress">
              <div class="bg-primary h-full rounded-full transition-all" [class.animate-pulse]="percent(job) === null" [style.width.%]="percent(job) ?? 100"></div>
            </div>
            <p class="text-muted-foreground text-xs tabular-nums">
              {{ job.progress.processed }}@if (job.progress.total) { of {{ job.progress.total }} }
              issues · {{ job.progress.created }} created · {{ job.progress.skipped }} already there
              @if (job.progress.comments) { · {{ job.progress.comments }} comments }
              @if (job.progress.failed) { · <span class="text-status-blocked">{{ job.progress.failed }} failed</span> }
            </p>
            @if (job.waitingUntil) {
              <p class="text-status-needs-input text-xs">Waiting for the tracker’s rate limit; it continues {{ job.waitingUntil | relativeTime }}.</p>
            }
            @if (canManage()) {
              <div class="flex justify-end">
                <button hlmBtn size="sm" variant="outline" [disabled]="job.cancelRequested" (click)="cancel(job)">
                  {{ job.cancelRequested ? 'Stopping after this page…' : 'Cancel import' }}
                </button>
              </div>
            }
          </div>
        </app-settings-group>
      }

      @if (canManage()) {
        <app-settings-group title="Source" description="Where the issues are read from.">
          <app-settings-row label="Tracker">
            <div class="flex gap-1" role="group" aria-label="Tracker">
              @for (p of providers; track p) {
                <button
                  hlmBtn
                  size="sm"
                  [variant]="provider() === p ? 'secondary' : 'ghost'"
                  class="h-7 gap-1.5"
                  [attr.aria-pressed]="provider() === p"
                  (click)="setProvider(p)"
                >
                  @if (p === 'github') { <app-provider-icon provider="github" /> }
                  {{ meta(p).label }}
                </button>
              }
            </div>
          </app-settings-row>

          <app-settings-row
            label="Credential"
            [description]="provider() === 'github' ? 'A public repository needs none (60 requests an hour). Use a token for a private one.' : 'A Linear personal API key (Linear → Settings → Security & access).'"
            wide
          >
            <div class="flex items-center gap-2">
              <select [class]="select" aria-label="Credential" [value]="credential()" (change)="credential.set($any($event.target).value); resetPreview()">
                @if (provider() === 'github') {
                  <option value="" [selected]="credential() === ''">Public repository (no token)</option>
                }
                @for (c of credentialsOf(provider()); track c.id) {
                  <option [value]="'c:' + c.id" [selected]="credential() === ('c:' + c.id)">{{ c.account }}{{ c.baseUrl ? ' · ' + c.baseUrl : '' }}</option>
                }
                @if (provider() === 'github') {
                  @for (c of githubConnections(); track c.id) {
                    <option [value]="'n:' + c.id" [selected]="credential() === ('n:' + c.id)">GitHub integration · {{ c.account }}</option>
                  }
                }
              </select>
              <button hlmBtn size="icon-sm" variant="outline" aria-label="Add a credential" (click)="addingCredential.set(!addingCredential())">
                <svg [lucideIcon]="plus" [size]="14"></svg>
              </button>
            </div>
          </app-settings-row>

          @if (addingCredential()) {
            <form class="bg-muted/30 flex flex-col gap-3 px-4 py-3" (submit)="saveCredential($event)">
              <div class="flex flex-col gap-1">
                <label class="text-xs font-medium" for="import-token">{{ provider() === 'github' ? 'Personal access token' : 'API key' }}</label>
                <input
                  id="import-token"
                  hlmInput
                  type="password"
                  autocomplete="off"
                  class="h-8 w-full font-mono text-xs"
                  [value]="token()"
                  (input)="token.set($any($event.target).value)"
                  [placeholder]="provider() === 'github' ? 'github_pat_… (needs read access to issues)' : 'lin_api_…'"
                />
                <p class="text-muted-foreground text-xs">Stored encrypted on the server and only used to read. It is never shown again.</p>
              </div>
              @if (provider() === 'github') {
                <div class="flex flex-col gap-1">
                  <label class="text-xs font-medium" for="import-base">GitHub Enterprise URL (optional)</label>
                  <input id="import-base" hlmInput class="h-8 w-full text-[13px]" placeholder="https://github.example.com" [value]="baseUrl()" (input)="baseUrl.set($any($event.target).value)" />
                </div>
              }
              <div class="flex justify-end gap-2">
                <button hlmBtn type="button" variant="ghost" size="sm" (click)="addingCredential.set(false)">Cancel</button>
                <button hlmBtn type="submit" size="sm" [disabled]="!token().trim() || busy()">Check and save</button>
              </div>
            </form>
          }

          @for (c of credentialsOf(provider()); track c.id) {
            <div class="flex min-h-11 items-center gap-3 px-4 py-2">
              <svg [lucideIcon]="keyIcon" [size]="14" class="text-muted-foreground shrink-0"></svg>
              <div class="min-w-0 flex-1 text-[13px]">
                <span class="font-medium">{{ c.account }}</span>
                <span class="text-muted-foreground text-xs">
                  @if (c.baseUrl) { · {{ c.baseUrl }} }
                  · added {{ c.createdAt | relativeTime }}@if (c.lastUsedAt) { · used {{ c.lastUsedAt | relativeTime }} }
                </span>
              </div>
              <button hlmBtn size="icon-sm" variant="ghost" class="text-muted-foreground" [attr.aria-label]="'Delete the credential of ' + c.account" (click)="removeCredential(c)">
                <svg [lucideIcon]="trash" [size]="14"></svg>
              </button>
            </div>
          }

          @if (provider() === 'github') {
            <app-settings-row label="Repository" description="owner/name, or paste the repository URL." wide>
              <input
                hlmInput
                class="h-8 w-full font-mono text-xs"
                placeholder="acme/api"
                aria-label="Repository"
                [value]="repository()"
                (input)="repository.set($any($event.target).value); resetPreview()"
                (keydown.enter)="runPreview()"
              />
            </app-settings-row>
          }

          <div class="bg-muted/30 flex items-center justify-end gap-2 px-4 py-2">
            <button hlmBtn size="sm" [disabled]="!canPreview() || busy()" (click)="runPreview()">
              @if (busy() && !preview()) { Reading… } @else { Preview }
            </button>
          </div>
        </app-settings-group>

        @if (preview(); as p) {
          <app-settings-group [title]="'Preview · ' + p.sourceLabel" [description]="'Read as ' + p.account + '. Nothing has been written yet.'">
            <div class="grid grid-cols-2 gap-px sm:grid-cols-4">
              @for (stat of stats(p); track stat.label) {
                <div class="bg-card px-4 py-3">
                  <div class="text-lg font-semibold tabular-nums">{{ stat.value }}</div>
                  <div class="text-muted-foreground text-xs">{{ stat.label }}</div>
                </div>
              }
            </div>
            @for (w of p.warnings; track w) {
              <p class="text-status-needs-input flex items-start gap-1.5 px-4 py-2 text-xs"><svg [lucideIcon]="alert" [size]="13" class="mt-px shrink-0"></svg>{{ w }}</p>
            }
            @if (p.sample.length) {
              <div class="px-4 py-2.5">
                <div class="text-muted-foreground mb-1 text-xs font-medium">First issues</div>
                @for (s of p.sample; track s.key) {
                  <div class="flex items-baseline gap-2 py-0.5 text-[13px]">
                    <span class="text-muted-foreground w-10 shrink-0 font-mono text-xs">{{ s.key }}</span>
                    <span class="min-w-0 flex-1 truncate">{{ s.title }}</span>
                    <span class="text-muted-foreground shrink-0 text-xs">{{ s.state }}</span>
                  </div>
                }
              </div>
            }
          </app-settings-group>

          @if (p.provider === 'linear') {
            <app-settings-group title="Teams" description="Choose the teams to read, then map each to a Trama team.">
              @for (t of p.teams; track t.id) {
                <app-settings-row [label]="t.name + (t.key ? ' (' + t.key + ')' : '')" [description]="t.count !== undefined ? t.count + ' issues' : ''" wide>
                  <div class="flex items-center gap-2">
                    <input type="checkbox" class="size-4" [checked]="!excludedTeams().has(t.id)" [attr.aria-label]="'Include ' + t.name" (change)="toggleTeam(t.id, $any($event.target).checked)" />
                    <select [class]="select" [attr.aria-label]="'Trama team for ' + t.name" [value]="draft().teams[t.id]" (change)="setTarget('teams', t.id, $any($event.target).value)">
                      <option value="create" [selected]="draft().teams[t.id] === 'create'">Create team “{{ t.key ?? t.name }}”</option>
                      <option value="skip" [selected]="draft().teams[t.id] === 'skip'">No team</option>
                      @for (x of teams(); track x.id) {
                        <option [value]="'map:' + x.id" [selected]="draft().teams[t.id] === ('map:' + x.id)">{{ x.name }}</option>
                      }
                    </select>
                  </div>
                </app-settings-row>
              }
              @if (teamsChanged()) {
                <div class="bg-muted/30 flex justify-end px-4 py-2">
                  <button hlmBtn size="sm" variant="outline" [disabled]="busy()" (click)="runPreview(true)">Refresh preview with these teams</button>
                </div>
              }
            </app-settings-group>
          } @else {
            <app-settings-group title="Team" description="The tracker has no teams: choose where its issues belong in Trama.">
              @for (t of p.teams; track t.id) {
                <app-settings-row [label]="t.name" wide>
                  <select [class]="select" aria-label="Trama team" [value]="draft().teams[t.id]" (change)="setTarget('teams', t.id, $any($event.target).value)">
                    <option value="skip" [selected]="draft().teams[t.id] === 'skip'">No team</option>
                    <option value="create" [selected]="draft().teams[t.id] === 'create'">Create a team</option>
                    @for (x of teams(); track x.id) {
                      <option [value]="'map:' + x.id" [selected]="draft().teams[t.id] === ('map:' + x.id)">{{ x.name }}</option>
                    }
                  </select>
                </app-settings-row>
              }
            </app-settings-group>
          }

          <app-settings-group
            title="Projects"
            [description]="p.provider === 'github' ? 'Milestones of the repository become milestones of this project (' + p.counts.milestones + ').' : 'Linear projects and their milestones.'"
          >
            @for (x of p.projects; track x.id) {
              <app-settings-row [label]="x.name" wide>
                <select [class]="select" [attr.aria-label]="'Trama project for ' + x.name" [value]="draft().projects[x.id]" (change)="setTarget('projects', x.id, $any($event.target).value)">
                  <option value="create" [selected]="draft().projects[x.id] === 'create'">Create project</option>
                  <option value="skip" [selected]="draft().projects[x.id] === 'skip'">No project</option>
                  @for (pr of projects(); track pr.id) {
                    <option [value]="'map:' + pr.id" [selected]="draft().projects[x.id] === ('map:' + pr.id)">{{ pr.name }}</option>
                  }
                </select>
              </app-settings-row>
            } @empty {
              <p class="text-muted-foreground px-4 py-3 text-xs">No projects in the source.</p>
            }
          </app-settings-group>

          <app-settings-group title="Statuses" description="Each state of the tracker becomes one of Trama’s statuses.">
            @for (s of p.statuses; track s.id) {
              <app-settings-row [label]="s.name" [description]="s.type + (s.count !== undefined ? ' · ' + s.count + ' issues' : '')" wide>
                <select [class]="select" [attr.aria-label]="'Trama status for ' + s.name" [value]="draft().statuses[s.id]" (change)="setStatus(s.id, $any($event.target).value)">
                  @for (st of statuses; track st) {
                    <option [value]="st" [selected]="draft().statuses[s.id] === (st)">{{ statusLabel(st) }}</option>
                  }
                </select>
              </app-settings-row>
            }
          </app-settings-group>

          <details class="group">
            <summary class="text-[13px] font-medium cursor-pointer select-none">Labels ({{ p.labels.length }})</summary>
            <div class="mt-2">
              <app-settings-group description="A tracker label can reuse a Trama label, become a new one or be dropped. Labels named bug, security, incident, chore or idea also pick the issue kind.">
                @for (l of p.labels; track l.id) {
                  <app-settings-row [label]="l.name" wide>
                    <select [class]="select" [attr.aria-label]="'Trama label for ' + l.name" [value]="draft().labels[l.id]" (change)="setTarget('labels', l.id, $any($event.target).value)">
                      <option value="create" [selected]="draft().labels[l.id] === 'create'">Create label</option>
                      <option value="skip" [selected]="draft().labels[l.id] === 'skip'">Drop it</option>
                      @for (x of labels(); track x.id) {
                        <option [value]="'map:' + x.id" [selected]="draft().labels[l.id] === ('map:' + x.id)">{{ x.name }}</option>
                      }
                    </select>
                  </app-settings-row>
                } @empty {
                  <p class="text-muted-foreground px-4 py-3 text-xs">No labels in the source.</p>
                }
              </app-settings-group>
            </div>
          </details>

          <details class="group">
            <summary class="text-[13px] font-medium cursor-pointer select-none">People ({{ p.users.length }})</summary>
            <div class="mt-2">
              <app-settings-group description="Matched by email, then by login or name. An assignee left unmatched leaves the issue unassigned.">
                @for (u of p.users; track u.id) {
                  <app-settings-row [label]="u.name || u.login || u.id" [description]="u.email || (u.login ? '@' + u.login : '')" wide>
                    <select [class]="select" [attr.aria-label]="'Trama member for ' + (u.name || u.login || u.id)" [value]="draft().users[u.id]" (change)="setUser(u.id, $any($event.target).value)">
                      <option value="" [selected]="draft().users[u.id] === ''">Unassigned</option>
                      @for (m of members(); track m.id) {
                        <option [value]="m.id" [selected]="draft().users[u.id] === (m.id)">{{ m.name }}</option>
                      }
                    </select>
                  </app-settings-row>
                } @empty {
                  <p class="text-muted-foreground px-4 py-3 text-xs">No people to map.</p>
                }
              </app-settings-group>
            </div>
          </details>

          <app-settings-group title="Options">
            <app-settings-row label="Comments" description="Copy each issue’s comments. They appear as written by you, with the original author and date in the text.">
              <hlm-switch [checked]="options().includeComments" (checkedChange)="setOption({ includeComments: $event })" aria-label="Import comments" />
            </app-settings-row>
            <app-settings-row label="Closed issues" description="Also import issues that are closed, completed or canceled.">
              <hlm-switch [checked]="options().includeClosed" (checkedChange)="setOption({ includeClosed: $event })" aria-label="Import closed issues" />
            </app-settings-row>
            <app-settings-row label="Default kind" description="For issues with no label that says bug, feature, incident…" wide>
              <select [class]="select" aria-label="Default kind" [value]="options().defaultKind" (change)="setOption({ defaultKind: $any($event.target).value })">
                @for (k of kinds; track k) {
                  <option [value]="k" [selected]="options().defaultKind === (k)">{{ kindLabel(k) }}</option>
                }
              </select>
            </app-settings-row>
            <div class="bg-muted/30 flex items-center justify-between gap-3 px-4 py-2">
              <span class="text-muted-foreground text-xs">
                @if (p.counts.issues !== null) { About {{ p.counts.issues }} issues. } Imported issues keep their dates and link back to the original.
              </span>
              <button hlmBtn size="sm" [disabled]="busy() || !!active()" (click)="start()">
                @if (active()) { Another import is running } @else { Start import }
              </button>
            </div>
          </app-settings-group>
        }
      }

      <app-settings-group title="History" description="Past imports of this workspace.">
        @for (j of jobs(); track j.id) {
          <div class="flex flex-col gap-1.5 px-4 py-3">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <svg [lucideIcon]="icon(j)" [size]="14" [class]="iconClass(j)"></svg>
              <span class="text-[13px] font-medium">{{ j.sourceLabel }}</span>
              <span class="text-muted-foreground text-xs">{{ statusText[j.status] }} · {{ j.createdAt | relativeTime }}</span>
              <span class="flex-1"></span>
              @if (canManage()) {
                @if (j.status === 'failed') {
                  <button hlmBtn size="sm" variant="outline" class="h-7" (click)="retry(j)"><svg [lucideIcon]="retryIcon" [size]="12"></svg> Resume</button>
                }
                @if (!isActive(j)) {
                  <button hlmBtn size="icon-sm" variant="ghost" class="text-muted-foreground" [attr.aria-label]="'Remove ' + j.sourceLabel + ' from history'" (click)="remove(j)"><svg [lucideIcon]="close" [size]="14"></svg></button>
                }
              }
            </div>
            <p class="text-muted-foreground text-xs tabular-nums">
              {{ j.progress.created }} created · {{ j.progress.skipped }} already there · {{ j.progress.failed }} failed@if (j.progress.comments) { · {{ j.progress.comments }} comments }
            </p>
            @if (j.lastError) {
              <p class="text-status-blocked text-xs">{{ j.lastError }}</p>
            }
            @if (j.errors.length) {
              <details class="text-xs">
                <summary class="text-muted-foreground hover:text-foreground cursor-pointer select-none">{{ j.progress.failed }} issues could not be imported</summary>
                <ul class="bg-muted/40 mt-1.5 max-h-40 space-y-0.5 overflow-y-auto rounded-md border px-3 py-2">
                  @for (e of j.errors; track $index) {
                    <li><span class="font-mono">{{ e.ref }}</span> {{ e.message }}</li>
                  }
                </ul>
              </details>
            }
          </div>
        } @empty {
          <p class="text-muted-foreground px-4 py-6 text-center text-xs">No imports yet.</p>
        }
      </app-settings-group>
    </div>
  `,
})
export class ImportSection {
  private readonly store = inject(NablaStore);
  private readonly api = inject(ApiClient);
  private readonly notify = inject(Notifier);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly select = SELECT;
  protected readonly providers = EXTERNAL_PROVIDERS;
  protected readonly statuses = ISSUE_STATUSES;
  protected readonly kinds = ISSUE_KINDS;
  protected readonly statusText = STATUS_TEXT;
  protected readonly plus = LucidePlus;
  protected readonly trash = LucideTrash2;
  protected readonly close = LucideX;
  protected readonly keyIcon = LucideKeyRound;
  protected readonly alert = LucideCircleAlert;
  protected readonly spinner = LucideRefreshCw;
  protected readonly retryIcon = LucideRotateCw;

  protected readonly canManage = computed(() => this.store.allowed('manageIntegrations'));
  protected readonly teams = computed(() => this.store.teams());
  protected readonly projects = computed(() => this.store.projects().slice().sort((a, b) => a.name.localeCompare(b.name)));
  protected readonly labels = computed(() => this.store.settings().labels);
  protected readonly members = computed(() => this.store.members().map((m) => ({ id: m.user.id, name: m.user.name })));
  protected readonly githubConnections = computed(() => this.store.integrations().filter((c) => c.provider === 'github'));

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
  protected readonly options = signal<ImportOptions>({ includeComments: false, includeClosed: true, defaultKind: 'feature' });
  protected readonly busy = signal(false);

  protected readonly jobs = signal<readonly ImportJob[]>([]);
  protected readonly active = computed(() => this.jobs().find(isActiveImport) ?? null);

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

  protected meta(p: ExternalProvider) {
    return EXTERNAL_PROVIDER_META[p];
  }
  protected credentialsOf(p: ExternalProvider) {
    return this.credentials().filter((c) => c.provider === p);
  }
  protected statusLabel(s: IssueStatus): string {
    return ISSUE_STATUS_META[s].label;
  }
  protected kindLabel(k: IssueKind): string {
    return ISSUE_KIND_META[k].label;
  }
  protected isActive = isActiveImport;
  protected percent = importPercent;
  protected phase(job: ImportJob): string {
    return PHASE_LABEL[job.progress.phase] ?? job.progress.phase;
  }
  protected icon(j: ImportJob) {
    return j.status === 'completed' ? LucideCircleCheck : j.status === 'failed' ? LucideCircleAlert : j.status === 'canceled' ? LucideX : LucideRefreshCw;
  }
  protected iconClass(j: ImportJob): string {
    return j.status === 'completed' ? 'text-status-shipped' : j.status === 'failed' ? 'text-status-blocked' : 'text-muted-foreground';
  }
  protected stats(p: ImportPreview): { label: string; value: string }[] {
    const n = (v: number | null) => (v === null ? '–' : String(v));
    return [
      { label: 'issues', value: n(p.counts.issues) },
      { label: p.counts.open === null ? 'open' : `open · ${n(p.counts.closed)} closed`, value: n(p.counts.open) },
      { label: 'projects · milestones', value: `${p.counts.projects} · ${p.counts.milestones}` },
      { label: 'labels · people', value: `${p.counts.labels} · ${p.counts.users}` },
    ];
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
  protected setTarget(kind: 'teams' | 'projects' | 'labels', id: string, value: string): void {
    this.draft.update((d) => ({ ...d, [kind]: { ...d[kind], [id]: value } }));
  }
  protected setUser(id: string, value: string): void {
    this.draft.update((d) => ({ ...d, users: { ...d.users, [id]: value } }));
  }
  protected setStatus(id: string, value: IssueStatus): void {
    this.draft.update((d) => ({ ...d, statuses: { ...d.statuses, [id]: value } }));
  }
  protected setOption(change: Partial<ImportOptions>): void {
    this.options.update((o) => ({ ...o, ...change }));
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
