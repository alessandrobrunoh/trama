// Right-hand sidebar pieces of the issue page, including the "Time & estimate" card that answers
// "how much does this issue really cost?".
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { LucideDynamicIcon, LucideTimer } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { TramaStore, formatEstimate, fullDateTime, formatSpan, relativeTime, type Issue } from '../../core';
import { REF_MIN } from '../stats/perf';
import { issueCost, type CostVerdict } from './issue-cost';

// ───────────────────────── time & estimate ─────────────────────────

const VERDICT: Record<CostVerdict, { tone: string; label: (running: boolean, ratio: number) => string }> = {
  faster: { tone: 'bg-status-ready-to-land/10 text-status-ready-to-land', label: () => 'Faster than typical' },
  on_track: { tone: 'bg-status-shipped/10 text-status-shipped', label: () => 'On track' },
  longer: { tone: 'bg-status-blocked/10 text-status-blocked', label: (running, ratio) => `${running ? 'Taking' : 'Took'} longer (${ratio.toFixed(1)}× typical)` },
};
const BAR: Record<CostVerdict, string> = {
  faster: 'bg-status-ready-to-land',
  on_track: 'bg-status-shipped',
  longer: 'bg-status-blocked',
};

/**
 * Created / Started / Completed (relative, exact on hover), cycle time, and — when the issue has an
 * estimate — its cycle time against the median of finished issues with the same estimate, personalized
 * to the assignee when enough of their history is available.
 */
@Component({
  selector: 'app-issue-time-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmTooltip, LucideDynamicIcon],
  host: { class: 'bg-card border-border block rounded-lg border' },
  template: `
    @let i = issue();
    @let c = cost();
    <div class="flex items-center gap-1.5 px-3 pt-2.5 pb-1">
      <svg [lucideIcon]="timer" [size]="13" [strokeWidth]="1.75" class="text-muted-foreground"></svg>
      <h3 class="text-muted-foreground text-xs font-medium">Time &amp; estimate</h3>
    </div>

    <dl class="flex flex-col gap-1 px-3 py-1.5 text-xs">
      <div class="flex items-baseline justify-between gap-3">
        <dt class="text-muted-foreground">Created</dt>
        <dd class="text-[13px]" [hlmTooltip]="exact(i.createdAt)">{{ ago(i.createdAt) }}</dd>
      </div>
      <div class="flex items-baseline justify-between gap-3">
        <dt class="text-muted-foreground">Started</dt>
        @if (i.startedAt) {
          <dd class="text-[13px]" [hlmTooltip]="exact(i.startedAt)">{{ ago(i.startedAt) }}</dd>
        } @else {
          <dd class="text-muted-foreground text-[13px]">Not started</dd>
        }
      </div>
      @if (i.completedAt) {
        <div class="flex items-baseline justify-between gap-3">
          <dt class="text-muted-foreground">{{ i.status === 'canceled' ? 'Canceled' : 'Completed' }}</dt>
          <dd class="text-[13px]" [hlmTooltip]="exact(i.completedAt)">{{ ago(i.completedAt) }}</dd>
        </div>
      }
      <div class="flex items-baseline justify-between gap-3">
        <dt class="text-muted-foreground">Cycle time</dt>
        @if (c.cycleMs !== undefined) {
          <dd class="text-[13px] font-medium tabular-nums" [hlmTooltip]="c.running ? 'Running since it started' : 'Started to completed'">
            {{ span(c.cycleMs) }}@if (c.running) {<span class="text-muted-foreground font-normal"> so far</span>}
          </dd>
        } @else {
          <dd class="text-muted-foreground text-[13px]">—</dd>
        }
      </div>
    </dl>

    @if (c.compare; as cmp) {
      <div class="border-border flex flex-col gap-2 border-t px-3 py-2.5">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span class="text-muted-foreground">Typical for <span class="text-foreground">{{ points(cmp.estimate) }}</span>@if (cmp.personalized) { <span class="text-foreground"> · {{ assigneeName() }}</span>}</span>
          @if (cmp.typicalMs) {
            <span class="text-[13px] font-medium tabular-nums">{{ span(cmp.typicalMs) }}</span>
          }
        </div>
        @if (cmp.typicalMs; as typical) {
          <p class="text-muted-foreground -mt-1.5 text-[11px]">{{ cmp.personalized ? 'Personal median' : 'Workspace median' }} · {{ cmp.n }} finished {{ cmp.n === 1 ? 'issue' : 'issues' }}</p>
          <div class="flex flex-col gap-1.5" aria-hidden="true">
            <span class="flex items-center gap-2">
              <span class="text-muted-foreground w-12 shrink-0 text-[11px]">Typical</span>
              <span class="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"><span class="bg-muted-foreground/40 block h-full rounded-full" [style.width.%]="bars().typical"></span></span>
            </span>
            @if (c.cycleMs !== undefined && c.state !== 'canceled') {
              <span class="flex items-center gap-2">
                <span class="text-muted-foreground w-12 shrink-0 text-[11px]">This</span>
                <span class="bg-muted h-1.5 flex-1 overflow-hidden rounded-full"><span class="block h-full rounded-full" [class]="barTone()" [style.width.%]="bars().own"></span></span>
              </span>
            }
          </div>
          @if (cmp.verdict; as v) {
            <span class="inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium" [class]="verdict(v).tone" [hlmTooltip]="span(c.cycleMs ?? 0) + ' vs ' + span(typical) + ' typical'">
              {{ verdict(v).label(c.running, cmp.ratio ?? 1) }}
            </span>
          } @else if (c.state === 'not_started') {
            <p class="text-muted-foreground text-[11px]">Starts the clock when work begins.</p>
          } @else if (c.state === 'canceled') {
            <p class="text-muted-foreground text-[11px]">Canceled work is not compared.</p>
          }
        } @else {
          <p class="text-muted-foreground text-xs">Not enough history yet</p>
          <p class="text-muted-foreground -mt-1.5 text-[11px]">Needs {{ min }} finished issues at this estimate · {{ cmp.n }} so far</p>
        }
      </div>
    } @else if (showNudge()) {
      <div class="border-border text-muted-foreground border-t px-3 py-2.5 text-xs">Add an estimate to compare against similar issues</div>
    }
  `,
})
export class IssueTimeCard {
  private readonly store = inject(TramaStore);
  readonly issue = input.required<Issue>();

  protected readonly timer = LucideTimer;
  protected readonly min = REF_MIN;
  /** Re-render the running cycle time once a minute. */
  private readonly now = signal(Date.now());

  constructor() {
    const t = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(t));
  }

  protected readonly cost = computed(() => issueCost(this.issue(), this.store.issues(), this.now()));
  protected readonly showNudge = computed(() => this.store.estimateScale() !== 'none');
  protected readonly assigneeName = computed(() => {
    const assigneeId = this.issue().assigneeId;
    return assigneeId ? this.store.getUser(assigneeId)?.name ?? 'assignee' : 'assignee';
  });
  /** Bar widths in %, both on one scale so they compare. */
  protected readonly bars = computed(() => {
    const c = this.cost();
    const typical = c.compare?.typicalMs ?? 0;
    const own = c.cycleMs ?? 0;
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
