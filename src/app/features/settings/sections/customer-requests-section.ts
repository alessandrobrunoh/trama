import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideDynamicIcon,
  LucideEllipsis,
  LucideInbox,
  LucideKeyRound,
  LucidePencil,
  LucidePlus,
  LucideRotateCw,
  LucideSend,
  LucideTrash2,
  LucideTriangleAlert,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { ApiClient } from '../../../core/api/api-client';
import { ApiError } from '../../../core/api/api-error';
import type { IntakeTestResult } from '../../../core/api/api.types';
import { INTAKE_PROVIDERS, INTAKE_PROVIDER_META, INTAKE_SOURCE_NAME_MAX, type IntakeProvider, type IntakeSource } from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { CustomerIntakeStore } from '../../../core/stores/customer-intake.store';
import { NablaStore } from '../../../core/stores/nabla.store';
import { UiStore } from '../../../core/stores/ui.store';
import { RelativeTimePipe } from '../../../shared/pipes';
import { INTAKE_ICONS } from '../../customers/intake-source-badge';
import { CodeBlock } from './connect-snippets';
import { SECTION_KIT } from './section-kit';

interface Guide {
  where: string;
  steps: string[];
  /** A snippet worth copying (payload template, curl). */
  snippet?: (url: string) => string;
  snippetLabel?: string;
}

const ZENDESK_TEMPLATE = `{
  "ticket_id": "{{ticket.id}}",
  "subject": "{{ticket.title}}",
  "description": "{{ticket.description}}",
  "requester_email": "{{ticket.requester.email}}",
  "requester_name": "{{ticket.requester.name}}"
}`;

const GUIDES: Record<IntakeProvider, Guide> = {
  intercom: {
    where: 'Intercom Developer Hub → your app → Webhooks',
    steps: [
      'Paste the endpoint URL below as the webhook endpoint.',
      'Subscribe to “New conversation created by a user or lead” (conversation.user.created).',
      'Copy the app’s client secret (Basic information) and paste it into Trama with “Set secret”: Intercom signs every notification with it (X-Hub-Signature).',
    ],
  },
  zendesk: {
    where: 'Zendesk Admin Center → Apps and integrations → Webhooks, then Objects and rules → Triggers',
    steps: [
      'Create a webhook with the endpoint URL below, method POST, format JSON, authentication none (Trama checks the signature).',
      'Open the webhook and copy its signing secret into Trama with “Set secret”.',
      'Create a trigger “Ticket is created” → Notify by → Active webhook, with the JSON body shown below.',
      'Optional: set the Zendesk subdomain here so requests link to the ticket in the agent workspace.',
    ],
    snippet: () => ZENDESK_TEMPLATE,
    snippetLabel: 'JSON body for the trigger',
  },
  front: {
    where: 'Front → Settings → Developers → your app (or a rule with a “Send to webhook” action)',
    steps: [
      'Create an application, add the endpoint URL below as the webhook URL and subscribe to inbound messages (inbound_received).',
      'Copy the application secret and paste it into Trama with “Set secret”: Front signs every event (X-Front-Signature).',
      'Requests are keyed by conversation, so later messages in one thread do not file the request again.',
    ],
  },
  slack: {
    where: 'api.slack.com/apps → your app → Slash Commands',
    steps: [
      'Create a command such as /customer-request and paste the endpoint URL below as its Request URL.',
      'Copy the app’s signing secret (Basic Information) and paste it into Trama with “Set secret”.',
      'Use it as /customer-request jane@acme.com what the customer asked for. The email is optional; without one the request waits in the inbox.',
    ],
  },
  email: {
    where: 'Postmark → your server → Inbound stream → Webhook (any inbound-parse service that can POST JSON works)',
    steps: [
      'Forward customer emails to the inbound address of your provider.',
      'Set the inbound webhook URL to the URL below with the secret as the password: https://trama:SECRET@host/api/webhooks/intake/…',
      'The parsed email JSON (From, Subject, TextBody, MessageID) is read as-is. Other services can POST the same fields in lower case (from, subject, text, messageId).',
    ],
  },
  generic: {
    where: 'Any system that can POST JSON (Zapier, Make, n8n, your CRM or a script)',
    steps: [
      'POST JSON to the endpoint URL with an X-Trama-Signature header (sha256= plus the hex HMAC-SHA256 of the raw body with the secret), or, if your tool cannot sign, Authorization: Bearer <secret>.',
      'externalId is the idempotency key: sending the same one again is ignored.',
      'Add issueKey (for example BUG-42) to attach the request straight to an issue of this workspace.',
    ],
    snippet: (url) =>
      `curl -X POST '${url}' \\\n  -H 'Authorization: Bearer <secret>' -H 'Content-Type: application/json' \\\n  -d '{"externalId":"ticket-1042","subject":"SSO","body":"We need SAML","requesterEmail":"jane@acme.com","externalUrl":"https://desk.example/t/1042"}'`,
    snippetLabel: 'Example request',
  },
};

interface Draft {
  provider: IntakeProvider;
  name: string;
  subdomain: string;
  secret: string;
  autoCreateCustomers: boolean;
  targetProjectId: string;
}
const emptyDraft = (): Draft => ({ provider: 'intercom', name: '', subdomain: '', secret: '', autoCreateCustomers: true, targetProjectId: '' });

/**
 * Settings → Customer requests: where customer requests come from (Intercom, Zendesk, Front, Slack, email,
 * signed webhook). Each source has its own webhook URL and secret; requests are matched to a customer by the
 * sender's email domain and either attached to a project or left in the triage inbox.
 */
@Component({
  selector: 'app-customer-requests-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmDropdownMenuImports, HlmInputImports, HlmSwitchImports, LucideDynamicIcon, RelativeTimePipe, CodeBlock, ...SECTION_KIT],
  template: `
    <app-section-header
      title="Customer requests"
      description="Bring requests in from the tools your customers already use. Each one is matched to a customer by the sender’s email domain, then attached to a project or kept in the inbox until someone links it."
    />
    @if (!canManage()) {
      <app-readonly-note>Only admins can connect sources. You can still triage the inbox.</app-readonly-note>
    }

    <div class="flex flex-col gap-8">
      <a
        [routerLink]="['/', slug(), 'customers', 'inbox']"
        class="bg-card hover:bg-accent/50 flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors"
      >
        <span class="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-md"><svg [lucideIcon]="inboxIcon" [size]="15"></svg></span>
        <span class="min-w-0 flex-1">
          <span class="block text-[13px] font-medium">Triage inbox</span>
          <span class="text-muted-foreground block text-xs">
            @if (pending() === null) { Requests waiting to be linked } @else if (pending() === 0) { Nothing waiting } @else { {{ pending() }} waiting to be linked to an issue or project }
          </span>
        </span>
        <span class="text-muted-foreground text-xs">Open</span>
      </a>

      <app-settings-group title="Sources" description="One per tool. Deliveries are accepted only with a valid signature of the source’s secret.">
        @if (canManage() && !form()) {
          <button aside hlmBtn size="sm" variant="outline" class="h-7" (click)="startCreate()">
            <svg [lucideIcon]="plus" [size]="13"></svg> Add source
          </button>
        }

        @if (secret(); as s) {
          <div class="flex flex-col gap-3 px-4 py-4">
            <p class="text-status-needs-input flex items-center gap-1.5 text-[13px] font-medium">
              <svg [lucideIcon]="warn" [size]="14"></svg>
              {{ s.rotated ? 'New secret' : 'Source created' }}: copy the secret now. You will not be able to see it again.
            </p>
            <app-copy-field [value]="s.value" label="Secret" />
            <div class="flex justify-end"><button hlmBtn size="sm" variant="outline" (click)="secret.set(null)">Done</button></div>
          </div>
        }

        @if (form(); as f) {
          <form (submit)="save($event)">
            @if (!editing()) {
              <app-settings-row label="Tool" description="Where the requests come from." wide>
                <select class="border-border bg-background h-8 w-full rounded-md border px-2 text-[13px]" aria-label="Tool" [value]="f.provider" (change)="patch({ provider: $any($event.target).value })">
                  @for (p of providers; track p) {
                    <option [value]="p">{{ label(p) }}</option>
                  }
                </select>
              </app-settings-row>
            }
            <app-settings-row label="Name" description="Shown in the inbox and on requests, like “Support desk”." wide>
              <input hlmInput class="h-8 w-full text-[13px]" [attr.maxlength]="nameMax" [placeholder]="label(f.provider)" [value]="f.name" (input)="patch({ name: $any($event.target).value })" aria-label="Source name" />
            </app-settings-row>
            @if (f.provider === 'zendesk') {
              <app-settings-row label="Zendesk subdomain" description="The part before .zendesk.com. Used to link the ticket." wide>
                <input hlmInput class="h-8 w-full font-mono text-xs" placeholder="acme" [value]="f.subdomain" (input)="patch({ subdomain: $any($event.target).value })" aria-label="Zendesk subdomain" />
              </app-settings-row>
            }
            @if (!generates(f.provider)) {
              <app-settings-row
                [label]="editing() ? 'Replace the secret' : label(f.provider) + ' secret'"
                [description]="'Paste ' + secretName(f.provider) + (editing() ? '. Leave empty to keep the current one.' : '. You can also add it after the webhook exists on their side.')"
                wide
              >
                <input hlmInput type="password" autocomplete="off" class="h-8 w-full font-mono text-xs" [value]="f.secret" (input)="patch({ secret: $any($event.target).value })" aria-label="Provider secret" />
              </app-settings-row>
            }
            <app-settings-row label="Create customers automatically" description="When the sender’s domain matches nobody, add a prospect customer for that company. Mailbox providers (gmail.com…) never do.">
              <hlm-switch [checked]="f.autoCreateCustomers" (checkedChange)="patch({ autoCreateCustomers: $event })" aria-label="Create customers automatically" />
            </app-settings-row>
            <app-settings-row label="Attach to project" description="Requests from a known customer go straight to this project. Otherwise they wait in the inbox." wide>
              <select class="border-border bg-background h-8 w-full rounded-md border px-2 text-[13px]" aria-label="Project" [value]="f.targetProjectId" (change)="patch({ targetProjectId: $any($event.target).value })">
                <option value="">Keep in the inbox</option>
                @for (p of projects(); track p.id) {
                  <option [value]="p.id">{{ p.name }}</option>
                }
              </select>
            </app-settings-row>
            <div class="bg-muted/30 flex items-center justify-end gap-2 px-4 py-2">
              <button hlmBtn type="button" variant="ghost" size="sm" (click)="form.set(null)">Cancel</button>
              <button hlmBtn type="submit" size="sm" [disabled]="!f.name.trim() || busy()">{{ editing() ? 'Save' : 'Add source' }}</button>
            </div>
          </form>
        }

        @for (s of sources(); track s.id) {
          <div>
            <div class="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2.5">
              <span class="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
                <svg [lucideIcon]="icon(s.provider)" [size]="15"></svg>
              </span>
              <div class="min-w-0 flex-1 basis-48">
                <div class="flex items-center gap-2 text-[13px] font-medium">
                  <span class="truncate">{{ s.name }}</span>
                  <span class="flex shrink-0 items-center gap-1 text-xs font-normal" [class]="statusClass(s)">
                    <span class="size-1.5 rounded-full bg-current"></span>{{ statusText(s) }}@if (s.hasSecret && s.enabled && s.lastReceivedAt) { · {{ s.lastReceivedAt | relativeTime }} }
                  </span>
                </div>
                <div class="text-muted-foreground truncate text-xs">
                  {{ label(s.provider) }}{{ s.autoCreateCustomers ? ' · creates customers' : '' }}
                </div>
              </div>
              @if (canManage()) {
                <hlm-switch [checked]="s.enabled" (checkedChange)="toggle(s, $event)" [attr.aria-label]="(s.enabled ? 'Disable ' : 'Enable ') + s.name" />
                <button hlmBtn variant="outline" size="sm" class="h-7" [disabled]="testing() === s.id || !s.hasSecret" [title]="s.hasSecret ? 'Run a sample delivery through the real pipeline. Nothing is saved.' : 'Add the secret first'" (click)="test(s)">
                  <svg [lucideIcon]="send" [size]="12"></svg> {{ testing() === s.id ? 'Testing…' : 'Test' }}
                </button>
                <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="menu" aria-label="Source actions">
                  <svg [lucideIcon]="more" [size]="16"></svg>
                </button>
                <ng-template #menu>
                  <hlm-dropdown-menu class="w-52">
                    <button hlmDropdownMenuItem (triggered)="startEdit(s)"><svg [lucideIcon]="pencil" [size]="14"></svg> Edit</button>
                    @if (generates(s.provider)) {
                      <button hlmDropdownMenuItem (triggered)="rotate(s)"><svg [lucideIcon]="rotateIcon" [size]="14"></svg> Rotate secret</button>
                    } @else {
                      <button hlmDropdownMenuItem (triggered)="startEdit(s)"><svg [lucideIcon]="keyIcon" [size]="14"></svg> Set secret</button>
                    }
                    <button hlmDropdownMenuItem variant="destructive" (triggered)="remove(s)"><svg [lucideIcon]="trash" [size]="14"></svg> Delete</button>
                  </hlm-dropdown-menu>
                </ng-template>
              }
            </div>
            <div class="flex flex-col gap-2 px-4 pb-3">
              <app-copy-field [value]="s.webhookUrl" label="Endpoint URL" />
              @if (!s.hasSecret) {
                <p class="text-status-needs-input text-xs">Waiting for the secret: deliveries are refused until you add it.</p>
              }
              @if (results()[s.id]; as r) {
                <div class="bg-muted/40 rounded-md border px-3 py-2 text-xs leading-snug" role="status">
                  <strong class="font-medium">Test passed.</strong>
                  A sample request from <code class="font-mono">{{ r.request?.requesterEmail }}</code>
                  @if (r.customer) { would be filed for <strong class="font-medium">{{ r.customer.name }}</strong>. }
                  @else if (r.wouldCreate) { would create the customer <strong class="font-medium">{{ r.wouldCreate.name }}</strong> ({{ r.wouldCreate.domain }}). }
                  @else { has no customer. }
                  {{ r.inbox ? 'It would wait in the inbox.' : 'It would be attached to the target project.' }}
                  Nothing was saved.
                </div>
              }
              <details class="text-xs">
                <summary class="text-muted-foreground hover:text-foreground cursor-pointer select-none">Setup instructions</summary>
                <div class="bg-muted/40 mt-2 flex flex-col gap-2 rounded-md border px-3 py-2.5">
                  <p class="text-xs font-medium">{{ guide(s.provider).where }}</p>
                  <ol class="text-muted-foreground list-decimal space-y-0.5 pl-4 text-xs">
                    @for (step of guide(s.provider).steps; track step) {
                      <li>{{ step }}</li>
                    }
                  </ol>
                  @if (guide(s.provider).snippet; as snippet) {
                    <app-code-block [code]="snippet(s.webhookUrl)" [label]="guide(s.provider).snippetLabel ?? 'snippet'" />
                  }
                </div>
              </details>
            </div>
          </div>
        } @empty {
          @if (!form() && !secret()) {
            <div class="flex flex-col items-center gap-2 px-6 py-8 text-center">
              <p class="text-[13px] font-medium">No sources yet</p>
              <p class="text-muted-foreground max-w-sm text-xs leading-snug">
                Add Intercom, Zendesk, Front, Slack, an email address or a signed webhook. Salesforce and Attio are not connected yet.
              </p>
              @if (canManage()) {
                <button hlmBtn size="sm" variant="outline" (click)="startCreate()"><svg [lucideIcon]="plus" [size]="13"></svg> Add source</button>
              }
            </div>
          }
        }
      </app-settings-group>
    </div>
  `,
})
export class CustomerRequestsSection {
  private readonly store = inject(NablaStore);
  private readonly api = inject(ApiClient);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly providers = INTAKE_PROVIDERS;
  protected readonly nameMax = INTAKE_SOURCE_NAME_MAX;
  protected readonly plus = LucidePlus;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly rotateIcon = LucideRotateCw;
  protected readonly trash = LucideTrash2;
  protected readonly send = LucideSend;
  protected readonly warn = LucideTriangleAlert;
  protected readonly inboxIcon = LucideInbox;
  protected readonly keyIcon = LucideKeyRound;

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageIntegrations'));
  protected readonly projects = computed(() => this.store.projects().slice().sort((a, b) => a.name.localeCompare(b.name)));

  protected readonly sources = signal<readonly IntakeSource[]>([]);
  protected readonly pending = inject(CustomerIntakeStore).pending;
  protected readonly form = signal<Draft | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly secret = signal<{ value: string; rotated: boolean } | null>(null);
  protected readonly testing = signal<string | null>(null);
  protected readonly results = signal<Record<string, IntakeTestResult>>({});

  constructor() {
    effect(() => {
      const slug = this.store.slug();
      if (!slug || !this.store.ready()) return;
      untracked(() => void this.load(slug));
    });
  }

  private async load(slug: string): Promise<void> {
    try {
      if (this.canManage()) this.sources.set(await this.api.intakeSources.list(slug, { quiet: true }));
    } catch {
      /* the page still renders; the actions report their own errors */
    }
  }

  protected label(p: IntakeProvider): string {
    return INTAKE_PROVIDER_META[p].label;
  }
  protected icon(p: IntakeProvider) {
    return INTAKE_ICONS[p];
  }
  protected generates(p: IntakeProvider): boolean {
    return INTAKE_PROVIDER_META[p].generatesSecret;
  }
  protected secretName(p: IntakeProvider): string {
    return INTAKE_PROVIDER_META[p].secretName;
  }
  protected guide(p: IntakeProvider): Guide {
    return GUIDES[p];
  }

  protected statusText(s: IntakeSource): string {
    if (!s.hasSecret) return 'Needs secret';
    if (!s.enabled) return 'Disabled';
    return s.lastReceivedAt ? 'Last request' : 'No requests yet';
  }
  protected statusClass(s: IntakeSource): string {
    if (!s.hasSecret) return 'text-status-needs-input';
    if (!s.enabled || !s.lastReceivedAt) return 'text-muted-foreground';
    return 'text-status-shipped';
  }

  // ───── form
  protected patch(change: Partial<Draft>): void {
    this.form.update((f) => (f ? { ...f, ...change } : f));
  }
  protected startCreate(): void {
    this.secret.set(null);
    this.editing.set(null);
    this.form.set(emptyDraft());
  }
  protected startEdit(s: IntakeSource): void {
    this.secret.set(null);
    this.editing.set(s.id);
    this.form.set({
      provider: s.provider,
      name: s.name,
      subdomain: s.subdomain ?? '',
      secret: '',
      autoCreateCustomers: s.autoCreateCustomers,
      targetProjectId: s.targetProjectId ?? '',
    });
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const f = this.form();
    const slug = this.store.slug();
    if (!f || !slug || !f.name.trim()) return;
    this.busy.set(true);
    try {
      const id = this.editing();
      if (id) {
        const updated = await this.api.intakeSources.update(slug, id, {
          name: f.name.trim(),
          autoCreateCustomers: f.autoCreateCustomers,
          targetProjectId: f.targetProjectId || null,
          ...(f.provider === 'zendesk' ? { subdomain: f.subdomain.trim() || null } : {}),
          ...(f.secret.trim() ? { secret: f.secret.trim() } : {}),
        });
        this.sources.update((list) => list.map((s) => (s.id === id ? updated : s)));
        this.form.set(null);
        this.notify.success('Source updated');
      } else {
        const created = await this.api.intakeSources.create(slug, {
          provider: f.provider,
          name: f.name.trim(),
          autoCreateCustomers: f.autoCreateCustomers,
          ...(f.targetProjectId ? { targetProjectId: f.targetProjectId } : {}),
          ...(f.provider === 'zendesk' && f.subdomain.trim() ? { subdomain: f.subdomain.trim() } : {}),
          ...(!this.generates(f.provider) && f.secret.trim() ? { secret: f.secret.trim() } : {}),
        });
        this.sources.update((list) => [...list, created.source]);
        this.form.set(null);
        if (created.secret) this.secret.set({ value: created.secret, rotated: false });
        else this.notify.success('Source added', { description: 'Copy the endpoint URL into the tool, then add its secret here.' });
      }
    } catch (e) {
      this.fail('Could not save the source', e);
    } finally {
      this.busy.set(false);
    }
  }

  // ───── row actions
  protected async toggle(s: IntakeSource, enabled: boolean): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    try {
      const updated = await this.api.intakeSources.update(slug, s.id, { enabled });
      this.sources.update((list) => list.map((x) => (x.id === s.id ? updated : x)));
    } catch (e) {
      this.fail('Could not update the source', e);
    }
  }

  protected async test(s: IntakeSource): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    this.testing.set(s.id);
    try {
      const result = await this.api.intakeSources.test(slug, s.id);
      this.results.update((r) => ({ ...r, [s.id]: result }));
    } catch (e) {
      this.fail('Test failed', e);
    } finally {
      this.testing.set(null);
    }
  }

  protected rotate(s: IntakeSource): void {
    this.ui.setConfirmDelete({
      title: `Rotate the secret of ${s.name}?`,
      description: 'The current secret stops working at once: deliveries fail until you paste the new one into the sending tool.',
      confirmLabel: 'Rotate secret',
      onConfirm: async () => {
        const slug = this.store.slug();
        if (!slug) return;
        try {
          const res = await this.api.intakeSources.rotateSecret(slug, s.id);
          this.sources.update((list) => list.map((x) => (x.id === s.id ? res.source : x)));
          if (res.secret) setTimeout(() => this.secret.set({ value: res.secret!, rotated: true }));
        } catch (e) {
          this.fail('Could not rotate the secret', e);
        }
      },
    });
  }

  protected remove(s: IntakeSource): void {
    this.ui.setConfirmDelete({
      title: `Delete ${s.name}?`,
      description: 'The endpoint stops working and requests still waiting in the inbox from this source are removed. Requests already linked to issues stay.',
      confirmLabel: 'Delete source',
      onConfirm: async () => {
        const slug = this.store.slug();
        if (!slug) return;
        try {
          await this.api.intakeSources.remove(slug, s.id);
          this.sources.update((list) => list.filter((x) => x.id !== s.id));
        } catch (e) {
          this.fail('Could not delete the source', e);
        }
      },
    });
  }

  private fail(title: string, e: unknown): void {
    const err = ApiError.from(e);
    if (err.status !== 403) this.notify.error(title, { description: err.message });
  }
}
