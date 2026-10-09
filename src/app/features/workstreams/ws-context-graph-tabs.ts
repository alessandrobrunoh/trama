// Graph tab (one workstream, its artifacts and dependency neighbours) and Agent-context tab.
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { LucideBot, LucideCheck, LucideCopy, LucideDynamicIcon, LucideTerminal } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { ApiClient, ApiError, TramaStore, Notifier, type Workstream } from '../../core';
import { Markdown } from '../../shared/markdown';
import { buildExecutionGraph } from '../graph/graph-model';
import { ExecutionGraph } from '../graph/execution-graph';

@Component({
  selector: 'app-ws-graph-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ExecutionGraph],
  host: { class: 'block' },
  template: `
    <div class="h-[min(42rem,calc(100svh-15rem))] min-h-[22rem]">
      <app-execution-graph [graph]="graph()" />
    </div>
  `,
})
export class WsGraphTab {
  private readonly store = inject(TramaStore);
  readonly ws = input.required<Workstream>();
  protected readonly graph = computed(() =>
    buildExecutionGraph(
      {
        workstreams: this.store.workstreams(),
        artifacts: this.store.artifacts(),
        dependencies: this.store.dependencies(),
      },
      { workstreamId: this.ws().id, includeArtifacts: true, hideCanceled: false },
    ),
  );
}

@Component({
  selector: 'app-ws-context-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmToggleGroupImports, LucideDynamicIcon, Markdown],
  host: { class: 'block' },
  template: `
    <div class="mx-auto grid max-w-4xl gap-4 px-4 py-5 sm:px-6">
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex min-w-0 flex-1 items-center gap-2">
          <svg [lucideIcon]="bot" [size]="16" class="text-muted-foreground shrink-0"></svg>
          <p class="text-muted-foreground text-sm">What an agent receives for {{ ws().key }} from <span class="text-foreground font-mono text-xs">GET …/context</span>: objective, criteria, decisions, issues, artifacts, open questions.</p>
        </div>
        <hlm-toggle-group type="single" variant="outline" size="sm" [value]="mode()" (valueChange)="setMode($event)">
          <button hlmToggleGroupItem value="rendered" class="px-2.5 text-xs">Rendered</button>
          <button hlmToggleGroupItem value="raw" class="px-2.5 text-xs">Markdown</button>
        </hlm-toggle-group>
        <button hlmBtn size="sm" [disabled]="!text()" (click)="copy()">
          <svg [lucideIcon]="copied() ? checkIcon : copyIcon" [size]="14"></svg>{{ copied() ? 'Copied' : 'Copy for agent' }}
        </button>
      </div>

      <div class="bg-muted/40 flex items-start gap-2 rounded-lg border px-3 py-2">
        <svg [lucideIcon]="term" [size]="14" class="text-muted-foreground mt-1 shrink-0"></svg>
        <code class="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all">{{ curl() }}</code>
      </div>

      @if (loading() && !text()) {
        <p class="text-muted-foreground text-sm">Loading context…</p>
      } @else if (error()) {
        <div class="rounded-lg border border-dashed p-6 text-center text-sm">
          <p class="font-medium">Could not load the agent context</p>
          <p class="text-muted-foreground mt-1">{{ error() }}</p>
          <button hlmBtn size="sm" variant="outline" class="mt-3" (click)="load()">Try again</button>
        </div>
      } @else if (mode() === 'raw') {
        <pre class="bg-muted/40 overflow-x-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">{{ text() }}</pre>
      } @else {
        <div class="rounded-lg border p-4"><app-markdown [source]="text()" /></div>
      }
    </div>
  `,
})
export class WsContextTab {
  private readonly api = inject(ApiClient);
  private readonly store = inject(TramaStore);
  private readonly notify = inject(Notifier);
  readonly ws = input.required<Workstream>();

  protected readonly text = signal('');
  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly copied = signal(false);
  protected readonly mode = signal<'rendered' | 'raw'>('rendered');
  protected readonly bot = LucideBot;
  protected readonly copyIcon = LucideCopy;
  protected readonly checkIcon = LucideCheck;
  protected readonly term = LucideTerminal;
  protected readonly curl = computed(
    () =>
      `curl -H "Authorization: Bearer $NABLA_TOKEN" -H "Accept: text/markdown" ${globalThis.location?.origin ?? ''}/api/w/${this.store.slug()}/workstreams/${this.ws().key}/context`,
  );

  constructor() {
    effect(() => {
      this.ws().updatedAt;
      this.ws().id;
      untracked(() => void this.load());
    });
  }

  protected setMode(v: unknown): void {
    const m = Array.isArray(v) ? v[0] : v;
    if (m === 'rendered' || m === 'raw') this.mode.set(m);
  }

  protected async load(): Promise<void> {
    const slug = this.store.slug();
    if (!slug) return;
    this.loading.set(true);
    try {
      this.text.set(await this.api.workstreams.contextMarkdown(slug, this.ws().key));
      this.error.set('');
    } catch (e) {
      const err = ApiError.from(e);
      this.error.set(err.status === 404 ? `${this.ws().key} was not found on the server.` : err.message || 'The server did not answer.');
    } finally {
      this.loading.set(false);
    }
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.text());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1800);
      this.notify.success('Context copied', { description: 'Paste it into your agent’s prompt.' });
    } catch {
      this.notify.error('Could not copy', { description: 'Select the markdown view and copy manually.' });
    }
  }
}
