import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideCheck, LucideDynamicIcon, LucideLoaderCircle, LucideTriangleAlert } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmInputImports } from '@spartan-ng/helm/input';
import { API_BASE_URL, MCP_URL } from '../../core/config';
import { PERMISSION_PRESETS } from '../../core/contracts/domain';
import type { ApiToken } from '../../core/contracts/domain';
import { NablaStore } from '../../core/stores/nabla.store';
import { PageHeader } from '../../shared/page-header';
import { AppSelect, type Option } from '../create/form-kit';
import { CodeBlock } from '../settings/sections/connect-snippets';
import { CopyField, ReadonlyNote } from '../settings/sections/section-kit';

type Client = 'claude-code' | 'cursor' | 'vscode' | 'cli';
type Access = 'contributor' | 'read-only';

/** Same installer the settings page shows (see cli/README.md). */
const INSTALL_URL = 'https://raw.githubusercontent.com/alessandrobrunoh/trama/main/cli/install/install.sh';
const PLACEHOLDER = 'nbl_YOUR_TOKEN';

const CLIENTS: { id: Client; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'vscode', label: 'VS Code' },
  { id: 'cli', label: 'CLI' },
];

const ACCESS: { id: Access; label: string; description: string }[] = [
  {
    id: 'contributor',
    label: 'Contributor (recommended)',
    description: 'Read everything and create or update work: issues, workstreams, comments, artifacts, input requests. Cannot delete, accept decisions, or touch members, tokens and integrations.',
  },
  { id: 'read-only', label: 'Read-only', description: 'Read every resource. The agent can look but never change anything.' },
];

const EXPIRY: Option[] = [
  { value: '30', label: 'Expires in 30 days' },
  { value: '90', label: 'Expires in 90 days' },
  { value: '', label: 'Never expires' },
];

/**
 * `/:workspace/connect`: three steps from nothing to a working agent. Create a narrow token, paste the config for
 * your client, see the first call arrive. The secret is shown once and kept only in this page.
 */
@Component({
  selector: 'app-connect-agent-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmButtonImports, HlmInputImports, LucideDynamicIcon, PageHeader, AppSelect, CodeBlock, CopyField, ReadonlyNote],
  host: { class: 'block min-h-full' },
  template: `
    <app-page-header title="Connect your agent" description="Let Claude Code, Cursor or the CLI read and report on this workspace" />

    <div class="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-8">
      <p class="text-muted-foreground text-[13px] leading-relaxed">
        An agent talks to Trama through the MCP server or the <code class="font-mono text-xs">trama</code> CLI, with a token that decides what it may do.
        Create one that can only do what the agent needs, add it to your client, and Trama shows you when the first call arrives.
      </p>

      <!-- 1 -->
      <section aria-labelledby="step-token">
        <h2 id="step-token" class="mb-3 flex items-center gap-2 text-[15px] font-semibold">
          <span class="bg-foreground text-background flex size-5 items-center justify-center rounded-full text-[11px]">1</span>
          Create a token with narrow access
        </h2>
        @if (!canCreate()) {
          <app-readonly-note>
            Your role cannot create API tokens here. Ask an admin for a token, then continue with step 2 using the placeholder.
          </app-readonly-note>
        } @else if (secret(); as s) {
          <div class="bg-card flex flex-col gap-3 rounded-lg border p-4">
            <p class="text-status-needs-input flex items-center gap-1.5 text-[13px] font-medium">
              <svg [lucideIcon]="warn" [size]="14"></svg>
              Copy this token now. You will not be able to see it again.
            </p>
            <app-copy-field [value]="s" label="Token" />
            <p class="text-muted-foreground text-xs">The commands below already contain it. Manage or revoke it in <a class="underline underline-offset-2" [routerLink]="['/', slug(), 'settings', 'tokens']">Settings → API tokens</a>.</p>
          </div>
        } @else {
          <form class="bg-card flex flex-col gap-4 rounded-lg border p-4" (submit)="create($event)">
            <label class="flex flex-col gap-1.5 text-[13px] font-medium">
              Name
              <input hlmInput class="h-8 text-[13px] font-normal" [value]="name()" (input)="rename($any($event.target).value)" placeholder="Claude Code on my laptop" />
              <span class="text-muted-foreground text-xs font-normal">Something that tells you where it is used.</span>
            </label>
            <div role="radiogroup" aria-label="Access" class="grid gap-2 sm:grid-cols-2">
              @for (a of access; track a.id) {
                <button
                  type="button"
                  role="radio"
                  class="hover:bg-accent rounded-md border px-3 py-2 text-left transition-colors"
                  [class.border-primary]="level() === a.id"
                  [class.bg-selected]="level() === a.id"
                  [attr.aria-checked]="level() === a.id"
                  (click)="level.set(a.id)"
                >
                  <span class="block text-[13px] font-medium">{{ a.label }}</span>
                  <span class="text-muted-foreground block text-xs leading-snug">{{ a.description }}</span>
                </button>
              }
            </div>
            <div class="flex flex-wrap items-center justify-between gap-3">
              <app-select size="sm" [options]="expiry" [(value)]="expiresIn" label="Expiration" />
              <button hlmBtn type="submit" size="sm" [disabled]="!name().trim() || busy()">Create token</button>
            </div>
          </form>
        }
      </section>

      <!-- 2 -->
      <section aria-labelledby="step-client">
        <h2 id="step-client" class="mb-3 flex items-center gap-2 text-[15px] font-semibold">
          <span class="bg-foreground text-background flex size-5 items-center justify-center rounded-full text-[11px]">2</span>
          Add Trama to your client
        </h2>
        <div class="flex flex-wrap gap-1" role="tablist" aria-label="Client">
          @for (c of clients; track c.id) {
            <button
              type="button"
              role="tab"
              class="hover:bg-accent text-muted-foreground hover:text-foreground h-8 rounded-md px-3 text-[13px] transition-colors"
              [class.bg-accent]="client() === c.id"
              [class.text-foreground]="client() === c.id"
              [class.font-medium]="client() === c.id"
              [attr.aria-selected]="client() === c.id"
              (click)="client.set(c.id)"
            >
              {{ c.label }}
            </button>
          }
        </div>
        <ol class="text-muted-foreground mt-3 mb-3 list-decimal space-y-1 ps-5 text-[13px] leading-snug">
          @for (line of guide().steps; track line) {
            <li>{{ line }}</li>
          }
        </ol>
        <app-code-block [code]="guide().code" [label]="guide().label" />
        @if (!secret()) {
          <p class="text-muted-foreground mt-2 text-xs leading-snug">
            <code class="font-mono">{{ placeholder }}</code> is a placeholder. Create a token in step 1 and it fills in by itself.
          </p>
        }
      </section>

      <!-- 3 -->
      <section aria-labelledby="step-check">
        <h2 id="step-check" class="mb-3 flex items-center gap-2 text-[15px] font-semibold">
          <span class="bg-foreground text-background flex size-5 items-center justify-center rounded-full text-[11px]">3</span>
          Check the connection
        </h2>
        <div class="bg-card flex flex-col gap-2 rounded-lg border p-4 text-[13px]" role="status" aria-live="polite">
          @if (connected()) {
            <p class="text-status-done flex items-center gap-2 font-medium">
              <svg [lucideIcon]="check" [size]="15" [strokeWidth]="2.5"></svg>
              Connected. Your agent just called Trama.
            </p>
            <p class="text-muted-foreground text-xs">Next, give it something to do: <a class="underline underline-offset-2" [routerLink]="['/', slug(), 'workstreams']">open a workstream</a> and ask it to pick up the context.</p>
          } @else if (createdId()) {
            <p class="text-muted-foreground flex items-center gap-2">
              <svg [lucideIcon]="spinner" [size]="14" class="animate-spin"></svg>
              Waiting for the first call from your agent…
            </p>
            <p class="text-muted-foreground text-xs">Ask it something like “list my open Trama issues”. This page updates by itself.</p>
          } @else {
            <p class="text-muted-foreground">Create a token and add it to your client. When the first call arrives, it shows up here.</p>
          }
        </div>
      </section>
    </div>
  `,
})
export class ConnectAgentPage {
  private readonly store = inject(NablaStore);
  private readonly api = inject(API_BASE_URL).replace(/\/$/, '');
  private readonly mcpUrl = inject(MCP_URL);

  protected readonly clients = CLIENTS;
  protected readonly access = ACCESS;
  protected readonly expiry = EXPIRY;
  protected readonly placeholder = PLACEHOLDER;
  protected readonly warn = LucideTriangleAlert;
  protected readonly check = LucideCheck;
  protected readonly spinner = LucideLoaderCircle;

  protected readonly client = signal<Client>('claude-code');
  protected readonly name = signal('Claude Code');
  protected readonly level = signal<Access>('contributor');
  protected readonly expiresIn = signal('30');
  protected readonly busy = signal(false);
  protected readonly secret = signal<string | null>(null);
  protected readonly createdId = signal<string | null>(null);

  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canCreate = computed(() => this.store.allowed('manageTokens'));
  protected readonly connected = computed(() => {
    const id = this.createdId();
    return !!id && !!this.store.tokens().find((t: ApiToken) => t.id === id)?.lastUsedAt;
  });

  private readonly apiUrl = computed(() =>
    this.api.startsWith('/') && typeof location !== 'undefined' ? location.origin + this.api : this.api,
  );
  private readonly key = computed(() => this.secret() ?? PLACEHOLDER);

  protected readonly guide = computed<{ label: string; steps: string[]; code: string }>(() => {
    const key = this.key();
    const url = this.mcpUrl;
    switch (this.client()) {
      case 'claude-code':
        return {
          label: 'Claude Code command',
          steps: ['Run this in a terminal, in the project you work on.', 'Start Claude Code. Type /mcp to see that trama is connected.'],
          code: `claude mcp add --transport http trama ${url} \\\n  --header "Authorization: Bearer ${key}"`,
        };
      case 'cursor':
        return {
          label: 'Cursor MCP config',
          steps: [
            'Open Cursor Settings → MCP → Add new MCP server, or edit ~/.cursor/mcp.json (.cursor/mcp.json for one project).',
            'Paste this and save. The trama server turns green once it connects.',
          ],
          code: JSON.stringify({ mcpServers: { trama: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
        };
      case 'vscode':
        return {
          label: 'VS Code MCP config',
          steps: [
            'Create .vscode/mcp.json in your project (or run “MCP: Add Server” from the command palette and choose HTTP).',
            'Paste this and use “Start” above the server entry. Agent mode then lists the trama tools.',
          ],
          code: JSON.stringify({ servers: { trama: { type: 'http', url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
        };
      case 'cli':
        return {
          label: 'Shell',
          steps: [
            'Install the trama CLI (macOS and Linux; on Windows use install.ps1 next to it).',
            'Log in: the CLI asks for the token, so it never lands in your shell history.',
            'Optionally teach your coding agent the commands with the skill.',
          ],
          code: [
            `curl -fsSL ${INSTALL_URL} | sh`,
            `trama login --api-url ${this.apiUrl()}   # paste ${key === PLACEHOLDER ? 'the token' : key}`,
            `trama whoami`,
            `trama skill install`,
          ].join('\n'),
        };
    }
  });

  constructor() {
    // While waiting for the first call, look at the token every few seconds.
    effect((onCleanup) => {
      if (!this.createdId() || this.connected()) return;
      const t = setInterval(() => void this.store.loadTokens(), 4000);
      onCleanup(() => clearInterval(t));
    });
    // The suggested name follows the client until the person types their own.
    effect(() => {
      const label = CLIENTS.find((c) => c.id === this.client())?.label ?? 'Agent';
      untracked(() => {
        if (!this.nameEdited || !this.name().trim()) this.name.set(label);
      });
    });
    inject(DestroyRef).onDestroy(() => this.secret.set(null));
    void this.store.loadTokens();
  }

  private nameEdited = false;

  protected rename(value: string): void {
    this.nameEdited = true;
    this.name.set(value);
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.name().trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    const days = Number(this.expiresIn());
    const created = await this.store.createToken({
      name,
      scope: 'custom',
      permissions: [...PERMISSION_PRESETS[this.level()].permissions],
      expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined,
    });
    this.busy.set(false);
    if (created) {
      this.secret.set(created.secret);
      this.createdId.set(created.token.id);
    }
  }
}
