import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  LucideBan,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideKeyRound,
  LucidePencil,
  LucidePlus,
  LucideRefreshCw,
  LucideRotateCw,
  LucideTrash2,
  LucideTriangleAlert,
  LucideWebhook,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import type { CreateIntegrationInput, IntegrationDetail, WebhookSetup } from '../../../core/api/api.types';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { ProviderIcon } from '../../../shared/provider-icon';
import { RelativeTimePipe } from '../../../shared/pipes';
import {
  ConnectionAddForm,
  ConnectionTokenForm,
  PROVIDER_INFO,
  accountLine,
  needsAttention,
  statusDot,
  statusLabel,
  type ConnProvider,
} from './connection-kit';
import { OutgoingWebhooks } from './outgoing-webhooks';
import { SECTION_KIT } from './section-kit';
import { WebhookSetupDialog } from './webhook-setup-dialog';

type Row = IntegrationDetail & { detailed: boolean };

/** What the right-hand pane shows. */
type Selection =
  | { kind: 'conn'; id: string }
  | { kind: 'connect'; preset: string | null }
  | { kind: 'webhooks' };

const GROUPS: readonly { provider: ConnProvider; title: string }[] = [
  { provider: 'github', title: 'GITHUB' },
  { provider: 'gitlab', title: 'GITLAB' },
  { provider: 'bitbucket', title: 'BITBUCKET' },
  { provider: 'delta', title: 'DELTA' },
];

/**
 * Settings · Integrations · Workspace (v4 frame "09 Integrations · Workspace"): the connections the
 * workspace owns, installed by whoever has the integrations permission. They keep working when people
 * leave. Several per provider, each with a name; a failing or revoked one says so and can be
 * reconnected. Personal accounts live under the account's own Integrations page.
 */
@Component({
  selector: 'app-integrations-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    LucideDynamicIcon,
    ProviderIcon,
    RelativeTimePipe,
    ConnectionAddForm,
    ConnectionTokenForm,
    OutgoingWebhooks,
    WebhookSetupDialog,
    ...SECTION_KIT,
  ],
  host: { class: 'block h-full min-h-0 overflow-y-auto' },
  template: `
    <div class="w-full max-w-[1240px] px-5 py-6 sm:px-10 sm:py-8 lg:px-14">
      <app-section-header
        title="Integrations"
        [description]="
          'Workspace connections, installed by admins. They belong to ' +
          workspaceName() +
          ' and keep working when people leave. Your own accounts live in Account · Integrations.'
        "
      >
        @if (canAdmin()) {
          <button actions hlmBtn (click)="openConnect(null)">
            <svg [lucideIcon]="plus" [size]="13"></svg>
            Add connection
          </button>
        }
      </app-section-header>

      @if (!canAdmin()) {
        <app-readonly-note>Your role cannot manage integrations. You can still see what is connected.</app-readonly-note>
      }

      <!-- summary -->
      <div class="border-border text-muted-foreground flex flex-wrap items-center gap-x-5 gap-y-1 border px-4 py-2.5 font-mono text-[10.5px]">
        <span class="flex items-center gap-1.5"><span class="bg-green size-1.5" aria-hidden="true"></span>{{ rows().length }} {{ rows().length === 1 ? 'connection' : 'connections' }}</span>
        @if (attention() > 0) {
          <span class="text-foreground flex items-center gap-1.5"><span class="bg-red size-1.5" aria-hidden="true"></span>{{ attention() }} {{ attention() === 1 ? 'needs' : 'need' }} attention</span>
        }
      </div>

      <div class="mt-7 flex flex-col gap-8 lg:flex-row lg:gap-0">
        <!-- master: connections by provider -->
        <nav class="flex shrink-0 flex-col gap-5 lg:w-[290px] lg:pr-6" aria-label="Connections">
          @for (g of groups(); track g.provider) {
            <div class="flex flex-col">
              <div class="flex h-6 items-center justify-between px-1">
                <span class="text-faint font-mono text-[10px] leading-none tracking-wide">{{ g.title }}</span>
                @if (canAdmin()) {
                  <button
                    type="button"
                    class="text-muted-foreground hover:text-foreground flex size-6 items-center justify-center"
                    [attr.aria-label]="'Add a ' + g.label + ' connection'"
                    (click)="openConnect(g.provider)"
                  >
                    <svg [lucideIcon]="plus" [size]="13"></svg>
                  </button>
                }
              </div>
              @for (c of g.rows; track c.id) {
                <button
                  type="button"
                  class="hover:bg-hover/60 flex min-h-[50px] items-center gap-2.5 border-l-2 px-2.5 py-2 text-left"
                  [class]="isSelected(c.id) ? 'bg-hover border-primary' : 'border-transparent'"
                  [attr.aria-current]="isSelected(c.id) ? 'true' : null"
                  (click)="select({ kind: 'conn', id: c.id })"
                >
                  <span class="bg-secondary text-foreground flex size-[30px] shrink-0 items-center justify-center">
                    <app-provider-icon [provider]="c.provider" [size]="15" />
                  </span>
                  <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
                    <span class="text-foreground truncate text-[13px] leading-none">{{ c.label }}</span>
                    <span class="text-faint truncate font-mono text-[10px] leading-none">{{ line(c) }}</span>
                  </span>
                  <span class="size-1.5 shrink-0" [class]="dot(c.status)" [attr.title]="statusText(c.status)" aria-hidden="true"></span>
                  <span class="sr-only">{{ statusText(c.status) }}</span>
                </button>
              } @empty {
                <span class="text-faint px-2.5 py-2 font-mono text-[10.5px]">None connected</span>
              }
            </div>
          }
          <div class="flex flex-col">
            <div class="flex h-6 items-center px-1">
              <span class="text-faint font-mono text-[10px] leading-none tracking-wide">OTHER</span>
            </div>
            <button
              type="button"
              class="hover:bg-hover/60 flex min-h-[50px] items-center gap-2.5 border-l-2 px-2.5 py-2 text-left"
              [class]="selection().kind === 'webhooks' ? 'bg-hover border-primary' : 'border-transparent'"
              [attr.aria-current]="selection().kind === 'webhooks' ? 'true' : null"
              (click)="select({ kind: 'webhooks' })"
            >
              <span class="bg-secondary text-foreground flex size-[30px] shrink-0 items-center justify-center">
                <svg [lucideIcon]="hook" [size]="15"></svg>
              </span>
              <span class="flex min-w-0 flex-1 flex-col gap-[3px]">
                <span class="text-foreground truncate text-[13px] leading-none">REST &amp; webhooks</span>
                <span class="text-faint truncate font-mono text-[10px] leading-none">{{ hooksLine() }}</span>
              </span>
            </button>
          </div>
        </nav>

        <!-- detail -->
        <div class="border-border min-w-0 flex-1 lg:border-l lg:pl-8">
          @switch (selection().kind) {
            @case ('connect') {
              <h3 class="font-title text-foreground text-[24px] leading-normal">Add connection</h3>
              <p class="text-muted-foreground mt-1 mb-5 max-w-[640px] text-[13px] leading-snug">
                Connect GitHub, GitLab (cloud or self-hosted), Bitbucket or Delta so pull requests and CI show up on tasks and projects. You can add several
                accounts per provider. Secrets are encrypted and never shown again.
              </p>
              @if (canAdmin()) {
                <app-connection-add-form
                  [preset]="connectPreset()"
                  scopeWord="workspace"
                  [busy]="busy()"
                  (submitted)="connect($event)"
                  (cancelled)="closeConnect()"
                />
              }
            }

            @case ('webhooks') {
              <app-outgoing-webhooks />
            }

            @default {
              @if (current(); as c) {
                <!-- head: tile, name, chips, sub line, actions -->
                <div class="flex flex-wrap items-start gap-3.5">
                  <span class="bg-secondary text-foreground flex size-11 shrink-0 items-center justify-center">
                    <app-provider-icon [provider]="c.provider" [size]="22" />
                  </span>
                  <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                    @if (renaming() === c.id) {
                      <form class="flex max-w-[460px] items-center gap-2" (submit)="saveName($event, c)">
                        <input
                          hlmInput
                          class="h-8 flex-1 text-[14px]"
                          maxlength="80"
                          aria-label="Connection name"
                          [value]="nameDraft()"
                          (input)="nameDraft.set($any($event.target).value)"
                          (keydown.escape)="renaming.set(null)"
                        />
                        <button hlmBtn type="submit" size="sm" [disabled]="!nameDraft().trim() || busy()">Save</button>
                        <button hlmBtn type="button" size="sm" variant="ghost" (click)="renaming.set(null)">Cancel</button>
                      </form>
                    } @else {
                      <div class="flex flex-wrap items-center gap-2.5">
                        <h3 class="font-title text-foreground min-w-0 truncate text-[24px] leading-normal">{{ c.label }}</h3>
                        <span class="border-border text-muted-foreground flex items-center gap-[5px] border px-1.5 py-[3px] font-mono text-[10px] leading-none">
                          <span class="size-1.5" [class]="dot(c.status)" aria-hidden="true"></span>{{ statusText(c.status) }}
                        </span>
                        <span class="border-border text-muted-foreground border px-1.5 py-[3px] font-mono text-[10px] leading-none">workspace</span>
                      </div>
                    }
                    <p class="text-faint font-mono text-[10.5px] leading-[15px]">
                      {{ line(c) }} · added {{ c.createdAt | relativeTime }}@if (c.lastWebhookAt) { · last event {{ c.lastWebhookAt | relativeTime }} }
                    </p>
                  </div>
                  @if (canAdmin()) {
                    <button
                      hlmBtn
                      variant="outline"
                      size="icon"
                      aria-label="Connection actions"
                      [hlmDropdownMenuTrigger]="menu"
                    >
                      <svg [lucideIcon]="more" [size]="15"></svg>
                    </button>
                    <ng-template #menu>
                      <hlm-dropdown-menu class="w-52">
                        <button hlmDropdownMenuItem (triggered)="startRename(c)"><svg [lucideIcon]="pencil" [size]="14"></svg> Rename</button>
                        <button hlmDropdownMenuItem (triggered)="startEdit(c)"><svg [lucideIcon]="key" [size]="14"></svg> Replace token…</button>
                        @if (c.status !== 'revoked' && c.provider !== 'delta') {
                          <button hlmDropdownMenuItem (triggered)="revalidate(c)"><svg [lucideIcon]="refresh" [size]="14"></svg> Re-validate</button>
                          <button hlmDropdownMenuItem (triggered)="rotate(c)"><svg [lucideIcon]="rotateIcon" [size]="14"></svg> Rotate webhook secret</button>
                        }
                        @if (c.status !== 'revoked') {
                          <button hlmDropdownMenuItem (triggered)="revoke(c)"><svg [lucideIcon]="ban" [size]="14"></svg> Revoke</button>
                        }
                        <button hlmDropdownMenuItem variant="destructive" (triggered)="remove(c)"><svg [lucideIcon]="trash" [size]="14"></svg> Remove</button>
                      </hlm-dropdown-menu>
                    </ng-template>
                  }
                </div>

                @if (needsAttention(c)) {
                  <div class="border-red/40 bg-red/5 mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 border px-4 py-3" role="alert">
                    <svg [lucideIcon]="warn" [size]="16" class="text-red shrink-0"></svg>
                    <div class="min-w-0 flex-1">
                      <p class="text-foreground text-[13px]">
                        {{ c.status === 'revoked' ? c.label + ' was revoked' : (c.lastError ?? 'The provider rejected this connection') }}
                      </p>
                      <p class="text-muted-foreground mt-0.5 text-[12px] leading-snug">
                        Whatever reads through it, such as a project's sources, shows an error until it is reconnected. Reconnect with a new token, or switch the
                        source to another connection.
                      </p>
                    </div>
                    @if (canAdmin()) {
                      <button hlmBtn (click)="startEdit(c)">
                        <svg [lucideIcon]="refresh" [size]="13"></svg>
                        Reconnect
                      </button>
                    }
                  </div>
                }

                @if (editing() === c.id) {
                  <div class="mt-6">
                    <app-connection-token-form
                      [provider]="c.provider"
                      [currentBase]="c.baseUrl ?? null"
                      [tokenRequired]="c.status === 'revoked'"
                      [busy]="busy()"
                      (saved)="saveEdit($event, c)"
                      (cancelled)="editing.set(null)"
                    />
                  </div>
                }

                <div class="mt-7">
                  @if (c.provider === 'delta') {
                    <app-settings-section title="Delta" caption="stored for agent sessions">
                      <p class="text-muted-foreground pt-3 text-[13px] leading-snug">
                        Delta has no repository or webhook API yet, so there is nothing else to set up.
                        @if (c.baseUrl) {
                          <span class="text-foreground font-mono text-xs">{{ c.host }}</span>
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
                <div class="flex max-w-md flex-col gap-2 pt-2">
                  <h3 class="font-title text-foreground text-[20px] leading-normal">Nothing connected yet</h3>
                  <p class="text-muted-foreground text-[13px] leading-snug">
                    Connect GitHub, GitLab or Bitbucket to see pull requests and CI on tasks and projects. Add as many accounts as you need: each one has its own name.
                  </p>
                  @if (canAdmin()) {
                    <div class="pt-2"><button hlmBtn (click)="openConnect(null)">Add connection</button></div>
                  }
                </div>
              }
            }
          }
        </div>
      </div>
    </div>

    <app-webhook-setup-dialog [setup]="webhook()" [provider]="webhookProvider()" [rotated]="webhookRotated()" (closed)="webhook.set(null)" />
  `,
})
export class IntegrationsSection {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly info = PROVIDER_INFO;
  protected readonly hook = LucideWebhook;
  protected readonly plus = LucidePlus;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly key = LucideKeyRound;
  protected readonly refresh = LucideRefreshCw;
  protected readonly rotateIcon = LucideRotateCw;
  protected readonly ban = LucideBan;
  protected readonly trash = LucideTrash2;
  protected readonly warn = LucideTriangleAlert;
  protected readonly needsAttention = needsAttention;

  protected readonly canAdmin = computed(() => this.store.allowed('manageIntegrations'));
  protected readonly workspaceName = computed(() => this.store.workspace()?.name ?? 'this workspace');

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
  protected readonly attention = computed(() => this.rows().filter(needsAttention).length);

  protected readonly groups = computed(() =>
    GROUPS.map((g) => ({ ...g, label: PROVIDER_INFO[g.provider].label, rows: this.rows().filter((r) => r.provider === g.provider) })),
  );

  protected readonly selection = computed<Selection>(() => {
    const picked = this.picked();
    if (picked?.kind === 'conn' && !this.rows().some((r) => r.id === picked.id)) return this.fallback();
    return picked ?? this.fallback();
  });
  protected readonly current = computed<Row | null>(() => {
    const sel = this.selection();
    return sel.kind === 'conn' ? (this.rows().find((r) => r.id === sel.id) ?? null) : null;
  });
  protected readonly connectPreset = computed(() => {
    const sel = this.selection();
    return sel.kind === 'connect' ? sel.preset : null;
  });
  protected readonly hooksLine = computed(() => {
    const n = this.store.outgoingWebhooks().length;
    return n ? `${n} ${n === 1 ? 'endpoint' : 'endpoints'}` : 'any tracker';
  });

  protected readonly busy = signal(false);
  protected readonly editing = signal<string | null>(null);
  protected readonly renaming = signal<string | null>(null);
  protected readonly nameDraft = signal('');

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
    return first ? { kind: 'conn', id: first.id } : { kind: 'connect', preset: null };
  }

  protected isSelected(id: string): boolean {
    const sel = this.selection();
    return sel.kind === 'conn' && sel.id === id;
  }
  protected select(sel: Selection): void {
    this.editing.set(null);
    this.renaming.set(null);
    this.picked.set(sel);
  }

  protected readonly line = accountLine;
  protected readonly dot = statusDot;
  protected readonly statusText = statusLabel;

  /** Opens the connect form, on the provider whose "+" was pressed. */
  protected openConnect(provider: ConnProvider | null): void {
    this.select({ kind: 'connect', preset: provider });
  }
  protected closeConnect(): void {
    this.picked.set(null);
  }

  protected async connect(input: CreateIntegrationInput): Promise<void> {
    this.busy.set(true);
    const res = await this.store.createIntegration(input);
    this.busy.set(false);
    if (!res) return;
    this.picked.set({ kind: 'conn', id: res.connection.id });
    this.notify.success(`${PROVIDER_INFO[input.provider].label} connected`, { description: res.connection.label });
    if (res.webhook) this.showWebhook(res.webhook, input.provider, false);
  }

  protected startRename(c: Row): void {
    this.editing.set(null);
    this.nameDraft.set(c.label);
    this.renaming.set(c.id);
  }

  protected async saveName(event: Event, c: Row): Promise<void> {
    event.preventDefault();
    const label = this.nameDraft().trim();
    if (!label) return;
    if (label === c.label) {
      this.renaming.set(null);
      return;
    }
    this.busy.set(true);
    const res = await this.store.updateIntegration(c.id, { label });
    this.busy.set(false);
    if (res) this.renaming.set(null);
  }

  protected startEdit(c: Row): void {
    this.renaming.set(null);
    this.editing.set(c.id);
  }

  protected async revalidate(c: Row): Promise<void> {
    const res = await this.store.updateIntegration(c.id, { baseUrl: c.baseUrl ?? null });
    if (res) this.notify.success('Token is valid', { description: `Signed in as ${res.account}` });
  }

  protected async saveEdit(value: { token?: string; baseUrl: string | null }, c: Row): Promise<void> {
    this.busy.set(true);
    const res = await this.store.updateIntegration(c.id, value);
    this.busy.set(false);
    if (!res) return;
    this.editing.set(null);
    this.notify.success(c.status === 'revoked' ? 'Connection restored' : 'Connection updated', { description: `Signed in as ${res.account}` });
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

  protected revoke(c: Row): void {
    this.ui.setConfirmDelete({
      title: `Revoke ${c.label}?`,
      description:
        'The token is wiped and anything reading through this connection stops and shows an error. Artifacts stay. You can reconnect it later with a new token.',
      confirmLabel: 'Revoke',
      onConfirm: async () => {
        const res = await this.store.revokeIntegration(c.id);
        if (res) this.notify.success('Connection revoked', { description: c.label });
      },
    });
  }

  protected remove(c: Row): void {
    this.ui.setConfirmDelete({
      title: `Remove ${c.label}?`,
      description: 'Artifacts stay. Webhook deliveries for this connection start failing, and anything reading through it loses its connection.',
      confirmLabel: 'Remove',
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
