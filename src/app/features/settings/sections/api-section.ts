import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucidePlus, LucideTriangleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { DEFAULT_TOKEN_LIMITS, MAX_TOKEN_LIMITS, TOKEN_SCOPES, type ApiPermission, type ApiToken, type TokenLimits, type TokenScope } from '../../../core/contracts/domain';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { FullDatePipe, RelativeTimePipe } from '../../../shared/pipes';
import { AppSelect, type Option } from '../../create/form-kit';
import { ConnectSnippets } from './connect-snippets';
import { PermissionMatrix } from './permission-matrix';
import { SECTION_KIT, SETTINGS_FIELD } from './section-kit';

const ME = '';
const EXPIRY: Option[] = [
  { value: '', label: 'No expiry' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

/** Columns of the token table from the md breakpoint up (token, acts as, scope, limit, expires, last used, action). */
const COLS = 'md:grid md:grid-cols-[minmax(0,1fr)_120px_96px_104px_104px_104px_72px]';

/**
 * Settings · API tokens (v4 frame): tokens for scripts, CI, agents and MCP clients as a table (scope, cap,
 * expiry, last use), a one-time banner with the secret right after creation, how to use one, and the default caps.
 */
@Component({
  selector: 'app-api-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon, RouterLink, ActorAvatar, AppSelect, RelativeTimePipe, FullDatePipe, ConnectSnippets, PermissionMatrix, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <app-section-header
      flush
      title="API tokens"
      description="Tokens for scripts, CI, AI agents and MCP clients. A token acts as you or as an agent, capped by the scope you pick. Its secret is shown once, right after creation."
    >
      @if (canCreate() && !creating() && !secret()) {
        <button actions hlmBtn size="sm" (click)="creating.set(true)">
          <svg [lucideIcon]="plusIcon" [size]="13"></svg>
          New token
        </button>
      }
    </app-section-header>
    @if (!canCreate()) {
      <app-readonly-note class="-mt-5">Your role cannot create API tokens in this workspace. You can still see and revoke your own.</app-readonly-note>
    }

    @if (secret(); as s) {
      <div class="border-green/40 bg-green/10 flex flex-col gap-3 border px-4 py-3.5">
        <div class="flex items-center gap-2.5">
          <span class="text-foreground text-[13px]">Token created</span>
          <span class="text-muted-foreground font-mono text-[10.5px]">shown once</span>
        </div>
        <p class="text-status-needs-input flex items-center gap-1.5 text-[13px]">
          <svg [lucideIcon]="warn" [size]="14"></svg>
          Copy this token now. You will not be able to see it again.
        </p>
        <app-copy-field [value]="s" label="Token" />
        <p class="text-muted-foreground text-xs">Use it like this. The commands below already contain your token.</p>
        <app-connect-snippets [token]="s" [scope]="createdScope()" />
        <div class="flex justify-end">
          <button hlmBtn size="sm" variant="outline" (click)="secret.set(null)">Done</button>
        </div>
      </div>
    } @else if (creating()) {
      <app-settings-block title="New token">
        <form (submit)="create($event)">
          <app-settings-card>
            <app-card-row label="Name" description="Something that tells you where it is used, like “CI” or “Claude on my laptop”." wide>
              <input [class]="field" placeholder="CI" autofocus [value]="name()" (input)="name.set($any($event.target).value)" aria-label="Token name" />
            </app-card-row>
            <app-card-row label="Acts as" [description]="canAgents() ? 'You, or an agent. An agent token acts with the member role.' : 'The token acts as you. Only people allowed to manage agents can mint tokens for agents.'" wide>
              <app-select size="sm" [options]="actorOptions()" [(value)]="actsAs" [disabled]="!canAgents()" label="Acts as" />
            </app-card-row>
            <div class="px-4 py-3.5">
              <div class="text-foreground text-[13.5px]">Scope</div>
              <div class="text-muted-foreground mb-2.5 text-[12.5px]">What the token may do. A scope only ever narrows what the actor could do anyway.</div>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Scope">
                @for (sc of scopes; track sc.id) {
                  <button
                    type="button"
                    role="radio"
                    class="hover:bg-hover px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    [class]="scope() === sc.id ? 'bg-selected border-primary/60 border' : 'bg-secondary border-border border'"
                    [attr.aria-checked]="scope() === sc.id"
                    [disabled]="!scopeAllowed(sc.id)"
                    (click)="scope.set(sc.id)"
                  >
                    <span class="block text-[13px]">{{ sc.label }}</span>
                    <span class="text-muted-foreground block text-xs leading-snug">{{ sc.description }}</span>
                  </button>
                }
              </div>
            </div>
            @if (scope() === 'custom') {
              <div class="px-4 py-3.5">
                <app-permission-matrix [(value)]="permissions" />
              </div>
            }
            <div class="px-4 py-3.5">
              <div class="text-foreground text-[13.5px]">Usage caps</div>
              <div class="text-muted-foreground mb-2.5 text-[12.5px]">A runaway script or model cannot exceed these. Over the cap, the API answers 429 until the window passes.</div>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                @for (l of limitFields; track l.key) {
                  <label class="flex flex-col gap-1 text-xs">
                    <span class="text-muted-foreground">{{ l.label }}</span>
                    <input
                      type="number"
                      min="1"
                      [class]="field"
                      [max]="l.max"
                      [placeholder]="'' + l.default"
                      [value]="limits()[l.key] ?? ''"
                      (input)="setLimit(l.key, $any($event.target).value)"
                      [attr.aria-label]="l.label"
                    />
                  </label>
                }
              </div>
            </div>
            <app-card-row label="Expiration" description="Expired tokens stop working; revoke them anytime." wide>
              <app-select size="sm" [options]="expiry" [(value)]="expiresIn" label="Expiration" />
            </app-card-row>
            <div class="flex items-center justify-end gap-2 px-4 py-2.5">
              <button hlmBtn type="button" variant="ghost" size="sm" (click)="cancel()">Cancel</button>
              <button hlmBtn type="submit" size="sm" [disabled]="!name().trim() || busy() || (scope() === 'custom' && !permissions().length)">Create token</button>
            </div>
          </app-settings-card>
        </form>
      </app-settings-block>
    }

    <div class="bg-card border-border border">
      <div class="bg-bg-deep text-faint hidden items-center gap-4 px-4 py-2 font-mono text-[10.5px]" [class]="cols">
        <span>{{ canAdmin() ? 'TOKEN' : 'YOUR TOKENS' }}</span>
        <span>ACTS AS</span>
        <span>SCOPE</span>
        <span>LIMIT</span>
        <span>EXPIRES</span>
        <span>LAST USED</span>
        <span></span>
      </div>
      @for (t of tokens(); track t.id) {
        <div class="border-border flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t px-4 py-2.5 first:border-t-0 md:first:border-t" [class]="cols">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="text-foreground truncate text-[13px]">{{ t.name }}</span>
            <span class="text-faint font-mono text-[10.5px]">{{ t.prefix }}</span>
          </div>
          <span class="text-foreground flex min-w-0 items-center gap-1.5 text-[12.5px]" title="Acts as">
            <app-actor-avatar [actor]="t.actor" [size]="18" />
            <span class="truncate">{{ actorName(t) }}</span>
          </span>
          <span>
            <span class="border-border bg-secondary text-foreground/80 inline-block border px-[7px] py-0.5 font-mono text-[11px]" [title]="scopeTitle(t)">{{ scopeInfo(t.scope).label }}@if (t.permissions) { · {{ t.permissions.length }} }</span>
          </span>
          <span class="text-muted-foreground font-mono text-[10.5px]" [title]="limitTitle(t)">{{ limitText(t) }}</span>
          <span class="font-mono text-[10.5px]">
            @if (isExpired(t)) {
              <span class="text-red">Expired</span>
            } @else if (t.expiresAt) {
              <span class="text-foreground/80" [title]="t.expiresAt | fullDate">{{ t.expiresAt | relativeTime }}</span>
            } @else {
              <span class="text-primary">Never</span>
            }
          </span>
          <span class="text-muted-foreground font-mono text-[10.5px]">{{ t.lastUsedAt ? (t.lastUsedAt | relativeTime) : 'never used' }}</span>
          <span class="flex justify-end">
            <button hlmBtn variant="ghost" size="sm" [attr.aria-label]="'Revoke ' + t.name" (click)="revoke(t)">Revoke</button>
          </span>
        </div>
      } @empty {
        <div class="text-faint px-4 py-8 text-center font-mono text-[11.5px]">No tokens yet. Create one to let a script or agent call the API.</div>
      }
    </div>

    <div class="border-primary/40 bg-primary/10 text-foreground/80 px-3.5 py-2.5 text-[12.5px] leading-[19px] border">
      Connecting an AI agent? Use
      <a class="text-foreground underline underline-offset-4" [routerLink]="['/', store.slug(), 'settings', 'agents']">Agents → Connect an agent</a>. It creates a scoped token and checks the connection for you.
    </div>

    <app-settings-block title="Use it" description="With a token, call the REST API, install the CLI and skill, or add the MCP server to a client.">
      <app-connect-snippets [scope]="'write'" />
    </app-settings-block>

    <app-settings-block title="Limits">
      <app-settings-card>
        @for (l of limitFields; track l.key) {
          <app-card-row [label]="l.label" [description]="'Default per token; up to ' + l.max + ' when you create one.'">
            <span class="text-foreground font-mono text-[12px]">{{ l.default }}</span>
          </app-card-row>
        }
      </app-settings-card>
    </app-settings-block>
  `,
})
export class ApiSection {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);

  /** Preselect "acts as" this agent (from Agents → Create token). */
  readonly agentId = input<string>();

  protected readonly field = SETTINGS_FIELD;
  protected readonly cols = COLS;
  protected readonly plusIcon = LucidePlus;
  protected readonly warn = LucideTriangleAlert;
  protected readonly expiry = EXPIRY;

  protected readonly creating = signal(false);
  protected readonly name = signal('');
  protected readonly actsAs = signal<string>(ME);
  protected readonly expiresIn = signal('');
  protected readonly busy = signal(false);
  protected readonly secret = signal<string | null>(null);
  protected readonly canAdmin = computed(() => this.store.can('admin'));
  protected readonly canCreate = computed(() => this.store.allowed('manageTokens'));
  protected readonly canAgents = computed(() => this.store.allowed('manageAgents'));
  protected readonly scopes = (Object.keys(TOKEN_SCOPES) as TokenScope[]).map((id) => ({ id, ...TOKEN_SCOPES[id] }));
  protected readonly scope = signal<TokenScope>('write');
  protected readonly permissions = signal<ApiPermission[]>([]);
  protected readonly limits = signal<Partial<TokenLimits>>({});
  protected readonly limitFields: { key: keyof TokenLimits; label: string; default: number; max: number }[] = [
    { key: 'requestsPerMinute', label: 'Requests / minute', default: DEFAULT_TOKEN_LIMITS.requestsPerMinute, max: MAX_TOKEN_LIMITS.requestsPerMinute },
    { key: 'writesPerMinute', label: 'Writes / minute', default: DEFAULT_TOKEN_LIMITS.writesPerMinute, max: MAX_TOKEN_LIMITS.writesPerMinute },
    { key: 'writesPerDay', label: 'Writes / day', default: DEFAULT_TOKEN_LIMITS.writesPerDay, max: MAX_TOKEN_LIMITS.writesPerDay },
  ];
  protected readonly createdScope = signal<TokenScope>('write');
  protected readonly actorOptions = computed<Option[]>(() => [
    { value: ME, label: `Me (${this.store.me()?.name ?? 'you'})` },
    ...(this.canAgents() ? this.store.agents().map((a) => ({ value: a.id, label: a.name, hint: 'agent' })) : []),
  ]);
  protected readonly tokens = computed(() => [...this.store.tokens()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)));
  private readonly now = Date.now();

  constructor() {
    void this.store.loadTokens();
    effect(() => {
      const id = this.agentId();
      if (!id) return;
      untracked(() => {
        const agent = this.store.agentById().get(id);
        this.actsAs.set(id);
        if (agent && !this.name()) this.name.set(agent.name);
        this.creating.set(true);
      });
    });
  }

  /** Admin scope: admins only, and never for agents (they act as members). */
  protected scopeAllowed(s: TokenScope): boolean {
    return s !== 'admin' || (this.canAdmin() && !this.actsAs());
  }
  protected setLimit(key: keyof TokenLimits, raw: string): void {
    const n = Math.floor(Number(raw));
    const max = MAX_TOKEN_LIMITS[key];
    this.limits.update((l) => {
      const next = { ...l };
      if (raw === '' || !Number.isFinite(n) || n < 1) delete next[key];
      else next[key] = Math.min(n, max);
      return next;
    });
  }
  protected scopeTitle(t: ApiToken): string {
    return t.permissions ? t.permissions.join(', ') : this.scopeInfo(t.scope).description;
  }
  protected scopeInfo(s: TokenScope | undefined) {
    return TOKEN_SCOPES[s ?? 'write'];
  }
  /** The request cap of a token, or the workspace default when it has none of its own. */
  protected limitText(t: ApiToken): string {
    return `${t.limits?.requestsPerMinute ?? DEFAULT_TOKEN_LIMITS.requestsPerMinute} / min`;
  }
  protected limitTitle(t: ApiToken): string {
    const l = t.limits ?? DEFAULT_TOKEN_LIMITS;
    return `Caps: ${l.requestsPerMinute} requests/min, ${l.writesPerMinute} writes/min, ${l.writesPerDay} writes/day`;
  }
  protected isExpired(t: ApiToken): boolean {
    return !!t.expiresAt && new Date(t.expiresAt).getTime() <= this.now;
  }
  protected actorName(t: ApiToken): string {
    if (t.actor.type === 'user' && t.actor.id === this.store.me()?.id) return 'You';
    return this.store.resolveActor(t.actor).name;
  }

  protected cancel(): void {
    this.creating.set(false);
    this.name.set('');
    this.actsAs.set(ME);
    this.expiresIn.set('');
    this.scope.set('write');
    this.permissions.set([]);
    this.limits.set({});
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.name().trim();
    if (!name) return;
    const days = Number(this.expiresIn());
    this.busy.set(true);
    const scope = this.scopeAllowed(this.scope()) ? this.scope() : 'write';
    if (scope === 'custom' && !this.permissions().length) {
      this.busy.set(false);
      return;
    }
    const created = await this.store.createToken({
      name,
      scope,
      ...(scope === 'custom' ? { permissions: this.permissions() } : {}),
      ...(Object.keys(this.limits()).length ? { limits: this.limits() } : {}),
      agentId: this.actsAs() || undefined,
      expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
    });
    this.busy.set(false);
    if (created) {
      this.cancel();
      this.createdScope.set(created.token.scope);
      this.secret.set(created.secret);
    }
  }

  protected revoke(t: ApiToken): void {
    this.ui.setConfirmDelete({
      title: `Revoke ${t.name}?`,
      description: 'Anything using this token loses access immediately.',
      confirmLabel: 'Revoke',
      onConfirm: async () => {
        await this.store.deleteToken(t.id);
      },
    });
  }
}
