import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideCheck, LucideCopy, LucideDynamicIcon } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { API_BASE_URL, MCP_URL } from '../../../core/config';
import type { TokenScope } from '../../../core/contracts/domain';
import { Clipboard } from '../../../core/notify/notifier';
import { NablaStore } from '../../../core/stores/nabla.store';

/** Monospace block with a copy button. */
@Component({
  selector: 'app-code-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, LucideDynamicIcon],
  host: { class: 'bg-muted/50 relative block min-w-0 rounded-md border' },
  template: `
    <pre class="overflow-x-auto p-3 pr-11 font-mono text-xs leading-relaxed whitespace-pre select-all" tabindex="0"><code>{{ code() }}</code></pre>
    <button
      hlmBtn
      variant="ghost"
      size="icon-sm"
      class="text-muted-foreground absolute top-1.5 right-1.5 size-7"
      [attr.aria-label]="'Copy ' + (label() || 'code')"
      (click)="copy()"
    >
      <svg [lucideIcon]="copied() ? checkIcon : copyIcon" [size]="13"></svg>
    </button>
  `,
})
export class CodeBlock {
  private readonly clipboard = inject(Clipboard);
  readonly code = input.required<string>();
  readonly label = input('');
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

type Tab = 'mcp-cli' | 'mcp-json' | 'mcp-docker' | 'cli' | 'env' | 'read' | 'write' | 'context';

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
    <div class="flex flex-wrap gap-1" role="tablist" aria-label="Examples">
      @for (t of tabs(); track t.id) {
        <button
          type="button"
          role="tab"
          class="hover:bg-accent text-muted-foreground hover:text-foreground h-7 rounded-md px-2.5 text-xs transition-colors"
          [class.bg-accent]="tab() === t.id"
          [class.text-foreground]="tab() === t.id"
          [class.font-medium]="tab() === t.id"
          [attr.aria-selected]="tab() === t.id"
          (click)="tab.set(t.id)"
        >
          {{ t.label }}
        </button>
      }
    </div>
    <app-code-block [code]="code()" [label]="current().label" />
    <p class="text-muted-foreground text-xs leading-snug">{{ current().hint }}</p>
    @if (!token()) {
      <p class="text-muted-foreground text-xs leading-snug">
        <code class="font-mono">nbl_YOUR_TOKEN</code> is a placeholder: the real secret is only shown once, when the token is created.
      </p>
    }
  `,
})
export class ConnectSnippets {
  private readonly store = inject(NablaStore);
  private readonly base = inject(API_BASE_URL).replace(/\/$/, '');
  private readonly mcpUrl = inject(MCP_URL);

  /** The plaintext secret (just created), or null to show a placeholder. */
  readonly token = input<string | null>(null);
  readonly scope = input<TokenScope>('write');
  protected readonly tab = signal<Tab>('mcp-cli');

  /** Absolute API base: the SPA proxies/serves `/api` from its own origin. */
  protected readonly apiUrl = computed(() => (this.base.startsWith('/') && typeof location !== 'undefined' ? location.origin + this.base : this.base));
  protected readonly slug = computed(() => this.store.slug() ?? 'my-workspace');
  private readonly secret = computed(() => this.token() ?? 'nbl_YOUR_TOKEN');
  private readonly exampleKey = computed(() => this.store.workstreams()[0]?.key ?? 'AUTH-42');

  protected readonly tabs = computed<{ id: Tab; label: string }[]>(() => [
    { id: 'mcp-cli', label: 'MCP · Claude Code' },
    { id: 'mcp-json', label: 'MCP · JSON config' },
    { id: 'mcp-docker', label: 'MCP · Docker' },
    { id: 'cli', label: 'CLI' },
    { id: 'env', label: 'Environment' },
    { id: 'read', label: 'Read (curl)' },
    ...(this.scope() === 'read' ? [] : [{ id: 'write' as Tab, label: 'Write (curl)' }]),
    { id: 'context', label: 'Agent context' },
  ]);

  protected readonly current = computed<{ label: string; hint: string }>(() => {
    switch (this.tab()) {
      case 'mcp-cli':
        return { label: 'Claude Code command', hint: 'Adds the Trama MCP server to Claude Code. The key decides which tools the model sees: tools it may not use are hidden.' };
      case 'mcp-json':
        return { label: 'MCP config', hint: 'For clients that take a Streamable HTTP server with headers (Cursor, Windsurf, VS Code…). Same key, same permissions.' };
      case 'mcp-docker':
        return { label: 'docker command', hint: 'Run your own MCP server next to the API. Clients then connect to http://localhost:8080/mcp with the same Authorization header.' };
      case 'cli':
        return {
          label: 'Shell',
          hint: 'The trama command works anywhere a shell does, with or without MCP. `trama login` asks for the token (so it never lands in your shell history) and saves it; `trama skill install` teaches your coding agent the commands.',
        };
      case 'env':
        return { label: 'Environment', hint: 'Read by the trama CLI and by `trama mcp`. Put these in the environment of your script, CI job or agent runtime. Never commit the token.' };
      case 'read':
        return { label: 'curl command', hint: 'Lists the workspace’s workstreams. Any GET route works with every scope.' };
      case 'write':
        return { label: 'curl command', hint: 'Files an issue. Needs a write (or admin) token; a read token gets 403.' };
      case 'context':
        return {
          label: 'curl command',
          hint: 'Returns one workstream as markdown (objective, acceptance criteria, linked work) so an agent can pick up the context.',
        };
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
      case 'mcp-docker':
        return [`docker run --rm -p 8080:8080 \\`, `  -e TRAMA_API_URL=${url} \\`, `  ghcr.io/alessandrobrunoh/trama-mcp:latest`].join('\n');
      case 'cli':
        return [
          `# install (macOS, Linux); on Windows: irm ${INSTALL_URL.replace('install.sh', 'install.ps1')} | iex`,
          `curl -fsSL ${INSTALL_URL} | sh`,
          ``,
          `trama login --api-url ${url}   # paste the token when asked`,
          `trama whoami`,
          `trama issue list --open --limit 5`,
          `trama skill install            # teach Claude Code / agents the commands`,
        ].join('\n');
      case 'env':
        return [`TRAMA_API_URL=${url}`, `TRAMA_WORKSPACE=${slug}`, `TRAMA_API_KEY=${this.secret()}`].join('\n');
      case 'read':
        return `curl -H "Authorization: Bearer ${this.secret()}" \\\n  "${url}/w/${slug}/workstreams"`;
      case 'write':
        return [
          `curl -X POST "${url}/w/${slug}/issues" \\`,
          `  -H "Authorization: Bearer ${this.secret()}" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -d '{"kind":"bug","title":"Created from the API"}'`,
        ].join('\n');
      case 'context':
        return `curl -H "Authorization: Bearer ${this.secret()}" \\\n  "${url}/w/${slug}/workstreams/${this.exampleKey()}/context"`;
    }
  });
}
