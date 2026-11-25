import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { LucideChevronRight, LucideDynamicIcon, LucidePencil, LucidePlus, LucideTrash2 } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { PROVIDER_META, PROVIDERS } from '../../../core/meta';
import { TramaStore } from '../../../core/stores/trama.store';
import { UiStore } from '../../../core/stores/ui.store';
import type { Agent, ExecutionProvider } from '../../../core/contracts/domain';
import { ActorAvatar } from '../../../shared/actor-avatar';
import { ProviderIcon } from '../../../shared/provider-icon';
import { AppSelect, type Option } from '../../create/form-kit';
import { AgentDetail } from './agent-detail';
import { SECTION_KIT } from './section-kit';

type AgentProvider = Exclude<ExecutionProvider, 'human'>;
const NONE = '';

interface Draft {
  name: string;
  provider: string;
  description: string;
  owner: string;
}

const emptyDraft = (): Draft => ({ name: '', provider: 'claude_code', description: '', owner: NONE });

/** Coding agents that act in this workspace (with their own tokens). Admins add and edit them. */
@Component({
  selector: 'app-agents-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, HlmButtonImports, HlmInputImports, LucideDynamicIcon, ActorAvatar, ProviderIcon, AppSelect, AgentDetail, ...SECTION_KIT],
  host: { class: 'flex flex-col gap-10' },
  template: `
    @if (openId(); as id) {
      <app-agent-detail [agentId]="id" (back)="openId.set(null)" (edit)="startEdit($event)" />
    } @else {
    <div>
      <app-section-header title="Agents" description="AI agents that work in this workspace, each with its own identity and credentials.">
        @if (canAdmin() && !adding()) {
          <button actions hlmBtn size="sm" (click)="startAdd()">
            <svg [lucideIcon]="plus" [size]="14"></svg> Add agent
          </button>
        }
      </app-section-header>
      @if (!canAdmin()) {
        <app-readonly-note>Your role cannot add or change agents. You can still open one to see what it did.</app-readonly-note>
      }

      <div class="border-border mb-8 border-b pb-5">
        <p class="text-muted-foreground max-w-[720px] text-[13px] leading-[21px]">
          An agent is an identity for an AI agent (Claude Code, Codex, Delta…) that reads and updates Trama through the API. Everything it does shows up attributed to it, with an agent badge, so you always know what was done by a person and what by a machine.
        </p>
        <ol class="mt-4 grid gap-4 sm:grid-cols-3">
          <li class="flex flex-col gap-1">
            <span class="text-faint font-mono text-[10px] tracking-[1px] uppercase">1 · Register it</span>
            <span class="text-muted-foreground text-[12.5px] leading-snug">Give it a name, its runtime and an owner who is accountable for it.</span>
          </li>
          <li class="flex flex-col gap-1">
            <span class="text-faint font-mono text-[10px] tracking-[1px] uppercase">2 · Give it a token</span>
            <span class="text-muted-foreground text-[12.5px] leading-snug">A token is its credential. Pick read-only or write; agents never go above member.</span>
          </li>
          <li class="flex flex-col gap-1">
            <span class="text-faint font-mono text-[10px] tracking-[1px] uppercase">3 · Follow its work</span>
            <span class="text-muted-foreground text-[12.5px] leading-snug">Open an agent to see its activity and how to connect it.</span>
          </li>
        </ol>
      </div>

      @if (adding()) {
        <app-settings-group title="New agent" class="mb-8">
          <ng-container *ngTemplateOutlet="form; context: { $implicit: 'add' }" />
        </app-settings-group>
      }

      <app-settings-group title="Agents" [caption]="store.agents().length + ' registered'">
        @for (a of store.agents(); track a.id) {
          @if (editing() === a.id) {
            <ng-container *ngTemplateOutlet="form; context: { $implicit: 'edit' }" />
          } @else {
            <div class="group border-border hover:bg-secondary flex min-h-13 items-center gap-1 border-b pr-1 transition-colors">
              <button type="button" class="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-1 text-left" [attr.aria-label]="'Open ' + a.name" (click)="openId.set(a.id)">
                <span class="bg-secondary text-muted-foreground flex size-7 shrink-0 items-center justify-center">
                  <app-provider-icon [provider]="a.provider" [size]="15" />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2 text-[13px]">
                    <span class="text-foreground truncate">{{ a.name }}</span>
                    <span class="text-faint font-mono text-[10.5px]">{{ providerName(a.provider) }}</span>
                  </span>
                  <span class="text-faint block truncate font-mono text-[10.5px]">{{ a.description || 'No description' }}</span>
                </span>
                @if (a.ownerUserId) {
                  <span class="text-muted-foreground hidden shrink-0 items-center gap-1.5 font-mono text-[10.5px] sm:flex" title="Owner">
                    <app-actor-avatar [actor]="{ type: 'user', id: a.ownerUserId }" [size]="18" />
                    {{ userName(a.ownerUserId) }}
                  </span>
                }
                <span class="text-faint group-hover:text-foreground flex shrink-0 items-center font-mono text-[10.5px]">
                  Open <svg [lucideIcon]="chevron" [size]="13"></svg>
                </span>
              </button>
              @if (canAdmin()) {
                <span class="flex shrink-0 items-center gap-0.5">
                  <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground" [attr.aria-label]="'Edit ' + a.name" title="Edit" (click)="startEdit(a)">
                    <svg [lucideIcon]="pencil" [size]="14"></svg>
                  </button>
                  <button hlmBtn variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-red" [attr.aria-label]="'Remove ' + a.name" title="Remove" (click)="remove(a)">
                    <svg [lucideIcon]="trash" [size]="14"></svg>
                  </button>
                </span>
              }
            </div>
          }
        } @empty {
          <div class="text-muted-foreground border-border border-b px-4 py-8 text-center text-[13px]">No agents yet. Add one to give a coding agent its own identity and token.</div>
        }
      </app-settings-group>
    </div>
    }

    <ng-template #form let-mode>
      <form class="border-border bg-secondary grid gap-3 border-b px-3.5 py-3 sm:grid-cols-2" (submit)="submit($event, mode)">
        <label class="text-faint grid gap-1.5 font-mono text-[10.5px]">
          NAME
          <input hlmInput class="text-foreground h-8 font-sans text-[13px]" placeholder="Claude (backend)" [value]="draft().name" (input)="patch({ name: $any($event.target).value })" />
        </label>
        <div class="text-faint grid gap-1.5 font-mono text-[10.5px]">
          PROVIDER
          <app-select size="sm" [options]="providers" [value]="draft().provider" (valueChange)="patch({ provider: $event })" label="Provider" />
        </div>
        <label class="text-faint grid gap-1.5 font-mono text-[10.5px] sm:col-span-2">
          DESCRIPTION
          <input hlmInput class="text-foreground h-8 font-sans text-[13px]" placeholder="What does this agent work on?" [value]="draft().description" (input)="patch({ description: $any($event.target).value })" />
        </label>
        <div class="text-faint grid gap-1.5 font-mono text-[10.5px]">
          OWNER
          <app-select size="sm" [options]="owners()" [value]="draft().owner" (valueChange)="patch({ owner: $event })" label="Owner" placeholder="No owner" />
        </div>
        <div class="flex items-end justify-end gap-2">
          <button hlmBtn type="button" variant="ghost" size="sm" (click)="cancel()">Cancel</button>
          <button hlmBtn type="submit" size="sm" [disabled]="!draft().name.trim() || busy()">{{ mode === 'add' ? 'Add agent' : 'Save' }}</button>
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

  protected readonly plus = LucidePlus;
  protected readonly pencil = LucidePencil;
  protected readonly trash = LucideTrash2;
  protected readonly chevron = LucideChevronRight;
  protected readonly providers: Option[] = PROVIDERS.filter((p) => p !== 'human').map((p) => ({ value: p, label: PROVIDER_META[p].label }));
  protected readonly owners = computed<Option[]>(() => [
    { value: NONE, label: 'No owner' },
    ...this.store.members().map((m) => ({ value: m.user.id, label: m.user.name })),
  ]);

  protected readonly adding = signal(false);
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal<Draft>(emptyDraft());
  protected readonly busy = signal(false);
  protected readonly canAdmin = computed(() => this.store.allowed('manageAgents'));

  constructor() {
    effect(() => {
      const id = this.agentId();
      if (id) untracked(() => this.openId.set(id));
    });
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

  protected startAdd(): void {
    this.editing.set(null);
    this.draft.set(emptyDraft());
    this.adding.set(true);
  }
  protected startEdit(a: Agent): void {
    this.openId.set(null);
    this.adding.set(false);
    this.draft.set({ name: a.name, provider: a.provider, description: a.description ?? '', owner: a.ownerUserId ?? NONE });
    this.editing.set(a.id);
  }
  protected cancel(): void {
    this.adding.set(false);
    this.editing.set(null);
  }

  protected async submit(event: Event, mode: 'add' | 'edit'): Promise<void> {
    event.preventDefault();
    const d = this.draft();
    const name = d.name.trim();
    if (!name) return;
    this.busy.set(true);
    if (mode === 'add') {
      const created = await this.store.createAgent({
        name,
        provider: d.provider as AgentProvider,
        description: d.description.trim() || undefined,
        ownerUserId: d.owner || undefined,
      });
      if (created) this.adding.set(false);
    } else {
      const id = this.editing();
      if (id) {
        const ok = await this.store.updateAgent(id, {
          name,
          provider: d.provider as AgentProvider,
          description: d.description.trim() || null,
          ownerUserId: d.owner || null,
        });
        if (ok) this.editing.set(null);
      }
    }
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
