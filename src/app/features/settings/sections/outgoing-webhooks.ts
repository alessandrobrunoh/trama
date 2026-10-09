import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  LucideChevronDown,
  LucideChevronUp,
  LucideDynamicIcon,
  LucideEllipsis,
  LucidePencil,
  LucidePlus,
  LucideRotateCw,
  LucideSend,
  LucideTrash2,
  LucideTriangleAlert,
  LucideWebhook,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { HlmSwitchImports } from '@spartan-ng/helm/switch';
import { WEBHOOK_EVENT_GROUPS, type OutgoingWebhook, type WebhookDeliveryLog } from '../../../core/contracts/domain';
import { Notifier } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { RelativeTimePipe } from '../../../shared/pipes';
import { CodeBlock } from './connect-snippets';
import { SECTION_KIT } from './section-kit';

const VERIFY_SNIPPET = `// Node.js: verify the signature before trusting a delivery
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, rawBody, header) {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  return header?.length === expected.length &&
    timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}
// header = request.headers['x-trama-signature'], rawBody = the unparsed request body`;

const PAYLOAD_SNIPPET = `POST https://your.app/hooks/trama
Content-Type: application/json
X-Trama-Event: issue.created
X-Trama-Delivery: ev_8f3k2…
X-Trama-Signature: sha256=9b74c9897bac…

{
  "id": "ev_8f3k2…",
  "event": "issue.created",
  "workspaceId": "ws_…",
  "at": "2026-10-08T09:30:00.000Z",
  "actor": { "type": "user", "id": "usr_…" },
  "subject": { "type": "issue", "id": "is_…" },
  "data": { "key": "BUG-142", "title": "…" }
}`;

interface Draft {
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
}
const emptyDraft = (): Draft => ({ name: '', url: '', events: [], enabled: true });

/**
 * Custom integrations: outgoing webhooks. Trama POSTs a signed JSON body to your URL for the
 * events you pick. Lives inside Settings → Integrations; managed with the manageIntegrations capability.
 */
@Component({
  selector: 'app-outgoing-webhooks',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmSwitchImports,
    LucideDynamicIcon,
    RelativeTimePipe,
    CodeBlock,
    ...SECTION_KIT,
  ],
  host: { class: 'block' },
  template: `
    <app-settings-group
      title="Custom webhooks"
      description="Send a signed JSON POST to your own URL when something happens in Trama (an issue is filed, a workstream ships…). Feed a chat bridge, a dashboard or any automation."
    >
      @if (canManage() && !form()) {
        <button aside hlmBtn size="sm" variant="outline" class="h-7" (click)="startCreate()">
          <svg [lucideIcon]="plus" [size]="13"></svg> New webhook
        </button>
      }

      @if (secret(); as s) {
        <div class="flex flex-col gap-3 px-4 py-4">
          <p class="text-status-needs-input flex items-center gap-1.5 text-[13px] font-medium">
            <svg [lucideIcon]="warn" [size]="14"></svg>
            {{ s.rotated ? 'New signing secret' : 'Webhook created' }}: copy the secret now. You will not be able to see it again.
          </p>
          <app-copy-field [value]="s.value" label="Signing secret" />
          <p class="text-muted-foreground text-xs leading-snug">
            Every delivery carries <code class="font-mono">X-Trama-Signature: sha256=&lt;HMAC-SHA256 of the raw body with this secret&gt;</code>. Verify it on your side:
          </p>
          <app-code-block [code]="verifySnippet" label="Verification code" />
          <div class="flex justify-end"><button hlmBtn size="sm" variant="outline" (click)="secret.set(null)">Done</button></div>
        </div>
      }

      @if (form(); as f) {
        <form (submit)="save($event)">
          <app-settings-row label="Name" description="What this webhook is for, like “Ops chat bridge”." wide>
            <input hlmInput class="h-8 w-full text-[13px]" placeholder="Ops chat bridge" [value]="f.name" (input)="patch({ name: $any($event.target).value })" aria-label="Webhook name" />
          </app-settings-row>
          <app-settings-row label="Payload URL" description="Trama POSTs here. Must be reachable from the API server; redirects are not followed." wide>
            <input hlmInput type="url" class="h-8 w-full font-mono text-xs" placeholder="https://example.com/hooks/trama" [value]="f.url" (input)="patch({ url: $any($event.target).value })" aria-label="Payload URL" />
          </app-settings-row>
          <div class="px-4 py-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div class="text-[13px] font-medium">Events</div>
                <div class="text-muted-foreground text-xs">Pick what triggers a delivery. “All” also covers events added later.</div>
              </div>
              <button type="button" class="rounded-md border px-2 py-1 text-xs transition-colors" [class]="chip(f.events.includes('*'))" [attr.aria-pressed]="f.events.includes('*')" (click)="toggleAll()">
                All events
              </button>
            </div>
            <div class="mt-3 flex flex-col gap-3" [class.opacity-50]="f.events.includes('*')">
              @for (g of groups; track g.entity) {
                <div>
                  <div class="mb-1 flex items-center gap-2">
                    <span class="text-xs font-medium">{{ g.label }}</span>
                    <button
                      type="button"
                      class="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline disabled:no-underline"
                      [disabled]="f.events.includes('*')"
                      [attr.aria-pressed]="f.events.includes(g.entity + '.*')"
                      (click)="toggleGroup(g.entity)"
                    >
                      {{ f.events.includes(g.entity + '.*') ? 'All selected' : 'Select all' }}
                    </button>
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    @for (e of g.events; track e) {
                      <button
                        type="button"
                        class="rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors disabled:cursor-default"
                        [class]="chip(covered(f.events, e))"
                        [disabled]="f.events.includes('*') || f.events.includes(g.entity + '.*')"
                        [attr.aria-pressed]="covered(f.events, e)"
                        (click)="toggleEvent(e)"
                      >
                        {{ e.slice(g.entity.length + 1) }}
                      </button>
                    }
                  </div>
                </div>
              }
            </div>
          </div>
          <app-settings-row label="Enabled" description="A disabled webhook keeps its settings but receives nothing.">
            <hlm-switch [checked]="f.enabled" (checkedChange)="patch({ enabled: $event })" aria-label="Enabled" />
          </app-settings-row>
          <div class="bg-muted/30 flex items-center justify-end gap-2 px-4 py-2">
            <button hlmBtn type="button" variant="ghost" size="sm" (click)="form.set(null)">Cancel</button>
            <button hlmBtn type="submit" size="sm" [disabled]="!valid() || busy()">{{ editing() ? 'Save' : 'Create webhook' }}</button>
          </div>
        </form>
      }

      @for (w of rows(); track w.id) {
        <div>
          <div class="flex min-h-14 flex-wrap items-center gap-3 px-4 py-2.5">
            <span class="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
              <svg [lucideIcon]="hook" [size]="15"></svg>
            </span>
            <div class="min-w-0 flex-1 basis-48">
              <div class="flex items-center gap-2 text-[13px] font-medium">
                <span class="truncate">{{ w.name }}</span>
                <span class="flex shrink-0 items-center gap-1 text-xs font-normal" [class]="statusClass(w)">
                  <span class="size-1.5 rounded-full bg-current"></span>{{ statusText(w) }}
                </span>
              </div>
              <div class="text-muted-foreground truncate font-mono text-xs" [title]="w.url">{{ w.url }}</div>
              <div class="text-muted-foreground truncate text-xs">{{ summary(w) }}</div>
            </div>
            @if (canManage()) {
              <hlm-switch [checked]="w.enabled" (checkedChange)="toggle(w, $event)" [attr.aria-label]="(w.enabled ? 'Disable ' : 'Enable ') + w.name" />
              <button hlmBtn variant="outline" size="sm" class="h-7" [disabled]="testing() === w.id" (click)="test(w)">
                <svg [lucideIcon]="send" [size]="12"></svg> {{ testing() === w.id ? 'Sending…' : 'Test' }}
              </button>
            }
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground h-7" [attr.aria-expanded]="open() === w.id" (click)="toggleLog(w)">
              Deliveries <svg [lucideIcon]="open() === w.id ? up : down" [size]="13"></svg>
            </button>
            @if (canManage()) {
              <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [hlmDropdownMenuTrigger]="menu" aria-label="Webhook actions">
                <svg [lucideIcon]="more" [size]="16"></svg>
              </button>
              <ng-template #menu>
                <hlm-dropdown-menu class="w-48">
                  <button hlmDropdownMenuItem (triggered)="startEdit(w)"><svg [lucideIcon]="pencil" [size]="14"></svg> Edit</button>
                  <button hlmDropdownMenuItem (triggered)="rotate(w)"><svg [lucideIcon]="rotateIcon" [size]="14"></svg> Rotate secret</button>
                  <button hlmDropdownMenuItem variant="destructive" (triggered)="remove(w)"><svg [lucideIcon]="trash" [size]="14"></svg> Delete</button>
                </hlm-dropdown-menu>
              </ng-template>
            }
          </div>
          @if (open() === w.id) {
            <div class="bg-muted/20 border-t px-4 py-2">
              @let log = logs()[w.id];
              @if (!log) {
                <div class="text-muted-foreground py-3 text-xs">Loading…</div>
              } @else if (!log.length) {
                <div class="text-muted-foreground py-3 text-xs">No deliveries yet. Use Test to send a ping, or trigger one of the selected events.</div>
              } @else {
                <div class="text-muted-foreground grid grid-cols-[4.5rem_minmax(0,1fr)_3rem_4rem] items-center gap-x-3 pb-1 text-[11px] font-medium sm:grid-cols-[6rem_minmax(0,1fr)_4rem_4rem_5rem]">
                  <span>When</span><span>Event</span><span>Status</span><span class="text-right">Time</span><span class="hidden text-right sm:block">Attempt</span>
                </div>
                @for (d of log; track d.id) {
                  <div class="grid grid-cols-[4.5rem_minmax(0,1fr)_3rem_4rem] items-baseline gap-x-3 border-t py-1.5 text-xs sm:grid-cols-[6rem_minmax(0,1fr)_4rem_4rem_5rem]">
                    <span class="text-muted-foreground">{{ d.at | relativeTime }}</span>
                    <span class="min-w-0 truncate font-mono">{{ d.event }}</span>
                    <span class="font-mono tabular-nums" [class]="d.ok ? 'text-status-shipped' : 'text-destructive'">{{ d.status || 'ERR' }}</span>
                    <span class="text-muted-foreground text-right tabular-nums">{{ d.durationMs }} ms</span>
                    <span class="text-muted-foreground hidden text-right tabular-nums sm:block">{{ d.attempt === 1 ? '1st try' : 'retry' }}</span>
                    @if (d.error) {
                      <span class="text-destructive col-span-full mt-0.5 break-words">{{ d.error }}</span>
                    }
                  </div>
                }
              }
            </div>
          }
        </div>
      } @empty {
        @if (!form() && !secret()) {
          <div class="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <p class="text-[13px] font-medium">No custom webhooks yet</p>
            <p class="text-muted-foreground max-w-sm text-xs leading-snug">
              Create one to push Trama events to your own systems. Deliveries are signed with a secret you keep, time out after 5 seconds and are retried once.
            </p>
            @if (canManage()) {
              <button hlmBtn size="sm" variant="outline" (click)="startCreate()"><svg [lucideIcon]="plus" [size]="13"></svg> New webhook</button>
            }
          </div>
        }
      }
      @if (rows().length || form()) {
        <details class="px-4 py-2.5 text-xs">
          <summary class="text-muted-foreground hover:text-foreground cursor-pointer select-none">What does a delivery look like?</summary>
          <div class="mt-2"><app-code-block [code]="payloadSnippet" label="Example delivery" /></div>
        </details>
      }
    </app-settings-group>
  `,
})
export class OutgoingWebhooks {
  private readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly groups = WEBHOOK_EVENT_GROUPS;
  protected readonly verifySnippet = VERIFY_SNIPPET;
  protected readonly payloadSnippet = PAYLOAD_SNIPPET;
  protected readonly plus = LucidePlus;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly rotateIcon = LucideRotateCw;
  protected readonly trash = LucideTrash2;
  protected readonly send = LucideSend;
  protected readonly warn = LucideTriangleAlert;
  protected readonly hook = LucideWebhook;
  protected readonly up = LucideChevronUp;
  protected readonly down = LucideChevronDown;

  protected readonly canManage = computed(() => this.store.allowed('manageIntegrations'));
  protected readonly rows = this.store.outgoingWebhooks;

  protected readonly form = signal<Draft | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly secret = signal<{ value: string; rotated: boolean } | null>(null);
  protected readonly open = signal<string | null>(null);
  protected readonly logs = signal<Record<string, WebhookDeliveryLog[]>>({});
  protected readonly testing = signal<string | null>(null);
  protected readonly valid = computed(() => {
    const f = this.form();
    return !!f && !!f.name.trim() && /^https?:\/\/\S+$/i.test(f.url.trim()) && f.events.length > 0;
  });

  constructor() {
    effect(() => {
      if (this.canManage() && this.store.ready()) untracked(() => void this.store.loadOutgoingWebhooks());
    });
  }

  protected chip(on: boolean): string {
    return on ? 'border-primary bg-selected text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground';
  }
  /** Is `event` selected, directly or through `*` / `entity.*`? */
  protected covered(events: readonly string[], event: string): boolean {
    return events.includes('*') || events.includes(event) || events.includes(event.split('.')[0] + '.*');
  }
  protected summary(w: OutgoingWebhook): string {
    if (w.events.includes('*')) return 'All events';
    const shown = w.events.slice(0, 3).join(', ');
    return w.events.length > 3 ? `${shown} +${w.events.length - 3} more` : shown;
  }
  protected statusText(w: OutgoingWebhook): string {
    if (!w.enabled) return 'Disabled';
    if (w.lastStatus === undefined) return 'No deliveries yet';
    return w.lastStatus >= 200 && w.lastStatus < 300 ? `OK · ${w.lastStatus}` : `Failing · ${w.lastStatus || 'no response'}`;
  }
  protected statusClass(w: OutgoingWebhook): string {
    if (!w.enabled || w.lastStatus === undefined) return 'text-muted-foreground';
    return w.lastStatus >= 200 && w.lastStatus < 300 ? 'text-status-shipped' : 'text-destructive';
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
  protected startEdit(w: OutgoingWebhook): void {
    this.secret.set(null);
    this.editing.set(w.id);
    this.form.set({ name: w.name, url: w.url, events: [...w.events], enabled: w.enabled });
  }
  protected toggleAll(): void {
    this.patch({ events: this.form()?.events.includes('*') ? [] : ['*'] });
  }
  protected toggleGroup(entity: string): void {
    const f = this.form();
    if (!f) return;
    const wildcard = `${entity}.*`;
    const rest = f.events.filter((e) => e !== wildcard && !e.startsWith(`${entity}.`));
    this.patch({ events: f.events.includes(wildcard) ? rest : [...rest, wildcard] });
  }
  protected toggleEvent(event: string): void {
    const f = this.form();
    if (!f) return;
    this.patch({ events: f.events.includes(event) ? f.events.filter((e) => e !== event) : [...f.events, event] });
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    const f = this.form();
    if (!f || !this.valid()) return;
    const input = { name: f.name.trim(), url: f.url.trim(), events: f.events, enabled: f.enabled };
    this.busy.set(true);
    const id = this.editing();
    if (id) {
      if (await this.store.updateWebhook(id, input)) {
        this.form.set(null);
        this.notify.success('Webhook updated');
      }
    } else {
      const res = await this.store.createWebhook(input);
      if (res) {
        this.form.set(null);
        this.secret.set({ value: res.secret, rotated: false });
        this.open.set(null);
      }
    }
    this.busy.set(false);
  }

  // ───── row actions
  protected async toggle(w: OutgoingWebhook, enabled: boolean): Promise<void> {
    await this.store.updateWebhook(w.id, { enabled });
  }

  protected async test(w: OutgoingWebhook): Promise<void> {
    this.testing.set(w.id);
    const log = await this.store.testWebhook(w.id);
    this.testing.set(null);
    if (!log) return;
    if (log.ok) this.notify.success('Ping delivered', { description: `${w.name} answered ${log.status} in ${log.durationMs} ms` });
    else this.notify.error('Ping failed', { description: log.error ?? `${w.name} answered ${log.status}` });
    this.open.set(w.id);
    await this.loadLog(w.id);
  }

  protected async toggleLog(w: OutgoingWebhook): Promise<void> {
    if (this.open() === w.id) {
      this.open.set(null);
      return;
    }
    this.open.set(w.id);
    await this.loadLog(w.id);
  }

  private async loadLog(id: string): Promise<void> {
    const list = await this.store.webhookDeliveries(id);
    this.logs.update((l) => ({ ...l, [id]: list }));
  }

  protected rotate(w: OutgoingWebhook): void {
    this.ui.setConfirmDelete({
      title: `Rotate the secret of ${w.name}?`,
      description: 'The current secret stops working at once: deliveries will fail your signature check until you deploy the new one.',
      confirmLabel: 'Rotate secret',
      onConfirm: async () => {
        const res = await this.store.rotateWebhookSecretFor(w.id);
        if (res) setTimeout(() => this.secret.set({ value: res.secret, rotated: true }));
      },
    });
  }

  protected remove(w: OutgoingWebhook): void {
    this.ui.setConfirmDelete({
      title: `Delete ${w.name}?`,
      description: 'Trama stops sending events to this URL and forgets its delivery log.',
      confirmLabel: 'Delete webhook',
      onConfirm: async () => {
        await this.store.deleteWebhook(w.id);
      },
    });
  }
}
