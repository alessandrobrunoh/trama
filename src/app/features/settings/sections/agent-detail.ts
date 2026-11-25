import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { LucideArrowLeft, LucideDynamicIcon, LucideKeyRound, LucidePencil, LucidePlus, LucideTrash2, LucideTriangleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { TOKEN_SCOPES, type Agent, type ApiToken, type TokenScope } from '../../../core/contracts/domain';
import { PROVIDER_META } from '../../../core/meta';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { FullDatePipe, RelativeTimePipe } from '../../../shared/pipes';
import { ProviderIcon } from '../../../shared/provider-icon';
import { AppSelect, type Option } from '../../create/form-kit';
import { EventLine } from '../../../shared/event-line';
import { ConnectSnippets } from './connect-snippets';
import { SECTION_KIT } from './section-kit';

const EXPIRY: Option[] = [
  { value: '', label: 'No expiry' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];
const AGENT_SCOPES: Option[] = (['write', 'read'] as TokenScope[]).map((s) => ({ value: s, label: TOKEN_SCOPES[s].label }));

/**
 * One agent: who it is, the tokens it works with, how to connect a runtime to it,
 * and what it has been doing (attributed activity).
 */
@Component({
  selector: 'app-agent-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HlmButtonImports,
    HlmInputImports,
    LucideDynamicIcon,
    ProviderIcon,
    AppSelect,
    EventLine,
    ConnectSnippets,
    RelativeTimePipe,
    FullDatePipe,
    ...SECTION_KIT,
  ],
  host: { class: 'flex flex-col gap-8' },
  template: `
    @if (agent(); as a) {
      <div>
        <button type="button" class="text-faint hover:text-foreground mb-4 inline-flex items-center gap-1.5 font-mono text-[10.5px]" (click)="back.emit()">
          <svg [lucideIcon]="backIcon" [size]="13"></svg> All agents
        </button>
        <div class="flex flex-wrap items-start gap-4">
          <span class="bg-secondary text-muted-foreground flex size-12 shrink-0 items-center justify-center">
            <app-provider-icon [provider]="a.provider" [size]="24" />
          </span>
          <div class="min-w-0 flex-1">
            <h2 class="font-title text-foreground truncate text-[28px] leading-[32px]">{{ a.name }}</h2>
            <p class="text-faint mt-0.5 font-mono text-[10.5px]">
              {{ providerName(a.provider) }} agent{{ a.ownerUserId ? ' · owned by ' + userName(a.ownerUserId) : ' · no owner' }} · added {{ a.createdAt | relativeTime }}
            </p>
            <p class="text-text-2 mt-2 max-w-[720px] text-[13px] leading-snug">{{ a.description || 'No description yet. Say what this agent works on so teammates know when to rely on it.' }}</p>
          </div>
          @if (canManage()) {
            <div class="flex shrink-0 items-center gap-1">
              <button hlmBtn variant="outline" size="sm" (click)="edit.emit(a)"><svg [lucideIcon]="pencil" [size]="13"></svg> Edit</button>
              <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-red" aria-label="Remove agent" title="Remove" (click)="remove(a)">
                <svg [lucideIcon]="trash" [size]="14"></svg>
              </button>
            </div>
          }
        </div>

        <dl class="border-border mt-6 grid grid-cols-2 border sm:grid-cols-4">
          @for (s of stats(); track s.label) {
            <div class="border-border flex flex-col-reverse gap-1 px-[18px] py-3.5 not-first:border-l">
              <dt class="text-faint font-mono text-[10.5px] leading-[13px]">{{ s.label }}</dt>
              <dd class="font-title text-foreground text-[24px] leading-[28px] tabular-nums">{{ s.value }}</dd>
            </div>
          }
        </dl>
      </div>

      <!-- Tokens -->
      <div>
        <app-settings-group title="Tokens" description="The credentials this agent uses. Everything done with them is attributed to the agent.">
          @if (canTokens() && !creating() && !secret()) {
            <button aside hlmBtn size="sm" variant="outline" class="h-7" (click)="startCreate(a)">
              <svg [lucideIcon]="plus" [size]="13"></svg> New token
            </button>
          }
          @if (secret(); as s) {
            <div class="border-border flex flex-col gap-3 border-b px-1 py-4">
              <p class="text-status-needs-input flex items-center gap-1.5 text-[13px]">
                <svg [lucideIcon]="warn" [size]="14"></svg> Copy this token now. You will not be able to see it again.
              </p>
              <app-copy-field [value]="s" label="Token" />
              <div class="flex justify-end"><button hlmBtn size="sm" variant="outline" (click)="secret.set(null)">Done</button></div>
            </div>
          } @else if (creating()) {
            <form (submit)="create($event, a)">
              <app-settings-row label="Name" description="Where this token runs, like “laptop” or “CI”." wide>
                <input hlmInput class="h-8 w-full text-[13px]" [value]="name()" (input)="name.set($any($event.target).value)" aria-label="Token name" />
              </app-settings-row>
              <app-settings-row label="Scope" [description]="scopeInfo().description" wide>
                <app-select size="sm" [options]="scopes" [(value)]="scope" label="Scope" />
              </app-settings-row>
              <app-settings-row label="Expiration" description="Expired tokens stop working." wide>
                <app-select size="sm" [options]="expiry" [(value)]="expiresIn" label="Expiration" />
              </app-settings-row>
              <div class="flex items-center justify-end gap-2 px-1 py-3">
                <button hlmBtn type="button" variant="ghost" size="sm" (click)="creating.set(false)">Cancel</button>
                <button hlmBtn type="submit" size="sm" [disabled]="!name().trim() || busy()">Create token</button>
              </div>
            </form>
          }
          @for (t of tokens(); track t.id) {
            <div class="border-border hover:bg-secondary flex min-h-12 flex-wrap items-center gap-3 border-b px-1 py-2.5">
              <span class="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center">
                <svg [lucideIcon]="keyIcon" [size]="14"></svg>
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 text-[13px]">
                  <span class="text-foreground truncate">{{ t.name }}</span>
                  <code class="text-faint font-mono text-[11px]">{{ t.prefix }}</code>
                  <span class="border-border text-muted-foreground border px-1.5 font-mono text-[10px] leading-[14px]">{{ scopeLabel(t) }}</span>
                </div>
                <div class="text-faint font-mono text-[10.5px]">
                  Created {{ t.createdAt | relativeTime }} · {{ t.lastUsedAt ? 'used ' + (t.lastUsedAt | relativeTime) : 'never used' }}
                  @if (t.expiresAt) {
                    · <span [title]="t.expiresAt | fullDate">expires {{ t.expiresAt | relativeTime }}</span>
                  }
                </div>
              </div>
              @if (canManage()) {
                <button hlmBtn variant="ghost" size="sm" class="text-muted-foreground hover:text-red h-7" (click)="revoke(t)">Revoke</button>
              }
            </div>
          } @empty {
            @if (!creating() && !secret()) {
              <div class="text-muted-foreground border-border border-b px-4 py-6 text-center text-[13px]">
                No token yet, so this agent cannot call Trama.{{ canTokens() ? ' Create one to connect it.' : '' }}
              </div>
            }
          }
        </app-settings-group>
      </div>

      <!-- Connect -->
      <app-settings-group title="Connect" description="Give your agent runtime these and it reads and updates Trama over the REST API as {{ a.name }}.">
        <div class="flex flex-col gap-3 py-4">
          <ol class="text-muted-foreground list-decimal space-y-1 pl-5 text-[12px] leading-snug">
            <li>Create a token above (write scope lets the agent update work, read scope only lets it look).</li>
            <li>Put the three variables in the runtime’s environment, or call the API directly like in the examples.</li>
            <li>Actions show up in Trama with {{ a.name }}’s name and an agent badge.</li>
          </ol>
          <app-connect-snippets [token]="lastSecret()" [scope]="$any(scope())" />
          <p class="text-faint font-mono text-[10.5px] leading-snug">Agents connect through the Trama MCP server or the REST API with this token.</p>
        </div>
      </app-settings-group>

      <!-- Activity -->
      <app-settings-group title="Recent activity" description="The latest events performed by this agent.">
        <div class="px-1 py-1">
          @for (e of activity(); track e.id) {
            <app-event-line [event]="e" [slug]="slug()" compact hideDetail />
          } @empty {
            <div class="text-muted-foreground py-6 text-center text-[13px]">No activity recorded for this agent yet.</div>
          }
        </div>
      </app-settings-group>
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

  protected readonly backIcon = LucideArrowLeft;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly plus = LucidePlus;
  protected readonly keyIcon = LucideKeyRound;
  protected readonly warn = LucideTriangleAlert;
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
  protected readonly scopeInfo = computed(() => TOKEN_SCOPES[this.scope() as TokenScope] ?? TOKEN_SCOPES.write);

  protected readonly tokens = computed(() =>
    this.store
      .tokens()
      .filter((t) => t.actor.type === 'agent' && t.actor.id === this.agentId())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  );

  private readonly mine = computed(() => this.store.events().filter((e) => e.actor.type === 'agent' && e.actor.id === this.agentId()));
  protected readonly activity = computed(() => this.mine().slice(0, 12));

  protected readonly stats = computed(() => {
    const last = this.mine()[0]?.at;
    const tokens = this.tokens();
    return [
      { label: 'Actions', value: String(this.mine().length) },
      { label: 'Last active', value: last ? this.ago(last) : 'Never' },
      { label: 'Tokens', value: String(tokens.length) },
    ];
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
  protected scopeLabel(t: ApiToken): string {
    return TOKEN_SCOPES[t.scope ?? 'write'].label;
  }
  private ago(iso: string): string {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
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

  protected revoke(t: ApiToken): void {
    this.ui.setConfirmDelete({
      title: `Revoke ${t.name}?`,
      description: 'The agent loses access with this token immediately.',
      confirmLabel: 'Revoke',
      onConfirm: async () => {
        await this.store.deleteToken(t.id);
      },
    });
  }

  protected remove(a: Agent): void {
    this.ui.setConfirmDelete({
      title: `Remove ${a.name}?`,
      description: 'Its tokens are revoked at once. The activity it recorded stays in the history.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        if (await this.store.deleteAgent(a.id)) this.back.emit();
      },
    });
  }
}
