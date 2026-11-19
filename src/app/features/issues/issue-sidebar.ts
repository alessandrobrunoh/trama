// Right-hand sidebar pieces of the issue page: the collapsed "Time & estimate" group that answers
// "how much does this issue really cost?".
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
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
import { REF_MIN, trackedByIssue } from '../stats/flow-stats';
import { issueCost, type CostVerdict } from './issue-cost';
import { IssueSection } from './issue-section';

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

/**
 * Created / Started / Completed (relative, exact on hover), the time tracked with the timer, and — when the
 * task has an estimate — that tracked time against the median of finished tasks with the same estimate.
 * Collapsed by default; the header shows the tracked time.
 */
@Component({
  selector: 'app-issue-time-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip, IssueSection],
  host: { class: 'block' },
  template: `
    @let i = issue();
    @let c = cost();
    <app-issue-section label="Time & estimate" [summary]="summary()">
      <dl class="flex flex-col gap-0.5 px-1 py-1 text-xs">
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
        <div class="flex min-h-6 items-baseline justify-between gap-3">
          <dt class="text-muted-foreground">Tracked</dt>
          @if (c.trackedMs !== undefined) {
            <dd class="font-medium tabular-nums" hlmTooltip="Total of the finished timer entries on this task">
              {{ span(c.trackedMs) }}@if (c.open) {<span class="text-muted-foreground font-normal"> so far</span>}
            </dd>
          } @else {
            <dd class="text-muted-foreground" hlmTooltip="Start the timer on this task to track time">None yet</dd>
          }
        </div>
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
    </app-issue-section>
  `,
})
export class IssueTimeCard {
  private readonly store = inject(TramaStore);
  readonly issue = input.required<Issue>();

  protected readonly min = REF_MIN;
  private readonly time = inject(TimeEntriesStore);

  constructor() {
    void this.time.load();
  }

  protected readonly cost = computed(() =>
    issueCost(this.issue(), this.store.issues(), trackedByIssue(this.time.entries())),
  );
  /** Header text while collapsed: the time tracked so far, if any. */
  protected readonly summary = computed(() => {
    const ms = this.cost().trackedMs;
    return ms === undefined ? '' : formatSpan(ms);
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
