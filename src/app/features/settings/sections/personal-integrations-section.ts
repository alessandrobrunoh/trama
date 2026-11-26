import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  LucideBan,
  LucideDynamicIcon,
  LucideEllipsis,
  LucideKeyRound,
  LucideLock,
  LucidePencil,
  LucidePlus,
  LucideRefreshCw,
  LucideTrash2,
  LucideTriangleAlert,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInputImports } from '@spartan-ng/helm/input';
import type { CreateIntegrationInput, IntegrationDetail } from '../../../core/api/api.types';
import { Notifier } from '../../../core/notify/notifier';
import { PersonalConnectionsStore } from '../../../core/stores/personal-connections.store';
import { UiStore } from '../../../core/stores/ui.store';
import { RelativeTimePipe } from '../../../shared/pipes';
import { ProviderIcon } from '../../../shared/provider-icon';
import { ConnectionAddForm, ConnectionTokenForm, accountLine, needsAttention, statusDot, statusLabel } from './connection-kit';
import { ExternalIdentitiesSection } from './external-identities-section';
import { SECTION_KIT } from './section-kit';

/**
 * Settings · Integrations · Personal (v4 frame "15 Integrations · Personal"): the signed-in person's own
 * accounts (a personal GitHub, a client's GitLab), the same in every workspace, several per provider.
 * Only they can see or change them; on shared projects other people see "via <name>'s connection" and
 * never the token. Workspace-owned connections live under the workspace's Integrations page.
 */
@Component({
  selector: 'app-personal-integrations-section',
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
    ExternalIdentitiesSection,
    ...SECTION_KIT,
  ],
  host: { class: 'block' },
  template: `
    <app-section-header
      title="Integrations"
      description="Your own accounts. Use them in rules on any project you can write to, in any workspace. Several accounts per provider are fine."
    >
      <button actions hlmBtn (click)="openAdd()">
        <svg [lucideIcon]="plus" [size]="13"></svg>
        Add account
      </button>
    </app-section-header>

    @if (adding()) {
      <div class="mb-8">
        <app-connection-add-form scopeWord="personal" [busy]="busy()" (submitted)="add($event)" (cancelled)="adding.set(false)" />
      </div>
    }

    <app-settings-group title="Connections" [caption]="store.connections().length ? '' + store.connections().length : ''">
      @if (store.connections().length) {
        <div class="bg-bg-deep border-border mt-3 border">
          <div class="text-faint grid grid-cols-[minmax(0,1fr)_110px_28px] items-center gap-4 px-4 py-2 font-mono text-[10.5px] sm:grid-cols-[minmax(0,1fr)_120px_120px_28px]">
            <span>ACCOUNT</span>
            <span class="hidden sm:block">ADDED</span>
            <span>STATE</span>
            <span></span>
          </div>
          @for (c of store.connections(); track c.id) {
            <div
              class="border-border grid grid-cols-[minmax(0,1fr)_110px_28px] items-center gap-4 border-t px-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_120px_120px_28px]"
              [class]="needsAttention(c) ? 'bg-red/5' : ''"
            >
              <div class="flex min-w-0 items-center gap-2.5">
                <span class="bg-secondary border-border text-foreground flex size-[30px] shrink-0 items-center justify-center border">
                  <app-provider-icon [provider]="c.provider" [size]="15" />
                </span>
                <div class="flex min-w-0 flex-col gap-[3px]">
                  @if (renaming() === c.id) {
                    <form class="flex items-center gap-2" (submit)="saveName($event, c)">
                      <input
                        hlmInput
                        class="h-7 w-52 text-[13px]"
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
                    <span class="text-foreground truncate text-[13.5px] leading-none">{{ c.label }}</span>
                  }
                  <span class="text-faint truncate font-mono text-[10.5px] leading-none">{{ line(c) }}</span>
                </div>
              </div>
              <span class="text-muted-foreground hidden font-mono text-[11px] sm:block">{{ c.createdAt | relativeTime }}</span>
              <span>
                <span class="border-border text-muted-foreground inline-flex items-center gap-[5px] border px-1.5 py-[3px] font-mono text-[10px] leading-none">
                  <span class="size-1.5" [class]="dot(c.status)" aria-hidden="true"></span>{{ statusText(c.status) }}
                </span>
              </span>
              <button
                hlmBtn
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground"
                [attr.aria-label]="'Actions for ' + c.label"
                [hlmDropdownMenuTrigger]="menu"
              >
                <svg [lucideIcon]="more" [size]="16"></svg>
              </button>
              <ng-template #menu>
                <hlm-dropdown-menu class="w-52">
                  <button hlmDropdownMenuItem (triggered)="startRename(c)"><svg [lucideIcon]="pencil" [size]="14"></svg> Rename</button>
                  <button hlmDropdownMenuItem (triggered)="startEdit(c)"><svg [lucideIcon]="key" [size]="14"></svg> Replace token…</button>
                  @if (c.status !== 'revoked') {
                    <button hlmDropdownMenuItem (triggered)="revoke(c)"><svg [lucideIcon]="ban" [size]="14"></svg> Revoke</button>
                  }
                  <button hlmDropdownMenuItem variant="destructive" (triggered)="remove(c)"><svg [lucideIcon]="trash" [size]="14"></svg> Remove</button>
                </hlm-dropdown-menu>
              </ng-template>
            </div>
            @if (editing() === c.id) {
              <div class="border-border border-t px-4 py-4">
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
          }
        </div>
      } @else if (store.loaded()) {
        <p class="text-muted-foreground max-w-[560px] pt-4 text-[13px] leading-snug">
          No personal accounts yet. Add one to use it in rules on the projects you can write to, next to the workspace's own connections.
        </p>
      }
    </app-settings-group>

    @for (c of attention(); track c.id) {
      <div class="border-red/40 bg-red/5 mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border px-4 py-3" role="alert">
        <svg [lucideIcon]="warn" [size]="16" class="text-red shrink-0"></svg>
        <div class="min-w-0 flex-1">
          <p class="text-foreground text-[13px]">
            {{ c.status === 'revoked' ? c.label + ' was revoked on ' + c.host : (c.lastError ?? c.label + ' was rejected by ' + c.host) }}
          </p>
          <p class="text-muted-foreground mt-0.5 text-[12px] leading-snug">
            Anything that reads through it shows an error to everyone on that project. Reconnect it, or ask an admin to switch the rule to a workspace connection.
          </p>
        </div>
        <button hlmBtn (click)="startEdit(c)">
          <svg [lucideIcon]="refresh" [size]="13"></svg>
          Reconnect
        </button>
      </div>
    }

    <div class="border-border text-muted-foreground mt-6 flex items-start gap-3 border px-4 py-3 text-[12.5px] leading-snug">
      <svg [lucideIcon]="lock" [size]="14" class="mt-0.5 shrink-0"></svg>
      <p>
        Personal connections never share their token. On shared projects, other people only see that a source "receives from GitLab via" your connection,
        by name. If you leave a workspace, its rules that use your connections stop and say so.
      </p>
    </div>

    <app-external-identities class="mt-8 block" />
  `,
})
export class PersonalIntegrationsSection {
  protected readonly store = inject(PersonalConnectionsStore);
  private readonly ui = inject(UiStore);
  private readonly notify = inject(Notifier);

  protected readonly plus = LucidePlus;
  protected readonly more = LucideEllipsis;
  protected readonly pencil = LucidePencil;
  protected readonly key = LucideKeyRound;
  protected readonly refresh = LucideRefreshCw;
  protected readonly ban = LucideBan;
  protected readonly trash = LucideTrash2;
  protected readonly warn = LucideTriangleAlert;
  protected readonly lock = LucideLock;
  protected readonly needsAttention = needsAttention;
  protected readonly line = accountLine;
  protected readonly dot = statusDot;
  protected readonly statusText = statusLabel;

  protected readonly adding = signal(false);
  protected readonly busy = signal(false);
  protected readonly editing = signal<string | null>(null);
  protected readonly renaming = signal<string | null>(null);
  protected readonly nameDraft = signal('');

  /** Connections that need a reconnect, each with its own banner. */
  protected readonly attention = computed(() => this.store.connections().filter(needsAttention));

  constructor() {
    void this.store.load();
  }

  protected openAdd(): void {
    this.editing.set(null);
    this.renaming.set(null);
    this.adding.set(true);
  }

  protected async add(input: CreateIntegrationInput): Promise<void> {
    this.busy.set(true);
    // The webhook secret that comes back is not shown: events of a personal connection are placed by a
    // project's sources, and that is where its webhook is set up.
    const res = await this.store.create(input);
    this.busy.set(false);
    if (!res) return;
    this.adding.set(false);
    this.notify.success('Account connected', { description: res.connection.label });
  }

  protected startRename(c: IntegrationDetail): void {
    this.editing.set(null);
    this.nameDraft.set(c.label);
    this.renaming.set(c.id);
  }

  protected async saveName(event: Event, c: IntegrationDetail): Promise<void> {
    event.preventDefault();
    const label = this.nameDraft().trim();
    if (!label) return;
    if (label === c.label) {
      this.renaming.set(null);
      return;
    }
    this.busy.set(true);
    const res = await this.store.update(c.id, { label });
    this.busy.set(false);
    if (res) this.renaming.set(null);
  }

  protected startEdit(c: IntegrationDetail): void {
    this.renaming.set(null);
    this.editing.set(c.id);
  }

  protected async saveEdit(value: { token?: string; baseUrl: string | null }, c: IntegrationDetail): Promise<void> {
    this.busy.set(true);
    const res = await this.store.update(c.id, value);
    this.busy.set(false);
    if (!res) return;
    this.editing.set(null);
    this.notify.success(c.status === 'revoked' ? 'Connection restored' : 'Connection updated', { description: `Signed in as ${res.account}` });
  }

  protected revoke(c: IntegrationDetail): void {
    this.ui.setConfirmDelete({
      title: `Revoke ${c.label}?`,
      description:
        'The token is wiped and anything reading through this connection stops and shows an error. You can reconnect it later with a new token.',
      confirmLabel: 'Revoke',
      onConfirm: async () => {
        const res = await this.store.revoke(c.id);
        if (res) this.notify.success('Connection revoked', { description: c.label });
      },
    });
  }

  protected remove(c: IntegrationDetail): void {
    this.ui.setConfirmDelete({
      title: `Remove ${c.label}?`,
      description: 'Rules that read through it lose their connection and show an error until you pick another one.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.remove(c.id);
      },
    });
  }
}
