import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { LucideArrowLeft, LucideBan, LucideDynamicIcon, LucidePlus, LucideSettings2, LucideTriangleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TOKEN_SCOPES, type Agent, type ApiToken, type TokenScope } from '../../../core/contracts/domain';
import { PROVIDER_META } from '../../../core/meta';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { EventLine } from '../../../shared/event-line';
import { FullDatePipe, RelativeTimePipe } from '../../../shared/pipes';
import { ProviderIcon } from '../../../shared/provider-icon';
import { AppSelect, type Option } from '../../create/form-kit';
import { ConnectSnippets } from './connect-snippets';
import { SECTION_KIT, SETTINGS_FIELD, type StatCell } from './section-kit';

const EXPIRY: Option[] = [
  { value: '', label: 'No expiry' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];
const AGENT_SCOPES: Option[] = (['write', 'read'] as TokenScope[]).map((s) => ({ value: s, label: TOKEN_SCOPES[s].label }));

/**
 * One agent (v4 frame 11): who it is, what it did, who it acts as, the tokens it works with and how to
 * connect a runtime to it.
 */
@Component({
  selector: 'app-agent-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    LucideDynamicIcon,
    ActorAvatar,
    ProviderIcon,
    AppSelect,
    EventLine,
    ConnectSnippets,
    RelativeTimePipe,
    FullDatePipe,
    ...SECTION_KIT,
  ],
  host: { class: 'flex flex-col gap-9' },
  template: `
    @if (agent(); as a) {
      <div class="relative flex flex-wrap items-center gap-4">
        <button
          type="button"
          class="text-faint hover:text-foreground absolute -top-5 left-0 inline-flex items-center gap-1.5 font-mono text-[10.5px] leading-[normal]"
          (click)="back.emit()"
        >
          <svg [lucideIcon]="backIcon" [size]="12"></svg> Agents
        </button>
        <span class="bg-secondary border-border text-muted-foreground flex size-[52px] shrink-0 items-center justify-center border">
          <app-provider-icon [provider]="a.provider" [size]="24" />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-[5px]">
          <div class="flex min-w-0 items-center gap-2.5">
            <h2 class="font-title text-foreground truncate text-[32px] leading-[normal]">{{ a.name }}</h2>
            <span class="border-border text-text-2 inline-flex shrink-0 items-center gap-[5px] border px-[7px] py-0.5 font-mono text-[10.5px] leading-[normal]">
              <span class="size-1.5" [class]="tokens().length ? 'bg-green' : 'bg-faint'"></span>
              {{ tokens().length ? 'Connected' : 'No token' }}
            </span>
          </div>
          <p class="text-muted-foreground truncate font-mono text-[10.5px] leading-[normal]">
            {{ providerName(a.provider) }} agent{{ a.ownerUserId ? ' · acts as ' + userName(a.ownerUserId) : ' · no owner' }} · added {{ a.createdAt | relativeTime }}
          </p>
        </div>
        @if (canManage()) {
          <button hlmBtn variant="outline" (click)="edit.emit(a)"><svg [lucideIcon]="settingsIcon" [size]="13"></svg> Settings</button>
        }
      </div>

      <app-stat-strip large [cells]="stats()" />

      <div class="flex flex-col gap-8 lg:flex-row">
        <div class="flex min-w-0 flex-1 flex-col gap-7">
          <app-settings-block title="Activity" caption="latest">
            <div>
              @for (e of activity(); track e.id) {
                <app-event-line [event]="e" [slug]="slug()" compact hideDetail />
              } @empty {
                <div class="text-muted-foreground border-border border-t py-6 text-center text-[13px]">No activity recorded for this agent yet.</div>
              }
            </div>
          </app-settings-block>

          <app-settings-block title="Connect">
            <app-connect-snippets [token]="lastSecret()" [scope]="$any(scope())" />
          </app-settings-block>
        </div>

        <aside class="flex w-full shrink-0 flex-col gap-6 lg:w-[300px]">
          <div class="bg-card border-border flex flex-col gap-2.5 border p-3.5">
            <span class="text-faint font-mono text-[10.5px] leading-[normal]">ACTS AS</span>
            @if (a.ownerUserId) {
              <div class="flex items-center gap-2.5">
                <app-actor-avatar [actor]="{ type: 'user', id: a.ownerUserId }" [size]="28" />
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-foreground truncate text-[13px] leading-[normal]">{{ userName(a.ownerUserId) }}</span>
                  <span class="text-muted-foreground font-mono text-[10.5px] leading-[normal]">{{ ownerRole(a.ownerUserId) }}</span>
                </div>
              </div>
              <p class="text-muted-foreground text-[12px] leading-[18px]">
                {{ a.name }} can do anything {{ firstName(a.ownerUserId) }} can, except transfer or delete the workspace.
              </p>
            } @else {
              <p class="text-muted-foreground text-[12px] leading-[18px]">No owner.</p>
            }
          </div>

          <div class="bg-card border-border border">
            <div class="flex items-center gap-2 px-3 py-2.5">
              <span class="text-faint font-mono text-[10.5px] leading-[normal]">TOKENS · {{ tokens().length }}</span>
              <span class="flex-1"></span>
              @if (canTokens() && !creating() && !secret()) {
                <button type="button" class="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 font-mono text-[10.5px] leading-[normal]" (click)="startCreate(a)">
                  <svg [lucideIcon]="plus" [size]="11"></svg> New
                </button>
              }
            </div>
            @if (secret(); as s) {
              <div class="border-border flex flex-col gap-2.5 border-t px-3.5 py-3">
                <p class="text-yellow flex items-start gap-1.5 text-[12.5px] leading-snug">
                  <svg [lucideIcon]="warn" [size]="14" class="mt-px shrink-0"></svg> Copy this token now. You will not be able to see it again.
                </p>
                <app-copy-field [value]="s" label="Token" />
                <div class="flex justify-end"><button hlmBtn variant="outline" (click)="secret.set(null)">Done</button></div>
              </div>
            } @else if (creating()) {
              <form class="border-border flex flex-col gap-2.5 border-t px-3.5 py-3" (submit)="create($event, a)">
                <label class="text-faint flex flex-col gap-1.5 font-mono text-[10.5px]">
                  NAME
                  <input [class]="field" [value]="name()" (input)="name.set($any($event.target).value)" aria-label="Token name" placeholder="laptop, CI…" />
                </label>
                <div class="text-faint flex flex-col gap-1.5 font-mono text-[10.5px]">
                  SCOPE
                  <app-select [options]="scopes" [(value)]="scope" label="Scope" />
                </div>
                <div class="text-faint flex flex-col gap-1.5 font-mono text-[10.5px]">
                  EXPIRATION
                  <app-select [options]="expiry" [(value)]="expiresIn" label="Expiration" />
                </div>
                <div class="flex justify-end gap-2">
                  <button hlmBtn type="button" variant="ghost" (click)="creating.set(false)">Cancel</button>
                  <button hlmBtn type="submit" [disabled]="!name().trim() || busy()">Create token</button>
                </div>
              </form>
            }
            @for (t of tokens(); track t.id) {
              <div class="border-border flex items-start gap-2 border-t px-3 py-2.5">
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class="text-foreground truncate font-mono text-[12px] leading-[normal]">{{ t.name }} <span class="text-faint">{{ t.prefix }}</span></span>
                  <span class="text-faint font-mono text-[10.5px] leading-[normal]">
                    {{ t.expiresAt ? 'Expires ' + (t.expiresAt | fullDate) : 'No expiry' }} · {{ t.lastUsedAt ? 'used ' + (t.lastUsedAt | relativeTime) : 'never used' }}
                  </span>
                </div>
                <span class="bg-secondary border-border text-text-2 shrink-0 border px-[7px] py-0.5 font-mono text-[11px] leading-[normal]">{{ scopeLabel(t) }}</span>
              </div>
            } @empty {
              @if (!creating() && !secret()) {
                <div class="text-muted-foreground border-border border-t px-3.5 py-4 text-[12.5px] leading-snug">No tokens yet.</div>
              }
            }
          </div>

          @if (canManage() && tokens().length) {
            <div>
              <button hlmBtn variant="destructive" (click)="revokeAll()">
                <svg [lucideIcon]="banIcon" [size]="13"></svg> Revoke all tokens
              </button>
            </div>
          }
        </aside>
      </div>
    } @else {
      <div class="text-muted-foreground py-10 text-center text-[13px]">
        This agent no longer exists.
        <button type="button" class="text-foreground underline" (click)="back.emit()">Back to agents</button>
      </div>
    }
  `,
})
export class AgentDetail {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);

  readonly agentId = input.required<string>();
  readonly back = output<void>();
  readonly edit = output<Agent>();

  protected readonly field = SETTINGS_FIELD;
  protected readonly backIcon = LucideArrowLeft;
  protected readonly settingsIcon = LucideSettings2;
  protected readonly plus = LucidePlus;
  protected readonly warn = LucideTriangleAlert;
  protected readonly banIcon = LucideBan;
  protected readonly scopes = AGENT_SCOPES;
  protected readonly expiry = EXPIRY;

  protected readonly agent = computed(() => this.store.agentById().get(this.agentId()));
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canManage = computed(() => this.store.allowed('manageAgents'));
  protected readonly canTokens = computed(() => this.store.allowed('manageAgents') && this.store.allowed('manageTokens'));

  // token creation
  protected readonly creating = signal(false);
  protected readonly name = signal('');
  protected readonly scope = signal<string>('write');
  protected readonly expiresIn = signal('');
  protected readonly busy = signal(false);
  protected readonly secret = signal<string | null>(null);
  /** The most recent secret, kept for the Connect examples until the panel is left. */
  protected readonly lastSecret = signal<string | null>(null);

  protected readonly tokens = computed(() =>
    this.store
      .tokens()
      .filter((t) => t.actor.type === 'agent' && t.actor.id === this.agentId())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  );

  private readonly mine = computed(() => this.store.events().filter((e) => e.actor.type === 'agent' && e.actor.id === this.agentId()));
  protected readonly activity = computed(() => this.mine().slice(0, 12));

  protected readonly stats = computed<StatCell[]>(() => {
    return [{ label: 'Actions', value: String(this.mine().length) }];
  });

  constructor() {
    void this.store.loadTokens();
    effect(() => {
      this.agentId();
      untracked(() => {
        this.creating.set(false);
        this.secret.set(null);
        this.lastSecret.set(null);
      });
    });
  }

  protected providerName(p: string): string {
    return PROVIDER_META[p as keyof typeof PROVIDER_META]?.label ?? p;
  }
  protected userName(id: string): string {
    return this.store.userById().get(id)?.name ?? 'Unknown';
  }
  protected firstName(id: string): string {
    return this.userName(id).split(' ')[0];
  }
  protected ownerRole(id: string): string {
    const role = this.store.members().find((m) => m.user.id === id)?.membership.role;
    return role ? role[0].toUpperCase() + role.slice(1) : 'Member';
  }
  protected scopeLabel(t: ApiToken): string {
    return TOKEN_SCOPES[t.scope ?? 'write'].label;
  }

  protected startCreate(a: Agent): void {
    this.name.set(a.name);
    this.scope.set('write');
    this.expiresIn.set('');
    this.creating.set(true);
  }

  protected async create(event: Event, a: Agent): Promise<void> {
    event.preventDefault();
    const name = this.name().trim();
    if (!name) return;
    const days = Number(this.expiresIn());
    this.busy.set(true);
    const created = await this.store.createToken({
      name,
      agentId: a.id,
      scope: this.scope() as TokenScope,
      expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
    });
    this.busy.set(false);
    if (created) {
      this.creating.set(false);
      this.secret.set(created.secret);
      this.lastSecret.set(created.secret);
    }
  }

  protected revokeAll(): void {
    const all = this.tokens();
    this.ui.setConfirmDelete({
      title: 'Revoke all tokens?',
      description: 'The agent loses access with these tokens immediately.',
      confirmLabel: 'Revoke all',
      onConfirm: async () => {
        for (const t of all) await this.store.deleteToken(t.id);
      },
    });
  }
}
