import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TimeEntriesStore } from '../core/stores/time-entries.store';
import { TramaStore } from '../core/stores/trama.store';
import { UiStore } from '../core/stores/ui.store';
import { SyncStatus } from '../core/sync/sync-status';
import { ago } from '../shared/ago';
import { PageChrome } from './page-chrome';

const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  delta: 'Delta',
};

/**
 * The v3 status bar under the main pane (28px, mono 10.5px, faint):
 *   [live dot · sync] [connected trackers · last sync] [page's own status content] … [? shortcuts · ⌘K command] [timer pill]
 * Pages still add their own context with `<app-status-bar>`; it renders in the middle slot.
 */
@Component({
  selector: 'app-shell-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, HlmTooltip],
  host: {
    role: 'status',
    class:
      'text-faint border-border bg-background flex h-7 min-w-0 shrink-0 items-center gap-4 border-t px-4 font-mono text-[10.5px] max-md:hidden',
  },
  template: `
    <span class="flex shrink-0 items-center gap-1.5" [attr.aria-label]="syncLabel()">
      <span class="size-1.5 shrink-0" [class]="syncDot()" aria-hidden="true"></span>
      {{ syncLabel() }}
    </span>
    @if (trackers(); as t) {
      <span class="min-w-0 shrink truncate max-lg:hidden">{{ t }}</span>
    }
    @if (chrome.statusBar(); as bar) {
      <div class="text-muted-foreground flex min-w-0 flex-1 items-center gap-3 truncate font-sans text-xs">
        <ng-container *ngTemplateOutlet="bar" />
      </div>
    } @else {
      <span class="flex-1"></span>
    }
    <button
      type="button"
      class="hover:text-muted-foreground shrink-0 max-lg:hidden"
      (click)="ui.openModal('shortcuts')"
    >
      ? shortcuts
    </button>
    <button
      type="button"
      class="hover:text-muted-foreground shrink-0 max-lg:hidden"
      (click)="ui.openCommandPalette()"
    >
      ⌘K command
    </button>
    @if (timers.running(); as run) {
      <span class="border-primary/40 bg-primary/12 flex h-[22px] shrink-0 items-center gap-2 border ps-2 pe-0.5">
        <span class="bg-primary size-1.5" aria-hidden="true"></span>
        @if (runningKey(); as key) {
          <a [routerLink]="['/', slug(), 'tasks', key]" class="text-muted-foreground hover:text-foreground">{{ key }}</a>
        } @else {
          <a [routerLink]="['/', slug(), 'timer']" class="text-muted-foreground hover:text-foreground">Timer</a>
        }
        <span class="text-foreground text-[11px] tabular-nums">{{ elapsed() }}</span>
        <button
          type="button"
          class="bg-primary/20 hover:bg-primary/35 flex size-[18px] items-center justify-center"
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
  protected readonly chrome = inject(PageChrome);
  protected readonly ui = inject(UiStore);
  protected readonly timers = inject(TimeEntriesStore);
  private readonly sync = inject(SyncStatus);
  private readonly store = inject(TramaStore);

  /** One tick per second while a timer runs (drives the elapsed clock and the "ago" labels). */
  private readonly now = signal(Date.now());

  constructor() {
    void this.timers.load();
    const id = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  protected readonly slug = computed(() => this.store.slug() ?? '');

  protected readonly syncDot = computed(() => {
    if (this.sync.live() === 'reconnecting' || this.sync.lastError()) return 'bg-status-in-progress';
    return this.sync.live() === 'open' ? 'bg-status-done' : 'bg-faint';
  });

  protected readonly syncLabel = computed(() => {
    const last = this.sync.lastSyncedAt();
    const label = this.sync.label();
    if (label === 'Live' || label === 'Synced') {
      return last ? `${label} · synced ${ago(last, this.now())}` : label;
    }
    return label;
  });

  /** "GitHub · GitLab synced 1m ago" from the connected integrations. */
  protected readonly trackers = computed(() => {
    const list = this.store.integrations().filter((i) => i.status === 'connected');
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
