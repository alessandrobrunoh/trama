import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideChevronDown,
  LucideChevronUp,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideEye,
  LucideEyeOff,
  LucideKeyRound,
  LucidePlug,
  LucidePlus,
  LucideRefreshCw,
  LucideRotateCw,
  LucideTrash2,
  LucideX,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import type { IntegrationDetail, WebhookSetup } from '../../../core/api/api.types';
import type { IntegrationConnection } from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { NablaStore } from '../../../core/stores/nabla.store';
import { UiStore } from '../../../core/stores/ui.store';
import { ProviderIcon } from '../../../shared/provider-icon';
import { RelativeTimePipe } from '../../../shared/pipes';
import { RemoteRepoBrowser } from '../../repositories/remote-repo-browser';
import { SECTION_KIT } from './section-kit';
import { OutgoingWebhooks } from './outgoing-webhooks';
import { WebhookSetupDialog } from './webhook-setup-dialog';

type ConnProvider = IntegrationConnection['provider'];

const PROVIDER_INFO: Record<ConnProvider, { label: string; blurb: string; base: string; baseHint: string; scopes: string }> = {
  github: {
    label: 'GitHub',
    blurb: 'Pull requests, reviews and CI',
    base: 'https://github.example.com',
    baseHint: 'Only for GitHub Enterprise Server. Leave empty for github.com.',
    scopes: 'Fine-grained token with Metadata and Pull requests (read) on the repositories, or a classic token with repo.',
  },
  gitlab: {
    label: 'GitLab',
    blurb: 'Merge requests and pipelines',
    base: 'https://gitlab.example.com',
    baseHint: 'Only for self-hosted GitLab. Leave empty for gitlab.com.',
    scopes: 'Personal or project access token with read_api.',
  },
  delta: {
    label: 'Delta',
    blurb: 'Agent threads and sessions',
    base: 'https://delta.example.com',
    baseHint: 'Required: the address of your Delta instance.',
    scopes: 'A Delta API token. Stored encrypted; Delta connections are not validated yet.',
  },
};

type Row = IntegrationDetail & { detailed: boolean };

/** GitHub / GitLab / Delta connections: connect, re-validate, webhook setup, linked repositories. */
@Component({
  selector: 'app-integrations-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmSpinner,
    LucideDynamicIcon,
    ProviderIcon,
    RelativeTimePipe,
    RemoteRepoBrowser,
    OutgoingWebhooks,
    WebhookSetupDialog,
    ...SECTION_KIT,
  ],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header
        title="Integrations"
        description="Connect GitHub, GitLab or Delta so pull requests and CI show up on workstreams automatically, or send events to your own systems with custom webhooks. Secrets are encrypted and never shown again."
      >
        @if (canAdmin() && !connecting()) {
          <button actions hlmBtn size="sm" (click)="openConnect()">
            <svg [lucideIcon]="plus" [size]="14"></svg> Connect
          </button>
        }
      </app-section-header>

      @if (!canAdmin()) {
        <app-readonly-note>Your role cannot manage integrations. You can still see what is connected.</app-readonly-note>
      }

      @if (connecting()) {
        <app-settings-group title="New connection" class="mb-8">
          <form (submit)="connect($event)">
            <div class="grid grid-cols-1 gap-2 p-4 sm:grid-cols-3" role="radiogroup" aria-label="Provider">
              @for (p of providers; track p) {
                <button
                  type="button"
                  role="radio"
                  [attr.aria-checked]="provider() === p"
                  class="hover:bg-accent flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors"
                  [class.border-primary]="provider() === p"
                  [class.bg-selected]="provider() === p"
                  (click)="provider.set(p)"
                >
                  <app-provider-icon [provider]="p" [size]="18" />
                  <span class="min-w-0">
                    <span class="block text-[13px] font-medium">{{ info[p].label }}</span>
                    <span class="text-muted-foreground block truncate text-xs">{{ info[p].blurb }}</span>
                  </span>
                </button>
              }
            </div>
            <app-settings-row label="Access token" [description]="info[provider()].scopes" wide>
              <div class="relative">
                <input
                  hlmInput
                  class="h-8 w-full pr-9 font-mono text-xs"
                  [type]="showToken() ? 'text' : 'password'"
                  autocomplete="off"
                  spellcheck="false"
                  [placeholder]="provider() === 'gitlab' ? 'glpat-…' : provider() === 'github' ? 'github_pat_… or ghp_…' : 'Token'"
                  [value]="token()"
                  (input)="token.set($any($event.target).value)"
                  aria-label="Access token"
                />
                <button type="button" class="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2" [attr.aria-label]="showToken() ? 'Hide token' : 'Show token'" (click)="showToken.set(!showToken())">
                  <svg [lucideIcon]="showToken() ? eyeOff : eye" [size]="14"></svg>
                </button>
              </div>
            </app-settings-row>
            <app-settings-row [label]="provider() === 'delta' ? 'Delta URL' : 'Base URL'" [description]="info[provider()].baseHint" wide>
              <input hlmInput class="h-8 w-full font-mono text-xs" type="url" [placeholder]="info[provider()].base" [value]="baseUrl()" (input)="baseUrl.set($any($event.target).value)" aria-label="Base URL" />
            </app-settings-row>
            <div class="bg-muted/30 flex items-center justify-end gap-2 px-4 py-2">
              <button hlmBtn type="button" variant="ghost" size="sm" (click)="closeConnect()">Cancel</button>
              <button hlmBtn type="submit" size="sm" [disabled]="!canConnect() || busy()">
                @if (busy()) {
                  <hlm-spinner class="size-3.5" />
                }
                {{ busy() ? 'Checking token…' : 'Connect ' + info[provider()].label }}
              </button>
            </div>
          </form>
        </app-settings-group>
      }

      @if (!rows().length && !connecting()) {
        <div class="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
          <span class="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
            <svg [lucideIcon]="plug" [size]="18" [strokeWidth]="1.5"></svg>
          </span>
          <div>
            <p class="text-[13px] font-medium">Nothing connected yet</p>
            <p class="text-muted-foreground mt-1 max-w-sm text-xs">Connect GitHub or GitLab to import projects and see pull requests and CI on your workstreams.</p>
          </div>
          @if (canAdmin()) {
            <button hlmBtn size="sm" (click)="openConnect()"><svg [lucideIcon]="plus" [size]="14"></svg> Connect</button>
          }
        </div>
      }

      <div class="flex flex-col gap-8">
        @for (c of rows(); track c.id) {
          <app-settings-group>
            <!-- Header -->
            <div class="flex min-h-14 items-center gap-3 px-4 py-3">
              <span class="bg-muted flex size-8 shrink-0 items-center justify-center rounded-md">
                <app-provider-icon [provider]="c.provider" [size]="17" />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 text-[13px] font-medium">
                  <span class="truncate">{{ c.account || info[c.provider].label }}</span>
                  <span class="text-muted-foreground text-xs font-normal">{{ info[c.provider].label }}{{ c.baseUrl ? ' · ' + host(c.baseUrl) : '' }}</span>
                </div>
                <div class="text-muted-foreground text-xs">Connected {{ c.createdAt | relativeTime }}</div>
              </div>
              <span class="flex shrink-0 items-center gap-1.5 text-xs" [class]="statusClass(c.status)">
                <span class="size-1.5 rounded-full bg-current"></span>{{ statusLabel(c.status) }}
              </span>
              @if (canAdmin()) {
                <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="menu" aria-label="Connection actions">
                  <svg [lucideIcon]="more" [size]="16"></svg>
                </button>
                <ng-template #menu>
                  <hlm-dropdown-menu class="w-52">
                    <button hlmDropdownMenuItem (triggered)="revalidate(c)">
                      <svg [lucideIcon]="refresh" [size]="14"></svg> Re-validate token
                    </button>
                    <button hlmDropdownMenuItem (triggered)="startEdit(c)">
                      <svg [lucideIcon]="keyIcon" [size]="14"></svg> Replace token…
                    </button>
                    @if (c.provider !== 'delta') {
                      <button hlmDropdownMenuItem (triggered)="rotate(c)">
                        <svg [lucideIcon]="rotateIcon" [size]="14"></svg> Rotate webhook secret
                      </button>
                    }
                    <button hlmDropdownMenuItem variant="destructive" (triggered)="disconnect(c)">
                      <svg [lucideIcon]="trash" [size]="14"></svg> Disconnect
                    </button>
                  </hlm-dropdown-menu>
                </ng-template>
              }
            </div>

            @if (c.lastError) {
              <div class="bg-destructive/5 text-destructive px-4 py-2 text-xs">{{ c.lastError }}</div>
            }

            @if (editing() === c.id) {
              <form class="bg-muted/20" (submit)="saveEdit($event, c)">
                <app-settings-row label="New token" description="Checked against the provider before it replaces the old one." wide>
                  <input hlmInput type="password" autocomplete="off" class="h-8 w-full font-mono text-xs" placeholder="Leave empty to keep the current token" [value]="editToken()" (input)="editToken.set($any($event.target).value)" aria-label="New token" />
                </app-settings-row>
                <app-settings-row [label]="c.provider === 'delta' ? 'Delta URL' : 'Base URL'" [description]="info[c.provider].baseHint" wide>
                  <input hlmInput type="url" class="h-8 w-full font-mono text-xs" [placeholder]="info[c.provider].base" [value]="editBase()" (input)="editBase.set($any($event.target).value)" aria-label="Base URL" />
                </app-settings-row>
                <div class="flex items-center justify-end gap-2 px-4 py-2">
                  <button hlmBtn type="button" variant="ghost" size="sm" (click)="editing.set(null)">Cancel</button>
                  <button hlmBtn type="submit" size="sm" [disabled]="busy() || (c.provider === 'delta' && !editBase().trim())">Save and re-validate</button>
                </div>
              </form>
            }

            @if (c.provider === 'delta') {
              <app-settings-row label="Delta" description="Stored for agent sessions. Delta has no repository or webhook API yet, so there is nothing else to set up.">
                <span class="text-muted-foreground font-mono text-xs">{{ c.baseUrl ? host(c.baseUrl) : '' }}</span>
              </app-settings-row>
            } @else {
              <app-settings-row
                label="Webhook"
                [description]="
                  c.lastWebhookAt
                    ? 'Last delivery ' + (c.lastWebhookAt | relativeTime) + '.'
                    : c.detailed
                      ? 'No delivery yet. Add this URL as a webhook in ' + info[c.provider].label + '.'
                      : 'Webhook details are visible to admins.'
                "
                wide
              >
                @if (c.webhookUrl) {
                  <app-copy-field [value]="c.webhookUrl" label="Webhook URL" />
                } @else {
                  <span class="text-muted-foreground text-xs">{{ c.webhookConfigured ? 'Configured' : 'Not configured' }}</span>
                }
              </app-settings-row>

              <div class="px-4 py-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <div class="text-[13px] font-medium">Repositories</div>
                    <div class="text-muted-foreground text-xs">
                      {{ c.repositoryIds.length ? c.repositoryIds.length + ' linked. Events from other repositories are ignored.' : 'Link repositories to receive their events and import them as projects.' }}
                    </div>
                  </div>
                  @if (canAdmin()) {
                    <button hlmBtn size="sm" variant="outline" class="h-7 shrink-0" (click)="toggleBrowse(c.id)">
                      {{ browsing() === c.id ? 'Done' : 'Browse repositories' }}
                      <svg [lucideIcon]="browsing() === c.id ? up : down" [size]="13"></svg>
                    </button>
                  }
                </div>
                @if (c.repositoryIds.length) {
                  <ul class="mt-2 divide-y rounded-md border">
                    @for (id of c.repositoryIds; track id) {
                      <li class="flex items-center gap-2 px-2.5 py-1.5">
                        <app-provider-icon [provider]="c.provider" [size]="13" />
                        @if (repo(id); as r) {
                          <a class="min-w-0 flex-1 truncate font-mono text-xs hover:underline" [routerLink]="['/', slug(), 'projects', r.id]">{{ r.fullName }}</a>
                        } @else {
                          <span class="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">{{ id }}</span>
                        }
                        @if (canAdmin()) {
                          <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground size-6" [attr.aria-label]="'Unlink ' + (repo(id)?.fullName ?? id)" title="Unlink (the project stays)" (click)="unlink(c, id)">
                            <svg [lucideIcon]="xIcon" [size]="13"></svg>
                          </button>
                        }
                      </li>
                    }
                  </ul>
                }
                @if (browsing() === c.id) {
                  <app-remote-repo-browser class="mt-3" [connectionId]="c.id" (linked)="onLinked($event.fullName)" />
                }
              </div>
            }
          </app-settings-group>
        }
      </div>
    </div>

    <app-outgoing-webhooks />

    <app-webhook-setup-dialog [setup]="webhook()" [provider]="webhookProvider()" [rotated]="webhookRotated()" (closed)="webhook.set(null)" />
  `,
})
export class IntegrationsSection {
  private readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly info = PROVIDER_INFO;
  protected readonly providers: ConnProvider[] = ['github', 'gitlab', 'delta'];
  protected readonly plus = LucidePlus;
  protected readonly plug = LucidePlug;
  protected readonly more = LucideEllipsis;
  protected readonly refresh = LucideRefreshCw;
  protected readonly keyIcon = LucideKeyRound;
  protected readonly rotateIcon = LucideRotateCw;
  protected readonly trash = LucideTrash2;
  protected readonly xIcon = LucideX;
  protected readonly eye = LucideEye;
  protected readonly eyeOff = LucideEyeOff;
  protected readonly up = LucideChevronUp;
  protected readonly down = LucideChevronDown;

  protected readonly canAdmin = computed(() => this.store.allowed('manageIntegrations'));
  protected readonly slug = computed(() => this.store.slug() ?? '');

  // connect form
  protected readonly connecting = signal(false);
  protected readonly provider = signal<ConnProvider>('github');
  protected readonly token = signal('');
  protected readonly baseUrl = signal('');
  protected readonly showToken = signal(false);
  protected readonly busy = signal(false);
  protected readonly canConnect = computed(() => !!this.token().trim() && (this.provider() !== 'delta' || !!this.baseUrl().trim()));

  // per-connection UI
  protected readonly editing = signal<string | null>(null);
  protected readonly editToken = signal('');
  protected readonly editBase = signal('');
  protected readonly browsing = signal<string | null>(null);

  // one-time webhook setup
  protected readonly webhook = signal<WebhookSetup | null>(null);
  protected readonly webhookProvider = signal<string>('github');
  protected readonly webhookRotated = signal(false);

  /** Snapshot connections enriched with admin-only details (webhook URL, linked repos, last delivery). */
  protected readonly rows = computed<Row[]>(() => {
    const details = new Map(this.store.integrationDetails().map((d) => [d.id, d]));
    return this.store.integrations().map((c) => {
      const d = details.get(c.id);
      return d ? { ...c, ...d, detailed: true } : { ...c, repositoryIds: [], detailed: false };
    });
  });

  constructor() {
    // Details are not in the snapshot: refresh them whenever the connection list changes (live updates too).
    effect(() => {
      this.store.integrations();
      untracked(() => void this.store.loadIntegrationDetails());
    });
  }

  protected repo(id: string) {
    return this.store.repositoryById().get(id);
  }
  protected host(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  protected statusLabel(s: IntegrationConnection['status']): string {
    return s === 'connected' ? 'Connected' : s === 'error' ? 'Error' : 'Disconnected';
  }
  protected statusClass(s: IntegrationConnection['status']): string {
    return s === 'connected' ? 'text-status-shipped' : s === 'error' ? 'text-destructive' : 'text-muted-foreground';
  }

  protected openConnect(): void {
    this.connecting.set(true);
    this.token.set('');
    this.baseUrl.set('');
    this.showToken.set(false);
  }
  protected closeConnect(): void {
    this.connecting.set(false);
    this.token.set('');
    this.baseUrl.set('');
  }

  protected async connect(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canConnect()) return;
    const provider = this.provider();
    this.busy.set(true);
    const res = await this.store.createIntegration({
      provider,
      token: this.token().trim(),
      baseUrl: this.baseUrl().trim() || undefined,
    });
    this.busy.set(false);
    if (!res) return;
    this.closeConnect();
    this.notify.success(`${PROVIDER_INFO[provider].label} connected`, { description: res.connection.account });
    if (res.webhook) this.showWebhook(res.webhook, provider, false);
    if (provider !== 'delta') this.browsing.set(res.connection.id);
  }

  protected async revalidate(c: Row): Promise<void> {
    const res = await this.store.updateIntegration(c.id, { baseUrl: c.baseUrl ?? null });
    if (res) this.notify.success('Token is valid', { description: `Signed in as ${res.account}` });
  }

  protected startEdit(c: Row): void {
    this.editToken.set('');
    this.editBase.set(c.baseUrl ?? '');
    this.editing.set(c.id);
  }

  protected async saveEdit(event: Event, c: Row): Promise<void> {
    event.preventDefault();
    const token = this.editToken().trim();
    const base = this.editBase().trim();
    this.busy.set(true);
    const res = await this.store.updateIntegration(c.id, { ...(token ? { token } : {}), baseUrl: base || null });
    this.busy.set(false);
    if (!res) return;
    this.editing.set(null);
    this.notify.success('Connection updated', { description: `Signed in as ${res.account}` });
  }

  protected rotate(c: Row): void {
    this.ui.setConfirmDelete({
      title: 'Rotate the webhook secret?',
      description: `The current secret stops working immediately. Deliveries fail until you paste the new one into ${PROVIDER_INFO[c.provider].label}.`,
      confirmLabel: 'Rotate secret',
      onConfirm: async () => {
        const res = await this.store.rotateWebhookSecret(c.id);
        // Let the confirm dialog close before opening the setup dialog.
        if (res?.webhook) setTimeout(() => this.showWebhook(res.webhook!, c.provider, true));
      },
    });
  }

  protected disconnect(c: Row): void {
    this.ui.setConfirmDelete({
      title: `Disconnect ${c.account || PROVIDER_INFO[c.provider].label}?`,
      description: 'Projects and artifacts stay. Webhook deliveries for this connection start failing.',
      confirmLabel: 'Disconnect',
      onConfirm: async () => {
        await this.store.deleteIntegration(c.id);
      },
    });
  }

  protected toggleBrowse(id: string): void {
    this.browsing.update((cur) => (cur === id ? null : id));
  }

  protected onLinked(fullName: string): void {
    this.notify.success('Repository linked', { description: `${fullName} is now a project.` });
  }

  protected unlink(c: Row, repositoryId: string): void {
    const name = this.repo(repositoryId)?.fullName ?? 'this repository';
    void this.store.unlinkRepository(c.id, repositoryId).then((ok) => {
      if (ok) this.notify.success(`Unlinked ${name}`, { description: 'The project stays; its events are now ignored.' });
    });
  }

  private showWebhook(setup: WebhookSetup, provider: string, rotated: boolean): void {
    this.webhookProvider.set(provider);
    this.webhookRotated.set(rotated);
    this.webhook.set(setup);
  }
}
