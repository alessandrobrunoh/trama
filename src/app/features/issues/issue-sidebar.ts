// Right-hand sidebar pieces of the issue page: linked workstreams as mini cards, and the
// "Time & estimate" card that answers "how much does this issue really cost?".
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideDynamicIcon, LucideHexagon, LucidePlus, LucideTimer } from '@lucide/angular';
import { HlmTooltip } from '@spartan-ng/helm/tooltip';
import { NablaStore, formatEstimate, fullDateTime, formatSpan, relativeTime, type Issue } from '../../core';
import { ActorAvatar } from '../../shared/actor-avatar';
import { StatusIcon } from '../../shared/status';
import { MilestoneIcon } from '../milestones/milestone-icon';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { REF_MIN } from '../stats/perf';
import { IssueActions } from './issue-actions';
import { issueCost, type CostVerdict } from './issue-cost';

// ───────────────────────── linked workstreams ─────────────────────────

/** Each linked workstream as a mini card (status hexagon, key, title, issue progress, accountable) + its milestone line. */
@Component({
  selector: 'app-issue-side-workstreams',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, HlmTooltip, LucideDynamicIcon, StatusIcon, ActorAvatar, MilestoneIcon],
  host: { class: 'block' },
  template: `
    <div class="mb-2 flex items-center gap-1.5 px-0.5">
      <svg [lucideIcon]="hex" [size]="13" [strokeWidth]="1.75" class="text-entity-workstream"></svg>
      <h3 class="text-muted-foreground text-xs font-medium">Workstreams</h3>
      @if (cards().length) {
        <span class="text-muted-foreground/70 text-xs tabular-nums">{{ cards().length }}</span>
      }
    </div>
    <div class="flex flex-col gap-2">
      @for (c of cards(); track c.ws.id) {
        <a
          [routerLink]="['/', slug(), 'workstreams', c.ws.key]"
          class="bg-card border-border hover:border-border-strong hover:bg-hover focus-visible:ring-ring flex flex-col gap-1.5 rounded-lg border px-2.5 py-2 outline-none transition-colors focus-visible:ring-2"
        >
          <span class="flex items-center gap-1.5">
            <app-status-icon [status]="c.ws.status" entity="workstream" />
            <span class="text-muted-foreground font-mono text-xs">{{ c.ws.key }}</span>
            <span class="flex-1"></span>
            @if (c.ws.accountableUserId) {
              <app-actor-avatar [actor]="{ type: 'user', id: c.ws.accountableUserId }" [size]="18" />
            }
          </span>
          <span class="truncate text-[13px] leading-snug font-medium">{{ c.ws.title }}</span>
          @if (c.total) {
            <span class="flex items-center gap-2" [hlmTooltip]="c.done + ' of ' + c.total + ' issues done'">
              <span class="bg-muted h-1 flex-1 overflow-hidden rounded-full">
                <span class="bg-status-shipped block h-full rounded-full" [style.width.%]="(c.done / c.total) * 100"></span>
              </span>
              <span class="text-muted-foreground text-[11px] tabular-nums">{{ c.done }}/{{ c.total }}</span>
            </span>
          }
          @for (m of c.milestones; track m.id) {
            <span class="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              <app-milestone-icon [fraction]="m.fraction" [state]="m.state" [size]="12" />
              <span class="font-mono">{{ m.n }}</span>
              <span class="truncate">{{ m.name }}</span>
            </span>
          }
        </a>
      } @empty {
        <p class="text-muted-foreground px-0.5 text-xs">Not part of any workstream yet.</p>
      }
      @if (canAdd()) {
        <button
          type="button"
          class="border-border-strong text-muted-foreground hover:bg-accent hover:text-foreground flex h-8 items-center justify-center gap-1.5 rounded-lg border border-dashed text-xs transition-colors"
          (click)="actions.openPrompt('workstream', [issue().id])"
        >
          <svg [lucideIcon]="plus" [size]="13"></svg> Add to workstream
        </button>
      }
    </div>
  `,
})
export class IssueSideWorkstreams {
  private readonly store = inject(NablaStore);
  private readonly milestones = inject(MilestoneInfo);
  protected readonly actions = inject(IssueActions);
  readonly issue = input.required<Issue>();
  protected readonly hex = LucideHexagon;
  protected readonly plus = LucidePlus;
  protected readonly slug = computed(() => this.store.slug() ?? '');
  protected readonly canAdd = computed(() => this.store.can('member') && !this.issue().duplicateOfId);

  protected readonly cards = computed(() => {
    const issue = this.issue();
    const byWs = this.store.issuesByWorkstream();
    const stats = this.milestones.stats();
    const states = this.milestones.states();
    return issue.workstreamIds.flatMap((id) => {
      const ws = this.store.workstreamById().get(id);
      if (!ws) return [];
      const counted = (byWs.get(id) ?? []).filter((i) => i.status !== 'canceled');
      const ms = (issue.milestoneIds ?? []).flatMap((mid) => {
        const m = this.store.getMilestone(mid);
        if (!m || m.workstreamId !== id) return [];
        return [{ id: m.id, n: this.milestones.ordinal(m), name: m.name, fraction: stats.get(m.id)?.fraction ?? 0, state: states.get(m.id) ?? 'idle' }];
      });
      return [{ ws, total: counted.length, done: counted.filter((i) => i.status === 'done').length, milestones: ms }];
    });
  });
}

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
 * estimate — its cycle time against the median of finished issues with the same estimate.
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
          <span class="text-muted-foreground">Typical for <span class="text-foreground">{{ points(cmp.estimate) }}</span></span>
          @if (cmp.typicalMs) {
            <span class="text-[13px] font-medium tabular-nums">{{ span(cmp.typicalMs) }}</span>
          }
        </div>
        @if (cmp.typicalMs; as typical) {
          <p class="text-muted-foreground -mt-1.5 text-[11px]">Median of {{ cmp.n }} finished {{ cmp.n === 1 ? 'issue' : 'issues' }}</p>
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
  private readonly store = inject(NablaStore);
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
