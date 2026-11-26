import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideSparkles } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TimeEntriesStore } from '../core/stores/time-entries.store';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { SyncStatus } from '../core/sync/sync-status';
import { ago } from '../shared/ago';

const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  delta: 'Delta',
};

/**
 * The v3 status bar under the main pane ("v3 · 01 UI Kit" → App shell → Status bar):
 *   [● Agent sync 4m ago] [GitHub · GitLab · Jira synced 1m ago] … [✦ Ask Trama ⌘J] [? shortcuts   ⌘K command] [timer pill]
 * 28px, IBM Plex Mono 10.5px, faint. Page-level `<app-status-bar>` content is not shown here (the v3
 * shell has no per-page status line).
 */
@Component({
  selector: 'app-shell-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmTooltip, LucideDynamicIcon],
  host: {
    role: 'status',
    class:
      'text-faint border-border bg-background flex h-7 min-w-0 shrink-0 items-center gap-4 border-t px-4 font-mono text-[10.5px] whitespace-nowrap max-md:hidden',
  },
  template: `
    <a [routerLink]="['/', slug(), 'connect']" class="hover:text-muted-foreground flex shrink-0 items-center gap-1.5">
      <span class="size-1.5 shrink-0" [class]="agentDot()" aria-hidden="true"></span>
      {{ agentLabel() }}
    </a>
    @if (trackers(); as t) {
      <span class="min-w-0 shrink truncate">{{ t }}</span>
    }
    <span class="flex-1"></span>
    @if (!store.isGuest()) {
      <button
        type="button"
        id="ask-trama-chip"
        class="bg-primary/10 border-primary/40 hover:bg-primary/20 flex shrink-0 items-center gap-1.5 border py-0.5 ps-2 pe-1.5 outline-none focus-visible:border-primary"
        aria-controls="trama-assistant"
        [attr.aria-expanded]="ui.askOpen()"
        (click)="ui.toggleAsk()"
      >
        <svg [lucideIcon]="sparklesIcon" [size]="11" class="text-primary shrink-0" aria-hidden="true"></svg>
        <span class="text-foreground">Ask Trama</span>
        <kbd class="bg-secondary text-muted-foreground px-1 font-mono text-[10px]">{{ askKeys }}</kbd>
      </button>
    }
    <button type="button" class="hover:text-muted-foreground shrink-0 whitespace-pre max-lg:hidden" (click)="ui.openModal('shortcuts')">? shortcuts</button>
    <button type="button" class="hover:text-muted-foreground -ms-1 shrink-0 max-lg:hidden" (click)="ui.openCommandPalette()">⌘K command</button>
    @if (timers.running(); as run) {
      <span class="border-red/40 bg-red/12 flex shrink-0 items-center gap-2 border py-0.5 ps-2 pe-1">
        <span class="bg-red size-1.5" aria-hidden="true"></span>
        @if (runningKey(); as key) {
          <a [routerLink]="['/', slug(), 'tasks', key]" class="text-muted-foreground hover:text-foreground">{{ key }}</a>
        } @else {
          <a [routerLink]="['/', slug(), 'timer']" class="text-muted-foreground hover:text-foreground">Timer</a>
        }
        <span class="text-foreground text-[11px] tabular-nums">{{ elapsed() }}</span>
        <button
          type="button"
          class="bg-red/20 hover:bg-red/35 flex size-[18px] items-center justify-center"
          hlmTooltip="Stop timer"
          aria-label="Stop timer"
          [disabled]="timers.busy()"
          (click)="timers.stop()"
        >
          <span class="bg-foreground size-[7px]" aria-hidden="true"></span>
        </button>
      </span>
    }
  `,
})
export class ShellStatusBar {
  protected readonly ui = inject(UiStore);
  protected readonly sparklesIcon = LucideSparkles;
  protected readonly askKeys =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
      ? '⌘J'
      : 'Ctrl J';
  protected readonly timers = inject(TimeEntriesStore);
  private readonly sync = inject(SyncStatus);
  protected readonly store = inject(TramaStore);

  /** One tick per second (drives the elapsed clock and the "ago" labels). */
  private readonly now = signal(Date.now());

  constructor() {
    void this.timers.load();
    // Token "last used" is the closest honest signal of the agent syncing through the CLI / MCP.
    effect(() => {
      if (this.store.slug()) void this.store.loadTokens();
    });
    const id = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  protected readonly slug = computed(() => this.store.slug() ?? '');

  private readonly lastAgentUse = computed(() => {
    let last: string | undefined;
    for (const t of this.store.tokens()) {
      if (t.lastUsedAt && (!last || t.lastUsedAt > last)) last = t.lastUsedAt;
    }
    return last;
  });

  protected readonly agentDot = computed(() => {
    if (this.sync.live() === 'reconnecting' || this.sync.lastError()) return 'bg-status-in-progress';
    return this.lastAgentUse() ? 'bg-status-done' : 'bg-faint';
  });

  protected readonly agentLabel = computed(() => {
    if (this.sync.live() === 'reconnecting') return 'Reconnecting…';
    if (this.sync.lastError()) return 'Sync error';
    const last = this.lastAgentUse();
    return last ? `Agent sync ${ago(last, this.now())}` : 'Agent not connected';
  });

  /** "GitHub · GitLab synced 1m ago" from the connected integrations. */
  protected readonly trackers = computed(() => {
    const list = this.store.integrations().filter((i) => i.status === 'connected' && i.provider !== 'delta');
    if (!list.length) return '';
    const names = [...new Set(list.map((i) => PROVIDER_LABEL[i.provider] ?? i.provider))].join(' · ');
    const last = list
      .map((i) => i.lastSyncAt)
      .filter((d): d is string => !!d)
      .sort()
      .pop();
    return last ? `${names} synced ${ago(last, this.now())}` : names;
  });

  protected readonly runningKey = computed(() => {
    const id = this.timers.running()?.issueId;
    return id ? (this.store.getIssue(id)?.key ?? null) : null;
  });

  protected readonly elapsed = computed(() => {
    const run = this.timers.running();
    if (!run) return '';
    const s = Math.max(0, Math.floor((this.now() - Date.parse(run.startedAt)) / 1000));
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  });
}
