import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { LucideDynamicIcon, LucideEye, LucideEyeOff, LucideMoon, LucideWebhook } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import type { IntegrationDetail, WebhookSetup } from '../../../core/api/api.types';
import type { IntegrationConnection } from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { TopBarActions } from '../../../layout/page-chrome';
import { ProviderIcon } from '../../../shared/provider-icon';
import { RelativeTimePipe } from '../../../shared/pipes';
import { LunagestIntegration } from './lunagest-integration';
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
  bitbucket: {
    label: 'Bitbucket',
    blurb: 'Pull requests and build statuses (Cloud)',
    base: '',
    baseHint: '',
    scopes:
      'An Atlassian API token as email:token (scopes read:user, read:repository and read:pullrequest), or a repository or workspace access token.',
  },
  delta: {
    label: 'Delta',
    blurb: 'Agent threads and sessions',
    base: 'https://delta.example.com',
    baseHint: 'Required: the address of your Delta instance.',
    scopes: 'A Delta API token. Stored encrypted; Delta connections are not validated yet.',
  },
};

/**
 * What can be connected. A choice is a provider, optionally preset to a self-hosted instance
 * (GitHub Enterprise Server, self-hosted GitLab), where the base URL becomes required.
 */
interface Choice {
  id: string;
  provider: ConnProvider;
  label: string;
  blurb: string;
  /** The connection must point at your own instance. */
  selfHosted?: boolean;
}

const CHOICES: Choice[] = [
  { id: 'github', provider: 'github', label: 'GitHub', blurb: PROVIDER_INFO.github.blurb },
  { id: 'github-enterprise', provider: 'github', label: 'GitHub Enterprise', blurb: 'Self-hosted GitHub Enterprise Server', selfHosted: true },
  { id: 'gitlab', provider: 'gitlab', label: 'GitLab', blurb: PROVIDER_INFO.gitlab.blurb },
  { id: 'gitlab-self-hosted', provider: 'gitlab', label: 'GitLab Self-Hosted', blurb: 'Your own GitLab instance', selfHosted: true },
  { id: 'bitbucket', provider: 'bitbucket', label: 'Bitbucket', blurb: PROVIDER_INFO.bitbucket.blurb },
  { id: 'delta', provider: 'delta', label: 'Delta', blurb: PROVIDER_INFO.delta.blurb },
];

type Row = IntegrationDetail & { detailed: boolean };

/** What the right-hand pane shows. */
type Selection =
  | { kind: 'conn'; id: string }
  | { kind: 'connect' }
  | { kind: 'lunagest' }
  | { kind: 'webhooks' };

/** One line of the left-hand list (v3 "Providers"). */
interface ListItem {
  key: string;
  sel: Selection;
  provider: ConnProvider | null;
  label: string;
  sub: string;
  status: string;
  /** Tailwind class for the 6px status square. */
  dot: string;
  /** Preset the connect form to this choice when the line is a provider that is not connected. */
  choice?: Choice;
}

/**
 * Settings · Integrations (v3 frame 11): master / detail. The left list holds every connection (and the
 * providers still to connect, LunaGest and custom webhooks); the right pane shows the one selected: its
 * account, status and webhook, with re-validate, token replacement, secret rotation and disconnect.
 * GitHub / GitLab / Bitbucket / Delta connections work as before; nothing here is fake data.
 */
@Component({
  selector: 'app-integrations-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmInputImports,
    HlmSpinner,
    LucideDynamicIcon,
    ProviderIcon,
    RelativeTimePipe,
    LunagestIntegration,
    OutgoingWebhooks,
    WebhookSetupDialog,
    TopBarActions,
    ...SECTION_KIT,
  ],
  host: { class: 'flex h-full min-h-0 flex-col overflow-y-auto md:flex-row md:overflow-hidden' },
  template: `
    <ng-template appTopBarActions>
      @if (canAdmin()) {
        <button hlmBtn (click)="openConnect()">Add integration</button>
      }
    </ng-template>

    <!-- master: connections and what can still be connected -->
    <div class="border-border flex shrink-0 flex-col border-b md:min-h-0 md:w-[340px] md:overflow-y-auto md:border-r md:border-b-0">
      <div class="border-border text-foreground border-b px-4 py-3 font-mono text-[10.5px] leading-none">CONNECTIONS</div>
      @for (item of items(); track item.key) {
        <button
          type="button"
          class="border-border hover:bg-hover/60 flex min-h-[62px] items-center gap-3 border-b px-4 py-3.5 text-left"
          [class.bg-hover]="isSelected(item)"
          [attr.aria-current]="isSelected(item) ? 'true' : null"
          (click)="select(item)"
        >
          <span class="bg-secondary text-foreground flex size-8 shrink-0 items-center justify-center">
            @if (item.provider) {
              <app-provider-icon [provider]="item.provider" [size]="16" />
            } @else if (item.sel.kind === 'lunagest') {
              <svg [lucideIcon]="moon" [size]="16"></svg>
            } @else {
              <svg [lucideIcon]="hook" [size]="16"></svg>
            }
          </span>
          <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span class="text-foreground truncate text-[13.5px] leading-none">{{ item.label }}</span>
            <span class="text-faint truncate font-mono text-[10.5px] leading-none">{{ item.sub }}</span>
          </span>
          @if (item.status) {
            <span class="flex shrink-0 items-center gap-[5px]">
              <span class="size-1.5" [class]="item.dot" aria-hidden="true"></span>
              <span class="text-muted-foreground font-mono text-[10px] leading-none">{{ item.status }}</span>
            </span>
          }
        </button>
      }
    </div>

    <!-- detail -->
    <div class="min-w-0 flex-1 px-5 py-6 md:min-h-0 md:overflow-y-auto md:px-10 md:py-7">
      @if (!canAdmin()) {
        <app-readonly-note>Your role cannot manage integrations. You can still see what is connected.</app-readonly-note>
      }

      @switch (selection().kind) {
        @case ('connect') {
          <app-section-header
            title="Add integration"
            description="Connect GitHub, GitLab (cloud or self-hosted), Bitbucket or Delta so pull requests and CI show up on tasks and projects. Secrets are encrypted and never shown again."
          />
          @if (canAdmin()) {
            <form (submit)="connect($event)" class="flex max-w-[720px] flex-col gap-4">
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Provider">
                @for (p of choices; track p.id) {
                  <button
                    type="button"
                    role="radio"
                    class="hover:bg-hover flex items-center gap-2.5 border px-3 py-2.5 text-left transition-colors"
                    [class]="choice().id === p.id ? 'bg-selected border-border-strong' : 'bg-secondary border-border'"
                    [attr.aria-checked]="choice().id === p.id"
                    (click)="choose(p)"
                  >
                    <app-provider-icon [provider]="p.provider" [size]="18" />
                    <span class="min-w-0">
                      <span class="text-foreground block text-[13px]">{{ p.label }}</span>
                      <span class="text-faint block truncate font-mono text-[10px]">{{ p.blurb }}</span>
                    </span>
                  </button>
                }
              </div>
              <app-settings-group>
                <app-settings-row label="Access token" [description]="info[provider()].scopes" wide>
                  <div class="relative">
                    <input
                      hlmInput
                      class="h-8 w-full pr-9 font-mono text-xs"
                      [type]="showToken() ? 'text' : 'password'"
                      autocomplete="off"
                      spellcheck="false"
                      [placeholder]="tokenPlaceholder()"
                      [value]="token()"
                      (input)="token.set($any($event.target).value)"
                      aria-label="Access token"
                    />
                    <button type="button" class="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2" [attr.aria-label]="showToken() ? 'Hide token' : 'Show token'" (click)="showToken.set(!showToken())">
                      <svg [lucideIcon]="showToken() ? eyeOff : eye" [size]="14"></svg>
                    </button>
                  </div>
                </app-settings-row>
                @if (provider() !== 'bitbucket') {
                  <app-settings-row [label]="provider() === 'delta' ? 'Delta URL' : 'Base URL'" [description]="baseHint()" wide>
                    <input hlmInput class="h-8 w-full font-mono text-xs" type="url" [placeholder]="info[provider()].base" [value]="baseUrl()" (input)="baseUrl.set($any($event.target).value)" aria-label="Base URL" />
                  </app-settings-row>
                }
              </app-settings-group>
              <div class="flex items-center justify-end gap-2">
                <button hlmBtn type="button" variant="ghost" (click)="closeConnect()">Cancel</button>
                <button hlmBtn type="submit" [disabled]="!canConnect() || busy()">
                  @if (busy()) {
                    <hlm-spinner class="size-3.5" />
                  }
                  {{ busy() ? 'Checking token…' : 'Connect ' + choice().label }}
                </button>
              </div>
            </form>
          }
        }

        @case ('lunagest') {
          <app-lunagest-integration />
        }

        @case ('webhooks') {
          <app-outgoing-webhooks />
        }

        @default {
          @if (current(); as c) {
            <!-- head: tile, name, status line, actions -->
            <div class="flex flex-wrap items-center gap-3.5">
              <span class="bg-secondary text-foreground flex size-11 shrink-0 items-center justify-center">
                <app-provider-icon [provider]="c.provider" [size]="22" />
              </span>
              <div class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <h2 class="font-title text-foreground truncate text-[28px] leading-normal">{{ c.account || info[c.provider].label }}</h2>
                <p class="text-faint font-mono text-[10.5px] leading-[15px]">
                  {{ statusLabel(c.status) }} · {{ info[c.provider].label }}{{ c.baseUrl ? ' · ' + host(c.baseUrl) : '' }} · connected {{ c.createdAt | relativeTime }}@if (c.lastWebhookAt) { · last event {{ c.lastWebhookAt | relativeTime }} }
                </p>
              </div>
              @if (canAdmin()) {
                <div class="flex flex-wrap items-center gap-2">
                  <button hlmBtn variant="outline" (click)="revalidate(c)">Re-validate</button>
                  <button hlmBtn variant="outline" (click)="startEdit(c)">Replace token…</button>
                  @if (c.provider !== 'delta') {
                    <button hlmBtn variant="outline" (click)="rotate(c)">Rotate secret</button>
                  }
                  <button hlmBtn variant="destructive" (click)="disconnect(c)">Disconnect</button>
                </div>
              }
            </div>

            @if (c.lastError) {
              <div class="border-red/40 text-red mt-5 border px-3 py-2 text-[12.5px]">{{ c.lastError }}</div>
            }

            @if (editing() === c.id) {
              <form class="mt-6 max-w-[720px]" (submit)="saveEdit($event, c)">
                <app-settings-group>
                  <app-settings-row label="New token" description="Checked against the provider before it replaces the old one." wide>
                    <input hlmInput type="password" autocomplete="off" class="h-8 w-full font-mono text-xs" placeholder="Leave empty to keep the current token" [value]="editToken()" (input)="editToken.set($any($event.target).value)" aria-label="New token" />
                  </app-settings-row>
                  @if (c.provider !== 'bitbucket') {
                    <app-settings-row [label]="c.provider === 'delta' ? 'Delta URL' : 'Base URL'" [description]="info[c.provider].baseHint" wide>
                      <input hlmInput type="url" class="h-8 w-full font-mono text-xs" [placeholder]="info[c.provider].base" [value]="editBase()" (input)="editBase.set($any($event.target).value)" aria-label="Base URL" />
                    </app-settings-row>
                  }
                  <div class="flex items-center justify-end gap-2 px-4 py-2">
                    <button hlmBtn type="button" variant="ghost" (click)="editing.set(null)">Cancel</button>
                    <button hlmBtn type="submit" [disabled]="busy() || (c.provider === 'delta' && !editBase().trim())">Save and re-validate</button>
                  </div>
                </app-settings-group>
              </form>
            }

            <div class="mt-7">
              @if (c.provider === 'delta') {
                <app-settings-section title="Delta" caption="stored for agent sessions">
                  <p class="text-muted-foreground pt-3 text-[13px] leading-snug">
                    Delta has no repository or webhook API yet, so there is nothing else to set up.
                    @if (c.baseUrl) {
                      <span class="text-foreground font-mono text-xs">{{ host(c.baseUrl) }}</span>
                    }
                  </p>
                </app-settings-section>
              } @else {
                <app-settings-section
                  title="Webhook"
                  [caption]="
                    c.lastWebhookAt
                      ? 'last delivery ' + (c.lastWebhookAt | relativeTime)
                      : c.detailed
                        ? 'no delivery yet'
                        : 'details are visible to admins'
                  "
                >
                  <div class="flex max-w-[720px] flex-col gap-2 pt-3">
                    @if (c.webhookUrl) {
                      <app-copy-field [value]="c.webhookUrl" label="Webhook URL" />
                      @if (!c.lastWebhookAt) {
                        <p class="text-muted-foreground text-[12px]">Add this URL as a webhook in {{ info[c.provider].label }}.</p>
                      }
                    } @else {
                      <span class="text-faint font-mono text-[11.5px]">{{ c.webhookConfigured ? 'Configured' : 'Not configured' }}</span>
                    }
                  </div>
                </app-settings-section>
              }
            </div>
          } @else {
            <div class="flex max-w-md flex-col gap-2 pt-10">
              <h2 class="font-title text-foreground text-[20px] leading-normal">Nothing connected yet</h2>
              <p class="text-muted-foreground text-[13px] leading-snug">
                Connect GitHub, GitLab or Bitbucket to see pull requests and CI on tasks and projects.
              </p>
              @if (canAdmin()) {
                <div class="pt-2"><button hlmBtn (click)="openConnect()">Add integration</button></div>
              }
            </div>
          }
        }
      }
    </div>

    <app-webhook-setup-dialog [setup]="webhook()" [provider]="webhookProvider()" [rotated]="webhookRotated()" (closed)="webhook.set(null)" />
  `,
})
export class IntegrationsSection {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly info = PROVIDER_INFO;
  protected readonly choices = CHOICES;
  protected readonly moon = LucideMoon;
  protected readonly hook = LucideWebhook;
  protected readonly eye = LucideEye;
  protected readonly eyeOff = LucideEyeOff;

  protected readonly canAdmin = computed(() => this.store.allowed('manageIntegrations'));

  /** What the right-hand pane shows. Null until the person picks: the first connection (or the connect form). */
  private readonly picked = signal<Selection | null>(null);

  /** Snapshot connections enriched with admin-only details (webhook URL, last delivery). */
  protected readonly rows = computed<Row[]>(() => {
    const details = new Map(this.store.integrationDetails().map((d) => [d.id, d]));
    return this.store.integrations().map((c) => {
      const d = details.get(c.id);
      return d ? { ...c, ...d, detailed: true } : { ...c, detailed: false };
    });
  });

  protected readonly selection = computed<Selection>(() => {
    const picked = this.picked();
    if (picked?.kind === 'conn' && !this.rows().some((r) => r.id === picked.id)) return this.fallback();
    return picked ?? this.fallback();
  });
  protected readonly current = computed<Row | null>(() => {
    const sel = this.selection();
    return sel.kind === 'conn' ? (this.rows().find((r) => r.id === sel.id) ?? null) : null;
  });

  protected readonly items = computed<ListItem[]>(() => {
    const out: ListItem[] = this.rows().map((c) => ({
      key: 'conn:' + c.id,
      sel: { kind: 'conn', id: c.id },
      provider: c.provider,
      label: c.account || PROVIDER_INFO[c.provider].label,
      sub: PROVIDER_INFO[c.provider].label + (c.baseUrl ? ' · ' + this.host(c.baseUrl) : ''),
      status: this.statusLabel(c.status),
      dot: c.status === 'connected' ? 'bg-green' : c.status === 'error' ? 'bg-red' : 'bg-faint',
    }));
    const connected = new Set(this.rows().map((c) => c.provider));
    for (const choice of CHOICES) {
      if (choice.selfHosted || connected.has(choice.provider)) continue;
      out.push({
        key: 'new:' + choice.id,
        sel: { kind: 'connect' },
        provider: choice.provider,
        label: choice.label,
        sub: '—',
        status: 'Not connected',
        dot: 'bg-faint',
        choice,
      });
    }
    const hooks = this.store.outgoingWebhooks().length;
    out.push({
      key: 'lunagest',
      sel: { kind: 'lunagest' },
      provider: null,
      label: 'LunaGest',
      sub: 'project tool',
      status: '',
      dot: 'bg-faint',
    });
    out.push({
      key: 'webhooks',
      sel: { kind: 'webhooks' },
      provider: null,
      label: 'REST & webhooks',
      sub: 'any tracker',
      status: hooks ? `${hooks} ${hooks === 1 ? 'endpoint' : 'endpoints'}` : '',
      dot: 'bg-muted-foreground',
    });
    return out;
  });

  // connect form
  protected readonly choice = signal<Choice>(CHOICES[0]);
  protected readonly provider = computed(() => this.choice().provider);
  protected readonly token = signal('');
  protected readonly baseUrl = signal('');
  protected readonly showToken = signal(false);
  protected readonly busy = signal(false);
  protected readonly baseRequired = computed(() => this.provider() === 'delta' || !!this.choice().selfHosted);
  protected readonly canConnect = computed(() => !!this.token().trim() && (!this.baseRequired() || !!this.baseUrl().trim()));
  protected readonly baseHint = computed(() =>
    this.baseRequired() ? `Required: the address of your ${this.choice().label.replace(/ Self-Hosted$/, '')} instance.` : PROVIDER_INFO[this.provider()].baseHint,
  );
  protected readonly tokenPlaceholder = computed(() => {
    switch (this.provider()) {
      case 'gitlab':
        return 'glpat-…';
      case 'github':
        return 'github_pat_… or ghp_…';
      case 'bitbucket':
        return 'email:api-token or an access token';
      default:
        return 'Token';
    }
  });

  protected choose(c: Choice): void {
    this.choice.set(c);
    this.baseUrl.set('');
  }

  // per-connection UI
  protected readonly editing = signal<string | null>(null);
  protected readonly editToken = signal('');
  protected readonly editBase = signal('');

  // one-time webhook setup
  protected readonly webhook = signal<WebhookSetup | null>(null);
  protected readonly webhookProvider = signal<string>('github');
  protected readonly webhookRotated = signal(false);

  constructor() {
    // Details are not in the snapshot: refresh them whenever the connection list changes (live updates too).
    effect(() => {
      this.store.integrations();
      untracked(() => void this.store.loadIntegrationDetails());
    });
  }

  private fallback(): Selection {
    const first = this.rows()[0];
    return first ? { kind: 'conn', id: first.id } : { kind: 'connect' };
  }

  protected isSelected(item: ListItem): boolean {
    const sel = this.selection();
    if (item.sel.kind !== sel.kind) return false;
    if (item.sel.kind === 'conn' && sel.kind === 'conn') return item.sel.id === sel.id;
    // a provider that is not connected opens the connect form preset to it
    return item.choice ? item.choice.id === this.choice().id : true;
  }

  protected select(item: ListItem): void {
    if (item.choice) {
      this.choose(item.choice);
      this.openConnect();
      return;
    }
    this.picked.set(item.sel);
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

  protected openConnect(): void {
    this.picked.set({ kind: 'connect' });
    this.token.set('');
    this.baseUrl.set('');
    this.showToken.set(false);
  }
  protected closeConnect(): void {
    this.picked.set(null);
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
    this.token.set('');
    this.baseUrl.set('');
    this.picked.set({ kind: 'conn', id: res.connection.id });
    this.notify.success(`${PROVIDER_INFO[provider].label} connected`, { description: res.connection.account });
    if (res.webhook) this.showWebhook(res.webhook, provider, false);
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
      description: 'Artifacts stay. Webhook deliveries for this connection start failing.',
      confirmLabel: 'Disconnect',
      onConfirm: async () => {
        await this.store.deleteIntegration(c.id);
      },
    });
  }

  private showWebhook(setup: WebhookSetup, provider: string, rotated: boolean): void {
    this.webhookProvider.set(provider);
    this.webhookRotated.set(rotated);
    this.webhook.set(setup);
  }
}
