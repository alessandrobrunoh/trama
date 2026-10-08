import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { LucideDynamicIcon, LucideKeyRound, LucidePlus, LucideTriangleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { NablaStore } from '../../../core/stores/nabla.store';
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

/** Personal and agent API tokens. Secrets are shown once, right after creation. */
@Component({
  selector: 'app-tokens-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmInputImports, LucideDynamicIcon, ActorAvatar, AppSelect, RelativeTimePipe, FullDatePipe, ConnectSnippets, PermissionMatrix, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    <div>
      <app-section-header
        title="API tokens"
        description="A token is a password for a script, CI job, AI agent or MCP client (Claude, Cursor…): it lets that program use Trama, as you or as an agent, without logging in. Pick exactly what it may do."
      >
        @if (canCreate() && !creating() && !secret()) {
          <button actions hlmBtn size="sm" (click)="creating.set(true)">
            <svg [lucideIcon]="plus" [size]="14"></svg> New token
          </button>
        }
      </app-section-header>
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
            <app-settings-row label="Acts as" [description]="canAgents() ? 'You, or an agent. An agent token acts with the member role and cannot accept decisions.' : 'The token acts as you. Only people allowed to manage agents can mint tokens for agents.'" wide>
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
                    class="hover:bg-accent rounded-md border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                    [class.border-primary]="scope() === sc.id"
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

      <app-settings-group [title]="canAdmin() ? 'All tokens in this workspace' : 'Your tokens'" description="Revoke a token as soon as it leaks or is no longer needed.">
        @for (t of tokens(); track t.id) {
          <div class="flex min-h-13 flex-wrap items-center gap-3 px-4 py-2.5">
            <span class="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
              <svg [lucideIcon]="keyIcon" [size]="14"></svg>
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 text-[13px] font-medium">
                <span class="truncate">{{ t.name }}</span>
                <code class="text-muted-foreground font-mono text-[11px] font-normal">{{ t.prefix }}</code>
                <span class="rounded px-1 py-px text-[10px] font-normal" [class]="scopeClass(t.scope)" [title]="scopeTitle(t)">{{ scopeInfo(t.scope).label }}@if (t.permissions) { · {{ t.permissions.length }} }</span>
                @if (isExpired(t)) {
                  <span class="bg-destructive/10 text-destructive rounded px-1 py-px text-[10px] font-normal">Expired</span>
                }
              </div>
              <div class="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
                <span>Created {{ t.createdAt | relativeTime }}</span>
                <span>·</span>
                <span>{{ t.lastUsedAt ? 'Used ' + (t.lastUsedAt | relativeTime) : 'Never used' }}</span>
                @if (t.expiresAt && !isExpired(t)) {
                  <span>·</span>
                  <span [title]="t.expiresAt | fullDate">Expires {{ t.expiresAt | relativeTime }}</span>
                }
              </div>
            </div>
            <span class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs" title="Acts as">
              <app-actor-avatar [actor]="t.actor" [size]="18" />
              {{ actorName(t) }}
            </span>
            <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground hover:text-destructive h-7" (click)="revoke(t)">Revoke</button>
          </div>
        } @empty {
          <div class="text-muted-foreground px-4 py-8 text-center text-[13px]">No tokens yet. Create one to let a script or agent call the API.</div>
        }
      </app-settings-group>
    </div>

    <app-settings-group title="Using a token" description="Send it in the Authorization header of any API request.">
      <div class="p-4"><app-connect-snippets [scope]="'write'" /></div>
    </app-settings-group>
  `,
})
export class TokensSection {
  protected readonly store = inject(NablaStore);
  private readonly ui = inject(UiStore);

  /** Preselect "acts as" this agent (from Agents → Create token). */
  readonly agentId = input<string>();

  protected readonly plus = LucidePlus;
  protected readonly keyIcon = LucideKeyRound;
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
