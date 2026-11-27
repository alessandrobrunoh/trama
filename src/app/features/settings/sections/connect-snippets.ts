import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { LucideCheck, LucideCopy, LucideDynamicIcon } from '@lucide/angular';
import { API_BASE_URL, MCP_URL } from '../../../core/config';
import type { TokenScope } from '../../../core/contracts/domain';
import { Clipboard } from '../../../core/notify/notifier';
import { TramaStore } from '../../../core/stores/trama.store';

export interface CodeTab {
  id: string;
  label: string;
}

/**
 * Monospace block (v4 "Code"): deep fill and hairline, a tab strip on top (underlined active tab, or the single
 * `label` when there are no `tabs`) and a mono "Copy" action on its right.
 */
@Component({
  selector: 'app-code-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideDynamicIcon],
  host: { class: 'bg-bg-deep border-border block min-w-0 border' },
  template: `
    <div class="border-border flex items-stretch border-b">
      <div class="flex min-w-0 flex-1 overflow-x-auto" [attr.role]="tabs().length ? 'tablist' : null" aria-label="Examples">
        @for (t of tabs(); track t.id) {
          <button
            type="button"
            role="tab"
            class="-mb-px border-b-2 px-3 py-2 font-mono text-[11.5px] leading-[normal] whitespace-nowrap transition-colors"
            [class]="
              activeTab() === t.id ? 'border-primary text-foreground' : 'text-muted-foreground hover:text-foreground border-transparent'
            "
            [attr.aria-selected]="activeTab() === t.id"
            (click)="tabChange.emit(t.id)"
          >
            {{ t.label }}
          </button>
        } @empty {
          <span class="border-primary text-foreground -mb-px border-b-2 px-3 py-2 font-mono text-[11.5px] leading-[normal] whitespace-nowrap">
            {{ label() || 'Code' }}
          </span>
        }
      </div>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-[5px] px-3 font-mono text-[10.5px] leading-[normal] transition-colors"
        [attr.aria-label]="'Copy ' + (label() || 'code')"
        (click)="copy()"
      >
        <svg [lucideIcon]="copied() ? checkIcon : copyIcon" [size]="12"></svg>
        {{ copied() ? 'Copied' : 'Copy' }}
      </button>
    </div>
    <pre class="text-text-2 overflow-x-auto px-3.5 py-3 font-mono text-[11.5px] leading-[21px] whitespace-pre select-all" tabindex="0"><code>{{ code() }}</code></pre>
  `,
})
export class CodeBlock {
  private readonly clipboard = inject(Clipboard);
  readonly code = input.required<string>();
  readonly label = input('');
  /** Optional tab strip; the owner keeps the selected id and listens to `tabChange`. */
  readonly tabs = input<readonly CodeTab[]>([]);
  readonly activeTab = input<string>('');
  readonly tabChange = output<string>();
  protected readonly copied = signal(false);
  protected readonly copyIcon = LucideCopy;
  protected readonly checkIcon = LucideCheck;

  protected async copy(): Promise<void> {
    if (!(await this.clipboard.copy(this.code(), this.label() ? `${this.label()} copied` : 'Copied to clipboard'))) return;
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}

/** Installer of the trama CLI (see cli/README.md). */
const INSTALL_URL = 'https://raw.githubusercontent.com/alessandrobrunoh/trama/main/cli/install/install.sh';

type Tab = 'mcp-cli' | 'mcp-json' | 'cli' | 'read' | 'write';

/**
 * Copy-paste examples for connecting an MCP client (the trama-mcp server) or calling the Trama REST
 * API directly with a token. Every route shown exists (see server/API.md).
 */
@Component({
  selector: 'app-connect-snippets',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CodeBlock],
  host: { class: 'flex flex-col gap-3' },
  template: `
    <app-code-block [code]="code()" [label]="label()" [tabs]="tabs()" [activeTab]="tab()" (tabChange)="setTab($event)" />
  `,
})
export class ConnectSnippets {
  private readonly store = inject(TramaStore);
  private readonly base = inject(API_BASE_URL).replace(/\/$/, '');
  private readonly mcpUrl = inject(MCP_URL);

  /** The plaintext secret (just created), or null to show a placeholder. */
  readonly token = input<string | null>(null);
  readonly scope = input<TokenScope>('write');
  protected readonly tab = signal<Tab>('mcp-cli');

  /** Absolute API base: the SPA proxies/serves `/api` from its own origin. */
  protected readonly apiUrl = computed(() => (this.base.startsWith('/') && typeof location !== 'undefined' ? location.origin + this.base : this.base));
  protected readonly slug = computed(() => this.store.slug() ?? 'my-workspace');
  private readonly secret = computed(() => this.token() ?? 'trm_YOUR_TOKEN');

  protected setTab(id: string): void {
    this.tab.set(id as Tab);
  }

  protected readonly tabs = computed<{ id: Tab; label: string }[]>(() => [
    { id: 'mcp-cli', label: 'MCP · Claude Code' },
    { id: 'mcp-json', label: 'MCP · JSON config' },
    { id: 'cli', label: 'CLI' },
    { id: 'read', label: 'Read (curl)' },
    ...(this.scope() === 'read' ? [] : [{ id: 'write' as Tab, label: 'Write (curl)' }]),
  ]);

  protected readonly label = computed(() => {
    switch (this.tab()) {
      case 'mcp-cli':
        return 'Claude Code command';
      case 'mcp-json':
        return 'MCP config';
      case 'cli':
        return 'Shell';
      default:
        return 'curl command';
    }
  });

  protected readonly code = computed(() => {
    const url = this.apiUrl();
    const slug = this.slug();
    switch (this.tab()) {
      case 'mcp-cli':
        return `claude mcp add --transport http trama ${this.mcpUrl} \\\n  --header "Authorization: Bearer ${this.secret()}"`;
      case 'mcp-json':
        return JSON.stringify({ mcpServers: { trama: { url: this.mcpUrl, headers: { Authorization: `Bearer ${this.secret()}` } } } }, null, 2);
      case 'cli':
        return [
          `# install (macOS, Linux); on Windows: irm ${INSTALL_URL.replace('install.sh', 'install.ps1')} | iex`,
          `curl -fsSL ${INSTALL_URL} | sh`,
          ``,
          `trama login --api-url ${url}   # paste the token when asked`,
          `trama whoami`,
          `trama task list --open --limit 5`,
          `trama skill install            # teach Claude Code / agents the commands`,
        ].join('\n');
      case 'read':
        return `curl -H "Authorization: Bearer ${this.secret()}" \\\n  "${url}/w/${slug}/issues"`;
      case 'write':
        return [
          `curl -X POST "${url}/w/${slug}/issues" \\`,
          `  -H "Authorization: Bearer ${this.secret()}" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -d '{"kind":"bug","title":"Created from the API"}'`,
        ].join('\n');
    }
  });
}
