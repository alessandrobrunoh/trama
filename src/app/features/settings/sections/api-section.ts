import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { LucideDynamicIcon, LucideTriangleAlert, LucideX } from '@lucide/angular';
import { TopBarActions } from '../../../layout/page-chrome';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { DEFAULT_TOKEN_LIMITS, MAX_TOKEN_LIMITS, TOKEN_SCOPES, type ApiPermission, type ApiToken, type TokenLimits, type TokenScope } from '../../../core/contracts/domain';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { FullDatePipe, RelativeTimePipe } from '../../../shared/pipes';
import { AppSelect, type Option } from '../../create/form-kit';
import { ConnectSnippets } from './connect-snippets';
import { PermissionMatrix } from './permission-matrix';
import { SECTION_KIT } from './section-kit';

const ME = '';
const EXPIRY: Option[] = [
  { value: '', label: 'No expiry' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

/**
 * Settings · API & MCP (v3 frame 12): tokens for scripts, CI, agents and MCP clients, and how to install
 * the CLI / skill with one. Secrets are shown once, right after creation.
 */
@Component({
  selector: 'app-api-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, LucideDynamicIcon, ActorAvatar, AppSelect, RelativeTimePipe, FullDatePipe, ConnectSnippets, PermissionMatrix, TopBarActions, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-6' },
  template: `
    <ng-template appTopBarActions>
      @if (canCreate() && !creating() && !secret()) {
        <button hlmBtn (click)="creating.set(true)">New token</button>
      }
    </ng-template>

    <div>
      <app-section-header
        title="API & MCP"
        description="Connect the Delta agent to Trama. Give it a token and install the /trama skill, then type /trama TRM-128 in any Delta thread. A token is a password for a script, CI job, AI agent or MCP client (Claude, Cursor…): pick exactly what it may do."
      />
      @if (!canCreate()) {
        <app-readonly-note>Your role cannot create API tokens in this workspace. You can still see and revoke your own.</app-readonly-note>
      }

      @if (secret(); as s) {
        <app-settings-group title="Token created" class="mb-8">
          <div class="flex flex-col gap-3 px-4 py-4">
            <p class="text-status-needs-input flex items-center gap-1.5 text-[13px] font-medium">
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
        </app-settings-group>
      } @else if (creating()) {
        <app-settings-group title="New token" class="mb-8">
          <form (submit)="create($event)">
            <app-settings-row label="Name" description="Something that tells you where it is used, like “CI” or “Claude on my laptop”." wide>
              <input hlmInput class="h-8 w-full text-[13px]" placeholder="CI" autofocus [value]="name()" (input)="name.set($any($event.target).value)" aria-label="Token name" />
            </app-settings-row>
            <app-settings-row label="Acts as" [description]="canAgents() ? 'You, or an agent. An agent token acts with the member role.' : 'The token acts as you. Only people allowed to manage agents can mint tokens for agents.'" wide>
              <app-select size="sm" [options]="actorOptions()" [(value)]="actsAs" [disabled]="!canAgents()" label="Acts as" />
            </app-settings-row>
            <div class="px-4 py-3">
              <div class="text-[13px] font-medium">Scope</div>
              <div class="text-muted-foreground mb-2 text-xs">What the token may do. A scope only ever narrows what the actor could do anyway.</div>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4" role="radiogroup" aria-label="Scope">
                @for (sc of scopes; track sc.id) {
                  <button
                    type="button"
                    role="radio"
                    class="hover:bg-hover rounded-md px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    [class.bg-secondary]="scope() !== sc.id"
                    [class.bg-selected]="scope() === sc.id"
                    [attr.aria-checked]="scope() === sc.id"
                    [disabled]="!scopeAllowed(sc.id)"
                    (click)="scope.set(sc.id)"
                  >
                    <span class="block text-[13px] font-medium">{{ sc.label }}</span>
                    <span class="text-muted-foreground block text-xs leading-snug">{{ sc.description }}</span>
                  </button>
                }
              </div>
            </div>
            @if (scope() === 'custom') {
              <div class="px-4 pb-3">
                <app-permission-matrix [(value)]="permissions" />
              </div>
            }
            <div class="px-4 py-3">
              <div class="text-[13px] font-medium">Usage caps</div>
              <div class="text-muted-foreground mb-2 text-xs">A runaway script or model cannot exceed these. Over the cap, the API answers 429 until the window passes.</div>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
                @for (l of limitFields; track l.key) {
                  <label class="flex flex-col gap-1 text-xs">
                    <span class="text-muted-foreground">{{ l.label }}</span>
                    <input
                      hlmInput
                      type="number"
                      min="1"
                      class="h-8 text-[13px]"
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
            <app-settings-row label="Expiration" description="Expired tokens stop working; revoke them anytime." wide>
              <app-select size="sm" [options]="expiry" [(value)]="expiresIn" label="Expiration" />
            </app-settings-row>
            <div class="bg-muted/30 flex items-center justify-end gap-2 px-4 py-2">
              <button hlmBtn type="button" variant="ghost" size="sm" (click)="cancel()">Cancel</button>
              <button hlmBtn type="submit" size="sm" [disabled]="!name().trim() || busy() || (scope() === 'custom' && !permissions().length)">Create token</button>
            </div>
          </form>
        </app-settings-group>
      }

      <app-settings-section [title]="'1 · ' + (canAdmin() ? 'Tokens' : 'Your tokens')" [caption]="canAdmin() ? 'every token in this workspace' : 'revoke one as soon as it leaks'">
        @for (t of tokens(); track t.id) {
          <div class="border-border flex min-h-[50px] flex-wrap items-center gap-x-3.5 gap-y-1 border-b py-2.5">
            <div class="flex w-[180px] max-w-full min-w-0 flex-col gap-0.5">
              <span class="text-foreground truncate font-mono text-[12px] leading-[15px]">{{ t.name }}</span>
              <span class="text-faint font-mono text-[10px] leading-[13px]">{{ t.prefix }}</span>
            </div>
            <span class="text-foreground flex w-[110px] min-w-0 items-center gap-1.5 text-[12.5px]" title="Acts as">
              <app-actor-avatar [actor]="t.actor" [size]="18" />
              <span class="truncate">{{ actorName(t) }}</span>
            </span>
            <span class="border-border text-muted-foreground border px-[7px] py-0.5 font-mono text-[10.5px] leading-[14px]" [title]="scopeTitle(t)">{{ scopeInfo(t.scope).label }}@if (t.permissions) { · {{ t.permissions.length }} }</span>
            @if (isExpired(t)) {
              <span class="border-red/40 text-red border px-[7px] py-0.5 font-mono text-[10.5px] leading-[14px]">Expired</span>
            } @else if (t.expiresAt) {
              <span class="text-faint font-mono text-[10.5px]" [title]="t.expiresAt | fullDate">expires {{ t.expiresAt | relativeTime }}</span>
            }
            <span class="flex-1"></span>
            <span class="text-faint font-mono text-[10.5px]">{{ t.lastUsedAt ? 'used ' + (t.lastUsedAt | relativeTime) : 'never used' }}</span>
            <button hlmBtn variant="ghost" class="gap-1.5 px-2.5" [attr.aria-label]="'Revoke ' + t.name" (click)="revoke(t)">
              <svg [lucideIcon]="closeIcon" [size]="12"></svg>
              Revoke
            </button>
          </div>
        } @empty {
          <div class="text-faint py-8 text-center font-mono text-[11.5px]">No tokens yet. Create one to let a script or agent call the API.</div>
        }
      </app-settings-section>
    </div>

    <app-settings-section title="2 · On the Delta machine" caption="CLI + skill, or MCP, or the REST API">
      <div class="pt-3"><app-connect-snippets [scope]="'write'" /></div>
    </app-settings-section>
  `,
})
export class ApiSection {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);

  /** Preselect "acts as" this agent (from Agents → Create token). */
  readonly agentId = input<string>();

  protected readonly closeIcon = LucideX;
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
    const caps = t.limits ? `\nCaps: ${t.limits.requestsPerMinute} req/min, ${t.limits.writesPerMinute} writes/min, ${t.limits.writesPerDay} writes/day` : '';
    return (t.permissions ? t.permissions.join(', ') : this.scopeInfo(t.scope).description) + caps;
  }
  protected scopeInfo(s: TokenScope | undefined) {
    return TOKEN_SCOPES[s ?? 'write'];
  }
  protected scopeClass(s: TokenScope | undefined): string {
    return s === 'read' ? 'bg-muted text-muted-foreground' : s === 'admin' ? 'bg-destructive/10 text-destructive' : 'bg-selected text-foreground';
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
