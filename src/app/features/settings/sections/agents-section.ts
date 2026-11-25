import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { LucideArrowRight, LucideChevronRight, LucideDynamicIcon, LucidePencil, LucidePlus, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import type { Agent, ExecutionProvider } from '../../../core/contracts/domain';
import { PROVIDER_META, PROVIDERS } from '../../../core/meta';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { AgoPipe } from '../../../shared/ago';
import { ProviderIcon } from '../../../shared/provider-icon';
import { AppSelect, type Option } from '../../create/form-kit';
import { AgentConnect, AGENT_CLIENTS, type AgentClient } from './agent-connect';
import { AgentDetail } from './agent-detail';
import { SECTION_KIT, SETTINGS_FIELD, type SegmentedOption } from './section-kit';

type AgentProvider = Exclude<ExecutionProvider, 'human'>;
type Filter = 'all' | 'mine' | 'active';
const NONE = '';
const DAY_MS = 86_400_000;

interface Draft {
  name: string;
  provider: string;
  description: string;
  owner: string;
}

const emptyDraft = (): Draft => ({ name: '', provider: 'claude_code', description: '', owner: NONE });

/**
 * Settings · Agents (v4 frames 10 to 12): the agents that work in this workspace as the person who connected
 * them, a way to connect another, and each agent's own page. Admins add and edit them.
 */
@Component({
  selector: 'app-agents-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    HlmButtonImports,
    LucideDynamicIcon,
    ActorAvatar,
    ProviderIcon,
    AppSelect,
    AgentConnect,
    AgentDetail,
    AgoPipe,
    ...SECTION_KIT,
  ],
  host: { class: 'flex flex-col gap-9' },
  template: `
    @if (connecting(); as c) {
      <app-agent-connect [initialClient]="c" (back)="connecting.set(null)" (done)="openAfterConnect($event)" />
    } @else if (openId(); as id) {
      <app-agent-detail [agentId]="id" (back)="openId.set(null)" (edit)="startEdit($event)" />
    } @else {
      <app-section-header
        flush
        title="Agents"
        [description]="'AI agents that work in ' + (store.slug() ?? 'this workspace') + ' through MCP. Each one acts as the person who connected it and can never do more than they can.'"
      >
        @if (canAdmin()) {
          <button actions hlmBtn (click)="connecting.set('claude-code')">
            <svg [lucideIcon]="plus" [size]="13"></svg> Connect an agent
          </button>
        }
      </app-section-header>
      @if (!canAdmin()) {
        <app-readonly-note class="mb-0!">Your role cannot add or change agents. You can still open one to see what it did.</app-readonly-note>
      }

      <div class="flex flex-col gap-4">
        <div class="flex flex-wrap items-center gap-3">
          <app-segmented aria-label="Which agents" [options]="filterOptions" [value]="filter()" (valueChange)="filter.set($any($event))" />
          <span class="flex-1"></span>
          <span class="text-faint font-mono text-[10.5px]">{{ summary() }}</span>
        </div>

        <div class="bg-card border-border border">
          <div class="bg-bg-deep text-faint flex items-center gap-4 px-4 py-2 font-mono text-[10.5px] leading-normal">
            <span class="min-w-0 flex-1 sm:flex-[2]">AGENT</span>
            <span class="hidden min-w-0 flex-[1.5] md:block">ACTS AS</span>
            <span class="hidden min-w-0 flex-1 sm:block">ACCESS</span>
            <span class="w-[120px] shrink-0">LAST SEEN</span>
            <span class="w-16 shrink-0"></span>
          </div>
          @for (a of visible(); track a.id) {
            @if (editing() === a.id) {
              <div class="border-border border-t">
                <ng-container *ngTemplateOutlet="form; context: { $implicit: 'edit' }" />
              </div>
            } @else {
              <div class="group border-border hover:bg-hover/40 flex items-center gap-4 border-t px-4 py-2.5 transition-colors">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-3 text-left outline-none sm:flex-[2]"
                  [attr.aria-label]="'Open ' + a.name"
                  (click)="openId.set(a.id)"
                >
                  <span class="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center">
                    <app-provider-icon [provider]="a.provider" [size]="15" />
                  </span>
                  <span class="flex min-w-0 flex-col gap-px">
                    <span class="text-foreground truncate text-[13.5px]">{{ a.name }}</span>
                    <span class="text-faint truncate font-mono text-[10.5px]">{{ a.description || providerName(a.provider) }}</span>
                  </span>
                </button>
                <span class="text-text-2 hidden min-w-0 flex-[1.5] items-center gap-2 text-[13px] md:flex">
                  @if (a.ownerUserId) {
                    <app-actor-avatar [actor]="{ type: 'user', id: a.ownerUserId }" [size]="18" />
                    <span class="truncate">{{ userName(a.ownerUserId) }}</span>
                  } @else {
                    <span class="text-faint">No owner</span>
                  }
                </span>
                <span class="hidden min-w-0 flex-1 font-mono text-[11.5px] sm:block" [class]="tokenCount(a.id) ? 'text-text-2' : 'text-faint'">
                  {{ tokenCount(a.id) }} {{ tokenCount(a.id) === 1 ? 'token' : 'tokens' }}
                </span>
                <span class="flex w-[120px] shrink-0 flex-col gap-0.5 font-mono text-[10.5px]">
                  @if (lastSeen(a.id); as at) {
                    <span class="text-text-2">{{ at | ago }}</span>
                  } @else {
                    <span class="text-faint">never</span>
                  }
                </span>
                <span class="flex w-16 shrink-0 items-center justify-end gap-0.5">
                  @if (canAdmin()) {
                    <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground size-6" [attr.aria-label]="'Edit ' + a.name" title="Edit" (click)="startEdit(a)">
                      <svg [lucideIcon]="pencil" [size]="13"></svg>
                    </button>
                    <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-red size-6" [attr.aria-label]="'Remove ' + a.name" title="Remove" (click)="remove(a)">
                      <svg [lucideIcon]="trash" [size]="13"></svg>
                    </button>
                  } @else {
                    <svg [lucideIcon]="chevron" [size]="14" class="text-faint"></svg>
                  }
                </span>
              </div>
            }
          } @empty {
            <div class="text-muted-foreground border-border border-t px-4 py-8 text-center text-[13px]">
              {{ store.agents().length ? 'No agent matches.' : 'No agents yet. Connect one to give a coding agent its own identity and token.' }}
            </div>
          }
        </div>
      </div>

      @if (canAdmin()) {
        <app-settings-block title="Connect another">
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            @for (c of clients; track c.id) {
              <button
                type="button"
                class="bg-card border-border hover:border-border-strong focus-visible:ring-ring/50 flex items-center gap-2.5 border px-3.5 py-3 text-left text-[13px] outline-none focus-visible:ring-2"
                (click)="connecting.set(c.id)"
              >
                <svg [lucideIcon]="c.icon" [size]="15" class="text-text-2 shrink-0"></svg>
                <span class="text-foreground min-w-0 flex-1 truncate">{{ c.label }}</span>
                <svg [lucideIcon]="arrow" [size]="13" class="text-faint shrink-0"></svg>
              </button>
            }
          </div>
        </app-settings-block>
      }
    }

    <ng-template #form let-mode>
      <form class="bg-secondary grid gap-3 px-4 py-3.5 sm:grid-cols-2" (submit)="submit($event, mode)">
        <label class="text-faint grid gap-1.5 font-mono text-[10.5px]">
          NAME
          <input [class]="field" placeholder="Claude (backend)" [value]="draft().name" (input)="patch({ name: $any($event.target).value })" />
        </label>
        <div class="text-faint grid gap-1.5 font-mono text-[10.5px]">
          PROVIDER
          <app-select [options]="providers" [value]="draft().provider" (valueChange)="patch({ provider: $event })" label="Provider" />
        </div>
        <label class="text-faint grid gap-1.5 font-mono text-[10.5px] sm:col-span-2">
          DESCRIPTION
          <input [class]="field" placeholder="What does this agent work on?" [value]="draft().description" (input)="patch({ description: $any($event.target).value })" />
        </label>
        <div class="text-faint grid gap-1.5 font-mono text-[10.5px]">
          ACTS AS
          <app-select [options]="owners()" [value]="draft().owner" (valueChange)="patch({ owner: $event })" label="Acts as" placeholder="No owner" />
        </div>
        <div class="flex items-end justify-end gap-2">
          <button hlmBtn type="button" variant="ghost" (click)="cancel()">Cancel</button>
          <button hlmBtn type="submit" [disabled]="!draft().name.trim() || busy()">Save</button>
        </div>
      </form>
    </ng-template>
  `,
})
export class AgentsSection {
  protected readonly store = inject(TramaStore);
  private readonly ui = inject(UiStore);

  /** `?agent=<id>` opens that agent's page. */
  readonly agentId = input<string>();
  protected readonly openId = signal<string | null>(null);
  /** The Connect wizard (v4 frame 12), with the client preselected; null while the list is shown. */
  protected readonly connecting = signal<AgentClient | null>(null);

  protected readonly field = SETTINGS_FIELD;
  protected readonly clients = AGENT_CLIENTS;
  protected readonly plus = LucidePlus;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly chevron = LucideChevronRight;
  protected readonly arrow = LucideArrowRight;
  protected readonly providers: Option[] = PROVIDERS.filter((p) => p !== 'human').map((p) => ({ value: p, label: PROVIDER_META[p].label }));
  protected readonly owners = computed<Option[]>(() => [
    { value: NONE, label: 'No owner' },
    ...this.store.members().map((m) => ({ value: m.user.id, label: m.user.name })),
  ]);
  protected readonly filterOptions: SegmentedOption[] = [
    { value: 'all', label: 'All' },
    { value: 'mine', label: 'Mine' },
    { value: 'active', label: 'Active today' },
  ];

  protected readonly filter = signal<Filter>('all');
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());
  protected readonly busy = signal(false);
  protected readonly canAdmin = computed(() => this.store.allowed('manageAgents'));

  /** Last event time per agent. */
  private readonly lastByAgent = computed(() => {
    const map = new Map<string, string>();
    for (const e of this.store.events()) {
      const id = e.actor.id;
      if (e.actor.type !== 'agent' || !id) continue;
      const prev = map.get(id);
      if (!prev || e.at > prev) map.set(id, e.at);
    }
    return map;
  });
  private readonly tokensByAgent = computed(() => {
    const map = new Map<string, number>();
    for (const t of this.store.tokens()) {
      const id = t.actor.id;
      if (t.actor.type === 'agent' && id) map.set(id, (map.get(id) ?? 0) + 1);
    }
    return map;
  });

  protected readonly visible = computed(() => {
    const me = this.store.me()?.id;
    const since = Date.now() - DAY_MS;
    return this.store.agents().filter((a) => {
      switch (this.filter()) {
        case 'mine':
          return !!me && a.ownerUserId === me;
        case 'active': {
          const at = this.lastByAgent().get(a.id);
          return !!at && Date.parse(at) >= since;
        }
        default:
          return true;
      }
    });
  });
  protected readonly summary = computed(() => {
    const agents = this.store.agents().length;
    const tokens = [...this.tokensByAgent().values()].reduce((s, n) => s + n, 0);
    return `${agents} ${agents === 1 ? 'agent' : 'agents'} · ${tokens} ${tokens === 1 ? 'token' : 'tokens'}`;
  });

  constructor() {
    void this.store.loadTokens();
    effect(() => {
      const id = this.agentId();
      if (id) untracked(() => this.openId.set(id));
    });
  }

  protected tokenCount(id: string): number {
    return this.tokensByAgent().get(id) ?? 0;
  }
  protected lastSeen(id: string): string | undefined {
    return this.lastByAgent().get(id);
  }
  protected providerName(p: string): string {
    return PROVIDER_META[p as keyof typeof PROVIDER_META]?.label ?? p;
  }
  protected userName(id: string): string {
    return this.store.userById().get(id)?.name ?? 'Unknown';
  }
  protected patch(change: Partial<Draft>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  protected openAfterConnect(id: string): void {
    this.connecting.set(null);
    this.openId.set(id);
  }
  protected startEdit(a: Agent): void {
    this.openId.set(null);
    this.draft.set({ name: a.name, provider: a.provider, description: a.description ?? '', owner: a.ownerUserId ?? NONE });
    this.editing.set(a.id);
  }
  protected cancel(): void {
    this.editing.set(null);
  }

  protected async submit(event: Event, mode: 'edit'): Promise<void> {
    event.preventDefault();
    const d = this.draft();
    const name = d.name.trim();
    const id = this.editing();
    if (!name || !id || mode !== 'edit') return;
    this.busy.set(true);
    const ok = await this.store.updateAgent(id, {
      name,
      provider: d.provider as AgentProvider,
      description: d.description.trim() || null,
      ownerUserId: d.owner || null,
    });
    if (ok) this.editing.set(null);
    this.busy.set(false);
  }

  protected remove(a: Agent): void {
    this.ui.setConfirmDelete({
      title: `Remove ${a.name}?`,
      description: 'Its tokens are revoked at once. The activity it recorded stays in the history.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        await this.store.deleteAgent(a.id);
      },
    });
  }
}
