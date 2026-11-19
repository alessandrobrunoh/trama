// The "Time" tab of the task inspector: dates, the time tracked with the timer (start / stop right here), the
// estimate and — when the task has one — the tracked time against the median of finished tasks with the same
// estimate.
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { LucideDynamicIcon, LucidePlay, LucideSquare } from '@lucide/angular';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import {
  TimeEntriesStore,
  TramaStore,
  formatEstimate,
  fullDateTime,
  formatSpan,
  relativeTime,
  type Issue,
} from '../../core';
import { ApiClient } from '../../core/api/api-client';
import { ApiError } from '../../core/api/api-error';
import { REF_MIN, trackedByIssue } from '../stats/flow-stats';
import { issueCost, type CostVerdict } from './issue-cost';

const VERDICT: Record<CostVerdict, { tone: string; label: (running: boolean, ratio: number) => string }> = {
  faster: { tone: 'bg-status-ready-to-land/10 text-status-ready-to-land', label: () => 'Faster than typical' },
  on_track: { tone: 'bg-status-shipped/10 text-status-shipped', label: () => 'On track' },
  longer: { tone: 'bg-status-blocked/10 text-status-blocked', label: (open, ratio) => `${open ? 'Already' : 'Took'} ${ratio.toFixed(1)}× the typical time` },
};
const BAR: Record<CostVerdict, string> = {
  faster: 'bg-status-ready-to-land',
  on_track: 'bg-status-shipped',
  longer: 'bg-status-blocked',
};

/** `01:02:03` for a running timer. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

@Component({
  selector: 'app-issue-time-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmButtonImports, HlmTooltip, LucideDynamicIcon],
  host: { class: 'block' },
  template: `
    @let i = issue();
    @let c = cost();
    <div class="flex items-center gap-3 px-1 py-1.5">
      <div class="min-w-0 flex-1">
        <p class="text-muted-foreground text-xs">
          {{ runningHere() ? 'Timer running' : 'Timer' }}
        </p>
        <p class="text-lg tabular-nums" [class.text-muted-foreground]="!runningHere()">
          {{ runningHere() ? elapsed() : '00:00:00' }}
        </p>
      </div>
      @if (canTrack()) {
        @if (runningHere()) {
          <button hlmBtn type="button" size="sm" variant="outline" [disabled]="busy()" (click)="stop()">
            <svg [lucideIcon]="stopIcon" [size]="13" aria-hidden="true"></svg> Stop
          </button>
        } @else {
          <button hlmBtn type="button" size="sm" [disabled]="busy()" (click)="start()">
            <svg [lucideIcon]="playIcon" [size]="13" aria-hidden="true"></svg> Start
          </button>
        }
      }
    </div>
    @if (runningElsewhere()) {
      <p class="text-muted-foreground px-1 pb-1.5 text-xs">
        Your timer is running on another task. Starting here stops it.
      </p>
    }
    @if (error(); as e) {
      <p class="text-destructive px-1 pb-1.5 text-xs" role="alert">{{ e }}</p>
    }

    <dl class="flex flex-col gap-0.5 px-1 py-1 text-xs">
      <div class="flex min-h-6 items-baseline justify-between gap-3">
        <dt class="text-muted-foreground">Tracked</dt>
        @if (c.trackedMs !== undefined) {
          <dd class="font-medium tabular-nums" hlmTooltip="Total of the finished timer entries on this task">
            {{ span(c.trackedMs) }}@if (c.open) {<span class="text-muted-foreground font-normal"> so far</span>}
          </dd>
        } @else {
          <dd class="text-muted-foreground">None yet</dd>
        }
      </div>
      <div class="flex min-h-6 items-baseline justify-between gap-3">
        <dt class="text-muted-foreground">Estimate</dt>
        @if (i.estimate !== undefined && i.estimate !== null) {
          <dd class="tabular-nums">{{ points(i.estimate) }}</dd>
        } @else {
          <dd class="text-muted-foreground">{{ store.estimateScale() === 'none' ? 'Off in this workspace' : 'Not estimated' }}</dd>
        }
      </div>
      <div class="flex min-h-6 items-baseline justify-between gap-3">
        <dt class="text-muted-foreground">Created</dt>
        <dd [hlmTooltip]="exact(i.createdAt)">{{ ago(i.createdAt) }}</dd>
      </div>
      <div class="flex min-h-6 items-baseline justify-between gap-3">
        <dt class="text-muted-foreground">Started</dt>
        @if (i.startedAt) {
          <dd [hlmTooltip]="exact(i.startedAt)">{{ ago(i.startedAt) }}</dd>
        } @else {
          <dd class="text-muted-foreground">Not started</dd>
        }
      </div>
      @if (i.completedAt) {
        <div class="flex min-h-6 items-baseline justify-between gap-3">
          <dt class="text-muted-foreground">{{ i.status === 'canceled' ? 'Canceled' : 'Completed' }}</dt>
          <dd [hlmTooltip]="exact(i.completedAt)">{{ ago(i.completedAt) }}</dd>
        </div>
      }
    </dl>

    @if (c.compare; as cmp) {
      <div class="flex flex-col gap-1.5 px-1 pt-1.5 pb-1">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="text-muted-foreground">Typical for <span class="text-foreground">{{ points(cmp.estimate) }}</span></span>
          @if (cmp.typicalMs) {
            <span class="font-medium tabular-nums">{{ span(cmp.typicalMs) }}</span>
          }
        </div>
        @if (cmp.typicalMs; as typical) {
          <p class="text-muted-foreground text-[11px]">Median of {{ cmp.n }} finished {{ cmp.n === 1 ? 'task' : 'tasks' }}</p>
          <div class="flex flex-col gap-1" aria-hidden="true">
            <span class="flex items-center gap-2">
              <span class="text-muted-foreground w-10 shrink-0 text-[11px]">Typical</span>
              <span class="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"><span class="bg-muted-foreground/40 block h-full rounded-full" [style.width.%]="bars().typical"></span></span>
            </span>
            @if (c.trackedMs !== undefined && c.state !== 'canceled') {
              <span class="flex items-center gap-2">
                <span class="text-muted-foreground w-10 shrink-0 text-[11px]">This</span>
                <span class="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"><span class="block h-full rounded-full" [class]="barTone()" [style.width.%]="bars().own"></span></span>
              </span>
            }
          </div>
          @if (cmp.verdict; as v) {
            <span class="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium" [class]="verdict(v).tone" [hlmTooltip]="span(c.trackedMs ?? 0) + ' vs ' + span(typical) + ' typical'">
              {{ verdict(v).label(c.open, cmp.ratio ?? 1) }}
            </span>
          } @else if (c.trackedMs === undefined && c.state !== 'canceled') {
            <p class="text-muted-foreground text-[11px]">Track time with the timer to compare.</p>
          } @else if (c.state === 'canceled') {
            <p class="text-muted-foreground text-[11px]">Canceled work is not compared.</p>
          }
        } @else {
          <p class="text-muted-foreground text-[11px]">Not enough history yet: needs {{ min }} finished tasks at this estimate with tracked time ({{ cmp.n }} so far).</p>
        }
      </div>
    } @else if (showNudge()) {
      <p class="text-muted-foreground px-1 pt-1 pb-1 text-[11px]">Add an estimate to compare against similar tasks.</p>
    }
  `,
})
export class IssueTimeCard {
  protected readonly store = inject(TramaStore);
  private readonly api = inject(ApiClient);
  private readonly time = inject(TimeEntriesStore);
  readonly issue = input.required<Issue>();

  protected readonly min = REF_MIN;
  protected readonly playIcon = LucidePlay;
  protected readonly stopIcon = LucideSquare;
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  private readonly now = signal(Date.now());

  constructor() {
    void this.time.load();
    // Tick once a second, but only while the timer runs on this task.
    effect((onCleanup) => {
      if (!this.runningHere()) return;
      this.now.set(Date.now());
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected readonly cost = computed(() =>
    issueCost(this.issue(), this.store.issues(), trackedByIssue(this.time.entries())),
  );
  protected readonly canTrack = computed(() => this.store.can('member'));
  private readonly running = computed(() => this.time.entries().find((e) => !e.endedAt) ?? null);
  protected readonly runningHere = computed(() => this.running()?.issueId === this.issue().id);
  protected readonly runningElsewhere = computed(() => !!this.running() && !this.runningHere());
  protected readonly elapsed = computed(() => {
    const entry = this.running();
    return entry ? clock(this.now() - new Date(entry.startedAt).getTime()) : '';
  });
  protected readonly showNudge = computed(() => this.store.estimateScale() !== 'none');
  /** Bar widths in %, both on one scale so they compare. */
  protected readonly bars = computed(() => {
    const c = this.cost();
    const typical = c.compare?.typicalMs ?? 0;
    const own = c.trackedMs ?? 0;
    const max = Math.max(typical * 1.6, own, 1);
    return { typical: Math.min(100, (typical / max) * 100), own: Math.min(100, (own / max) * 100) };
  });
  protected readonly barTone = computed(() => BAR[this.cost().compare?.verdict ?? 'on_track']);

  protected async start(): Promise<void> {
    await this.run(() => {
      const issue = this.issue();
      return this.api.timeEntries.start(
        this.store.slug() ?? '',
        { issueId: issue.id, projectId: issue.projectId ?? null },
        { quiet: true },
      );
    });
  }

  protected async stop(): Promise<void> {
    await this.run(() => this.api.timeEntries.stop(this.store.slug() ?? '', { quiet: true }));
  }

  private async run(call: () => Promise<unknown>): Promise<void> {
    if (this.busy() || !this.store.slug()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await call();
      await this.time.load({ force: true });
    } catch (e) {
      this.error.set(ApiError.from(e).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected verdict(v: CostVerdict) {
    return VERDICT[v];
  }
  /** "3 pts" or "M" (t-shirt). */
  protected points(n: number): string {
    const label = formatEstimate(n, this.store.estimateScale());
    return /^[\d.]+$/.test(label) ? `${label} pts` : label;
  }
  protected span(ms: number): string {
    return formatSpan(ms);
  }
  protected ago(iso: string): string {
    return relativeTime(iso);
  }
  protected exact(iso: string): string {
    return fullDateTime(iso);
  }
}
