import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal, type OnInit } from '@angular/core';
import {
  LucideArrowLeft,
  LucideArrowRight,
  LucideCheck,
  LucideCode,
  LucideDynamicIcon,
  LucideKeyRound,
  LucideMousePointer2,
  LucidePlug,
  LucideShield,
  LucideSquareTerminal,
  LucideTerminal,
  LucideX,
  type LucideIcon,
} from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { MCP_URL } from '../../../core/config';
import { TOKEN_SCOPES, type ExecutionProvider, type TokenScope } from '../../../core/contracts/domain';
import { Clipboard } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';
import { AppSelect, type Option } from '../../create/form-kit';
import { CodeBlock } from './connect-snippets';
import { SECTION_KIT, SETTINGS_FIELD, SETTINGS_SELECT } from './section-kit';

export type AgentClient = 'claude-code' | 'cursor' | 'vscode' | 'cli' | 'mcp';

interface ClientDef {
  id: AgentClient;
  label: string;
  icon: LucideIcon;
  provider: Exclude<ExecutionProvider, 'human'>;
}

export const AGENT_CLIENTS: readonly ClientDef[] = [
  { id: 'claude-code', label: 'Claude Code', icon: LucideTerminal, provider: 'claude_code' },
  { id: 'cursor', label: 'Cursor', icon: LucideMousePointer2, provider: 'cursor' },
  { id: 'vscode', label: 'VS Code', icon: LucideCode, provider: 'other' },
  { id: 'cli', label: 'Trama CLI', icon: LucideSquareTerminal, provider: 'other' },
  { id: 'mcp', label: 'Other MCP', icon: LucidePlug, provider: 'other' },
];

const EXPIRY: Option[] = [
  { value: '', label: 'No expiry' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];
const SCOPES: Option[] = (['write', 'read'] as TokenScope[]).map((s) => ({ value: s, label: TOKEN_SCOPES[s].label }));

/**
 * Settings · Agents · Connect (v4 frame 12): four short steps that end with a working connection, not just a
 * token. Name the agent, create its token, add Trama to the client, check the connection. The agent and its
 * token are created together at the end of step 2; the secret is only held here, in memory, for step 3.
 */
@Component({
  selector: 'app-agent-connect',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, HlmButtonImports, LucideDynamicIcon, AppSelect, CodeBlock, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-9' },
  template: `
    <button type="button" class="text-faint hover:text-foreground inline-flex w-fit items-center gap-1.5 font-mono text-[10.5px] leading-[normal]" (click)="leave()">
      <svg [lucideIcon]="backIcon" [size]="12"></svg> Agents
    </button>
    <app-section-header
      flush
      title="Connect an agent"
      description="Four short steps. You'll end with a working connection, not just a token."
    />

    @if (!canConnect()) {
      <app-readonly-note class="mb-0!">Your role cannot add agents or create tokens. Ask an admin to connect one.</app-readonly-note>
    }

    <div class="flex flex-col gap-8 lg:flex-row">
      <ol class="border-border min-w-0 flex-1 self-start border">
        <!-- 1 · name -->
        <li [class]="liClass(1)">
          <div class="flex items-center gap-3.5">
            <ng-container *ngTemplateOutlet="marker; context: { n: 1 }" />
            <span class="flex-1 text-[13.5px] leading-[normal]" [class]="step() >= 1 ? 'text-foreground' : 'text-faint'">Name the agent</span>
            @if (step() > 1) {
              <span class="text-muted-foreground min-w-0 truncate font-mono text-[10.5px]">{{ clientDef().label }} · {{ name() }}</span>
              @if (!created()) {
                <button type="button" class="text-muted-foreground hover:text-foreground text-[12px]" (click)="step.set(1)">Edit</button>
              }
            }
          </div>
          @if (step() === 1) {
            <form class="flex flex-col gap-4 pl-[38px]" (submit)="next1($event)">
              <label class="text-faint flex flex-col gap-1.5 font-mono text-[10.5px]">
                NAME
                <input
                  [class]="field"
                  placeholder="Claude Code · Maya's laptop"
                  [value]="name()"
                  [disabled]="!canConnect()"
                  (input)="name.set($any($event.target).value)"
                />
              </label>
              <div class="text-faint flex flex-col gap-1.5 font-mono text-[10.5px]" [class]="selectField">
                ACTS AS
                <app-select [options]="owners()" [value]="owner()" (valueChange)="owner.set($event)" label="Acts as" [disabled]="!canConnect()" />
              </div>
              <div class="flex justify-end">
                <button hlmBtn type="submit" [disabled]="!name().trim() || !canConnect()">Continue</button>
              </div>
            </form>
          }
        </li>

        <!-- 2 · token -->
        <li [class]="liClass(2)">
          <div class="flex items-center gap-3.5">
            <ng-container *ngTemplateOutlet="marker; context: { n: 2 }" />
            <span class="flex-1 text-[13.5px] leading-[normal]" [class]="step() >= 2 ? 'text-foreground' : 'text-faint'">Create its token</span>
            @if (step() > 2) {
              <span class="text-muted-foreground font-mono text-[10.5px]">{{ scopeLabel() }} · {{ expiryText() }}</span>
            } @else if (step() < 2) {
              <span class="text-faint font-mono text-[10.5px]">scope and expiry</span>
            }
          </div>
          @if (step() === 2) {
            <div class="flex flex-col gap-4 pl-[38px]">
              <div class="text-faint flex flex-col gap-1.5 font-mono text-[10.5px]" [class]="selectField">
                SCOPE
                <app-select [options]="scopes" [(value)]="scope" label="Scope" />
              </div>
              <div class="text-faint flex flex-col gap-1.5 font-mono text-[10.5px]" [class]="selectField">
                EXPIRATION
                <app-select [options]="expiry" [(value)]="expiresIn" label="Expiration" />
              </div>
              <div class="flex items-center justify-end gap-2">
                <button hlmBtn type="button" variant="outline" (click)="step.set(1)" [disabled]="busy() || !!created()">Back</button>
                <button hlmBtn type="button" [disabled]="busy() || !canConnect()" (click)="createAll()">
                  <svg [lucideIcon]="keyIcon" [size]="13"></svg> Create agent and token
                </button>
              </div>
            </div>
          }
        </li>

        <!-- 3 · add to the client -->
        <li [class]="liClass(3)">
          <div class="flex items-center gap-3.5">
            <ng-container *ngTemplateOutlet="marker; context: { n: 3 }" />
            <span class="flex-1 text-[13.5px] leading-[normal]" [class]="step() >= 3 ? 'text-foreground' : 'text-faint'">Add Trama to your client</span>
            @if (step() === 3) {
              <span class="text-primary font-mono text-[10.5px]">step 3 of 4</span>
            }
          </div>
          @if (step() >= 3) {
            <div class="flex flex-col gap-4 pl-[38px]" [class.opacity-60]="step() > 3">
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-5 [&>button]:min-w-0" role="radiogroup" aria-label="Client">
                @for (c of clients; track c.id) {
                  <button
                    type="button"
                    role="radio"
                    class="focus-visible:ring-ring/50 flex flex-col items-start gap-2 border p-3 text-left text-[13px] leading-[normal] outline-none focus-visible:ring-2"
                    [class]="client() === c.id ? 'bg-primary/10 border-primary' : 'bg-background border-border hover:border-border-strong'"
                    [attr.aria-checked]="client() === c.id"
                    (click)="client.set(c.id)"
                  >
                    <svg [lucideIcon]="c.icon" [size]="18" class="text-text-2"></svg>
                    <span class="text-foreground">{{ c.label }}</span>
                  </button>
                }
              </div>
              <p class="text-muted-foreground text-[12.5px] leading-[19px]">
                Run this once in your {{ client() === 'claude-code' ? 'terminal' : 'client' }}. The token is filled in and shown only now. Copy it before you leave this page.
              </p>
              <app-code-block
                [code]="snippet().code"
                [label]="snippet().label"
                [tabs]="snippets()"
                [activeTab]="snippet().id"
                (tabChange)="tab.set($event)"
              />
              @if (step() === 3) {
                <div class="flex flex-wrap items-center gap-2">
                  <button type="button" class="text-text-2 hover:text-foreground inline-flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[12px] leading-[normal]" (click)="copy(secret() ?? '', 'Token')">
                    <svg [lucideIcon]="keyIcon" [size]="13"></svg> Copy token only
                  </button>
                  <span class="flex-1"></span>
                  <button hlmBtn type="button" (click)="added()"><svg [lucideIcon]="arrow" [size]="13"></svg> I've added it</button>
                </div>
              }
            </div>
          }
        </li>

        <!-- 4 · check -->
        <li [class]="liClass(4)">
          <div class="flex items-center gap-3.5">
            <ng-container *ngTemplateOutlet="marker; context: { n: 4 }" />
            <span class="flex-1 text-[13.5px] leading-[normal]" [class]="step() >= 4 ? 'text-foreground' : 'text-faint'">Check the connection</span>
            @if (step() < 4) {
              <span class="text-faint font-mono text-[10.5px]">waits for the first call</span>
            }
          </div>
          @if (step() === 4) {
            <div class="flex flex-col gap-4 pl-[38px]">
              @if (connected()) {
                <p class="text-green flex items-center gap-2 text-[13px]">
                  <svg [lucideIcon]="checkIcon" [size]="14"></svg> {{ name() }} made its first call. It is connected.
                </p>
                <div class="flex justify-end"><button hlmBtn type="button" (click)="finish()">Open the agent</button></div>
              } @else {
                <p class="text-muted-foreground text-[12.5px] leading-[19px]">
                  Waiting for the first call from {{ name() }}. Start the client you just set up and ask it something; this page checks again every few seconds.
                </p>
                <div class="flex items-center justify-end gap-2">
                  <button hlmBtn type="button" variant="ghost" (click)="finish()">Skip</button>
                  <button hlmBtn type="button" variant="outline" [disabled]="checking()" (click)="check()">Check now</button>
                </div>
              }
            </div>
          }
        </li>
      </ol>

      <aside class="flex w-full shrink-0 flex-col gap-3.5 self-start lg:w-[280px]">
        <div class="border-border flex flex-col gap-2.5 border p-3.5">
          <span class="text-faint font-mono text-[10.5px] leading-[normal]">WHAT THE AGENT GETS</span>
          <ul class="flex flex-col gap-2.5 text-[12.5px] leading-[normal]">
            <li class="text-text-2 flex items-center gap-2"><svg [lucideIcon]="checkIcon" [size]="13" class="text-green shrink-0"></svg> Acts as {{ ownerName() }}: {{ ownerRole() }}</li>
            <li class="text-text-2 flex items-center gap-2"><svg [lucideIcon]="checkIcon" [size]="13" class="text-green shrink-0"></svg> {{ scopeLabel() }} scope · {{ expiryText() }}</li>
            <li class="text-muted-foreground flex items-center gap-2"><svg [lucideIcon]="xIcon" [size]="13" class="shrink-0"></svg> Can't invite, delete or change roles</li>
          </ul>
        </div>
        <div class="bg-card border-border flex items-start gap-2.5 border px-3.5 py-2.5">
          <svg [lucideIcon]="shield" [size]="14" class="text-muted-foreground mt-0.5 shrink-0"></svg>
          <p class="text-text-2 text-[12.5px] leading-[19px]">
            Agents never get more access than {{ ownerName() }}. If their role changes, the agent changes with it.
          </p>
        </div>
      </aside>
    </div>

    <ng-template #marker let-n="n">
      <span
        class="flex size-6 shrink-0 items-center justify-center font-mono text-[11px]"
        [class]="
          step() > n
            ? 'bg-secondary border-border text-green border'
            : step() === n
              ? 'bg-primary text-primary-foreground'
              : 'border-border text-faint border'
        "
      >
        @if (step() > n) {
          <svg [lucideIcon]="checkIcon" [size]="13"></svg>
        } @else {
          {{ n }}
        }
      </span>
    </ng-template>
  `,
})
export class AgentConnect implements OnInit {
  private readonly store = inject(TramaStore);
  private readonly clipboard = inject(Clipboard);
  private readonly mcpUrl = inject(MCP_URL);

  /** The client picked on the list ("Connect another"). */
  readonly initialClient = input<AgentClient>('claude-code');
  readonly back = output<void>();
  /** The agent that was created, once the person leaves the last step. */
  readonly done = output<string>();

  protected readonly clients = AGENT_CLIENTS;
  protected readonly scopes = SCOPES;
  protected readonly expiry = EXPIRY;
  protected readonly field = SETTINGS_FIELD;
  protected readonly selectField = SETTINGS_SELECT;
  protected readonly backIcon = LucideArrowLeft;
  protected readonly arrow = LucideArrowRight;
  protected readonly checkIcon = LucideCheck;
  protected readonly keyIcon = LucideKeyRound;
  protected readonly xIcon = LucideX;
  protected readonly shield = LucideShield;

  protected readonly step = signal<1 | 2 | 3 | 4>(1);
  protected readonly client = signal<AgentClient>('claude-code');
  protected readonly name = signal('');
  protected readonly owner = signal(this.store.me()?.id ?? '');
  protected readonly scope = signal<string>('write');
  protected readonly expiresIn = signal('90');
  protected readonly busy = signal(false);
  protected readonly checking = signal(false);
  protected readonly tab = signal('');

  /** Set once the agent exists; step 1 is locked after that. */
  protected readonly created = signal<{ agentId: string; tokenId: string | null } | null>(null);
  protected readonly secret = signal<string | null>(null);

  protected readonly canConnect = computed(() => this.store.allowed('manageAgents') && this.store.allowed('manageTokens'));
  protected readonly clientDef = computed(() => AGENT_CLIENTS.find((c) => c.id === this.client()) ?? AGENT_CLIENTS[0]);
  protected readonly owners = computed<Option[]>(() => this.store.members().map((m) => ({ value: m.user.id, label: m.user.name })));
  protected readonly scopeInfo = computed(() => TOKEN_SCOPES[this.scope() as TokenScope] ?? TOKEN_SCOPES.write);
  protected readonly scopeLabel = computed(() => this.scopeInfo().label);
  protected readonly expiryText = computed(() => {
    const days = Number(this.expiresIn());
    return days ? `expires in ${days} days` : 'no expiry';
  });
  protected readonly ownerName = computed(() => this.store.userById().get(this.owner())?.name.split(' ')[0] ?? 'you');
  protected readonly ownerRole = computed(() => {
    const role = this.store.members().find((m) => m.user.id === this.owner())?.membership.role;
    return role ? role[0].toUpperCase() + role.slice(1) : 'Member';
  });

  protected readonly snippets = computed<{ id: string; label: string; code: string }[]>(() => {
    const secret = this.secret() ?? 'trm_YOUR_TOKEN';
    const bearer = `Bearer ${secret}`;
    const json = (key: string) =>
      JSON.stringify({ [key]: { trama: { ...(key === 'servers' ? { type: 'http' } : {}), url: this.mcpUrl, headers: { Authorization: bearer } } } }, null, 2);
    switch (this.client()) {
      case 'claude-code':
        return [
          { id: 'command', label: 'Command', code: `claude mcp add --transport http trama ${this.mcpUrl} \\\n  --header "Authorization: ${bearer}"` },
          { id: 'json', label: 'JSON config', code: json('mcpServers') },
        ];
      case 'cursor':
        return [{ id: 'json', label: 'JSON config', code: json('mcpServers') }];
      case 'vscode':
        return [{ id: 'json', label: 'JSON config', code: json('servers') }];
      case 'cli':
        return [{ id: 'command', label: 'Command', code: `trama login   # paste the token when asked\ntrama whoami\ntrama skill install   # teach your agent the commands` }];
      default:
        return [{ id: 'json', label: 'JSON config', code: json('mcpServers') }];
    }
  });
  protected readonly snippet = computed(() => this.snippets().find((s) => s.id === this.tab()) ?? this.snippets()[0]);

  /** The token the agent was given has been used: the first call arrived. */
  protected readonly connected = computed(() => {
    const id = this.created()?.tokenId;
    return !!id && !!this.store.tokens().find((t) => t.id === id)?.lastUsedAt;
  });

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  ngOnInit(): void {
    this.client.set(this.initialClient());
  }

  /** A step is a plain row; the open one is a card with its content indented under the number. */
  protected liClass(n: number): string {
    const step = this.step();
    const base = n > 1 ? 'border-border border-t ' : '';
    if (step === n) return `${base}bg-card flex flex-col gap-4 px-4 pt-4 pb-5`;
    return `${base}px-4 py-3.5${step < n && n === 4 ? ' opacity-[0.55]' : ''}`;
  }

  protected leave(): void {
    this.back.emit();
  }

  protected next1(event: Event): void {
    event.preventDefault();
    if (!this.name().trim()) return;
    this.step.set(2);
  }

  /** Step 2 → 3: register the agent (once), give it a token and keep the secret for the snippets. */
  protected async createAll(): Promise<void> {
    if (this.busy() || !this.canConnect()) return;
    this.busy.set(true);
    try {
      let agentId = this.created()?.agentId;
      if (!agentId) {
        const agent = await this.store.createAgent({
          name: this.name().trim(),
          provider: this.clientDef().provider,
          ownerUserId: this.owner() || undefined,
        });
        if (!agent) return;
        agentId = agent.id;
        this.created.set({ agentId, tokenId: null });
      }
      const days = Number(this.expiresIn());
      const token = await this.store.createToken({
        name: this.name().trim(),
        agentId,
        scope: this.scope() as TokenScope,
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
      });
      if (!token) return;
      this.created.set({ agentId, tokenId: token.token.id });
      this.secret.set(token.secret);
      this.tab.set('');
      this.step.set(3);
    } finally {
      this.busy.set(false);
    }
  }

  protected added(): void {
    this.step.set(4);
    void this.check();
    this.stopPolling();
    this.timer = setInterval(() => {
      if (this.connected()) this.stopPolling();
      else void this.check();
    }, 5000);
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  protected async check(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    await this.store.loadTokens();
    this.checking.set(false);
  }

  protected async copy(text: string, label: string): Promise<void> {
    if (text) await this.clipboard.copy(text, `${label} copied`);
  }

  protected finish(): void {
    const id = this.created()?.agentId;
    if (id) this.done.emit(id);
    else this.back.emit();
  }
}
