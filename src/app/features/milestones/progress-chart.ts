// Progress (burn-up) chart for a workstream or a single milestone, like Linear's project graph:
// Scope (grey), Started (amber) and Completed (accent, filled) from the start date to today, a
// projection cone to the target date (current pace vs. required pace), a red hatched band when the
// target date has passed, milestone diamonds on the x-axis and completions per period at the bottom.
// Reusable: `<app-progress-chart [ws]="ws" />` or `<app-progress-chart [ws]="ws" [milestone]="ms" />`.
// Series are reconstructed from issue timestamps (link time, startedAt, completedAt); issues without
// an estimate count as 1 point.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { format } from 'date-fns';
import { NablaStore, type Milestone, type Project, type Workstream } from '../../core';
import { ChartTip } from '../stats/charts/chart-tip';
import { compact, niceScale, trackWidth } from '../stats/charts/chart-utils';
import { MilestoneInfo } from './milestone-stats';
import { buildBurnup, dateOfDay, dayOf, fmtNum, progressLabel, simplify, todayDay, unitLabel, usesPoints } from './milestone-model';

const SCOPE = 'var(--muted-foreground)';
const STARTED = 'var(--chart-3)';
const COMPLETED = 'var(--chart-1)';
const RED = 'var(--status-blocked)';

let seq = 0;

@Component({
  selector: 'app-progress-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartTip],
  host: { class: 'relative block min-w-0' },
  template: `
    @let m = model();
    @if (showHeader()) {
      <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        @for (s of legend(); track s.key) {
          <span class="inline-flex items-center gap-1.5">
            <span class="h-0.5 w-3 shrink-0 rounded-full" [style.background]="s.color"></span>
            <span class="text-muted-foreground">{{ s.label }}</span>
            <span class="text-foreground font-medium tabular-nums">{{ s.value }}</span>
          </span>
        }
        <span class="ml-auto inline-flex items-center gap-1.5">
          @if (eta(); as e) {
            <span class="text-muted-foreground tabular-nums">{{ e }}</span>
          }
          <span class="inline-flex h-5 items-center gap-1 rounded-full border border-border-strong px-1.5 font-medium" [style.color]="health().color">
            <span class="size-1.5 rounded-full" [style.background]="health().color"></span>{{ health().label }}
          </span>
        </span>
      </div>
    }

    @if (m.totals.scope === 0) {
      <div class="text-muted-foreground border-border-strong flex items-center justify-center rounded-md border border-dashed px-4 text-center text-xs" [style.height.px]="height()">
        {{ milestone() ? 'No issues in this milestone yet.' : 'Link issues to see progress over time.' }}
      </div>
    } @else {
      <div class="relative outline-none" tabindex="0" [attr.aria-label]="summary()" (keydown)="onKey($event)" (blur)="hover.set(null)">
        <svg [attr.viewBox]="'0 0 ' + width() + ' ' + height()" [attr.width]="width()" [attr.height]="height()" class="block max-w-full overflow-visible select-none" role="img" [attr.aria-label]="summary()">
          <defs>
            <pattern [attr.id]="hatchId" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" [style.stroke]="red" stroke-width="2" stroke-opacity="0.35" />
            </pattern>
          </defs>

          @for (t of yTicks(); track t.value) {
            <line [attr.x1]="ml()" [attr.x2]="width() - mr" [attr.y1]="t.y" [attr.y2]="t.y" [style.stroke]="t.value === 0 ? 'var(--border-strong)' : 'var(--border)'" [attr.stroke-dasharray]="t.value === 0 ? null : '3 4'" stroke-width="1" />
            <text [attr.x]="ml() - 8" [attr.y]="t.y" text-anchor="end" dominant-baseline="middle" font-size="11" class="tabular-nums" style="fill: var(--muted-foreground)">{{ t.label }}</text>
          }
          @for (t of xTicks(); track t.day) {
            <text [attr.x]="t.x" [attr.y]="height() - 6" [attr.text-anchor]="t.anchor" font-size="11" class="tabular-nums" style="fill: var(--muted-foreground)">{{ t.label }}</text>
          }

          <!-- completions per period -->
          @for (b of bars(); track b.from) {
            <rect [attr.x]="b.x" [attr.y]="b.y" [attr.width]="b.w" [attr.height]="b.h" rx="2" [style.fill]="completed" fill-opacity="0.28" />
          }

          <!-- past the target date and not done -->
          @if (overdueBand(); as o) {
            <rect [attr.x]="o.x" [attr.y]="mt" [attr.width]="o.w" [attr.height]="innerH()" [attr.fill]="'url(#' + hatchId + ')'" />
            <line [attr.x1]="o.x" [attr.x2]="o.x" [attr.y1]="mt" [attr.y2]="mt + innerH()" [style.stroke]="red" stroke-width="1.5" stroke-opacity="0.7" />
          } @else if (targetX(); as tx) {
            <line [attr.x1]="tx" [attr.x2]="tx" [attr.y1]="mt" [attr.y2]="mt + innerH()" style="stroke: var(--muted-foreground)" stroke-opacity="0.5" stroke-dasharray="2 3" stroke-width="1" />
          }

          <!-- projection cone: required pace vs. current pace -->
          @if (cone(); as c) {
            <path [attr.d]="c.area" [style.fill]="completed" fill-opacity="0.09" />
            <path [attr.d]="c.scope" fill="none" [style.stroke]="scope" stroke-width="1.5" stroke-dasharray="4 4" stroke-opacity="0.8" />
            <path [attr.d]="c.required" fill="none" [style.stroke]="completed" stroke-width="1.5" stroke-dasharray="2 4" stroke-opacity="0.55" stroke-linecap="round" />
            <path [attr.d]="c.projected" fill="none" [style.stroke]="completed" stroke-width="1.75" stroke-dasharray="5 4" />
          }
          @if (todayX() < width() - mr - 1 && todayX() > ml()) {
            <line [attr.x1]="todayX()" [attr.x2]="todayX()" [attr.y1]="mt" [attr.y2]="mt + innerH()" style="stroke: var(--muted-foreground)" stroke-opacity="0.45" stroke-width="1" />
            <text [attr.x]="todayX() + 4" [attr.y]="mt + 9" font-size="10" style="fill: var(--muted-foreground)">Today</text>
          }

          <path [attr.d]="paths().completedArea" [style.fill]="completed" fill-opacity="0.14" />
          <path [attr.d]="paths().scope" fill="none" [style.stroke]="scope" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
          <path [attr.d]="paths().started" fill="none" [style.stroke]="started" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round" />
          <path [attr.d]="paths().completed" fill="none" [style.stroke]="completed" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />

          @if (hoverX(); as hx) {
            <line [attr.x1]="hx" [attr.x2]="hx" [attr.y1]="mt" [attr.y2]="mt + innerH()" style="stroke: var(--muted-foreground)" stroke-opacity="0.55" stroke-width="1" />
          }
          @for (d of dots(); track d.key) {
            <circle [attr.cx]="d.x" [attr.cy]="d.y" r="3.5" [style.fill]="d.color" style="stroke: var(--background)" stroke-width="2" />
          }

          <rect [attr.x]="ml()" [attr.y]="mt" [attr.width]="innerW()" [attr.height]="innerH()" fill="transparent" (pointermove)="onMove($event)" (pointerleave)="hover.set(null)" />

          <!-- milestones on the axis -->
          @for (d of diamonds(); track d.id) {
            <g class="cursor-default" (pointerenter)="hoverMs.set(d.id)" (pointerleave)="hoverMs.set(null)">
              <rect [attr.x]="d.x - 9" [attr.y]="d.y - 9" width="18" height="18" fill="transparent" />
              <polygon [attr.points]="diamondPoints(d.x, d.y)" [style.fill]="d.fill" [style.stroke]="d.stroke" stroke-width="1.5" stroke-linejoin="round" />
            </g>
          }
        </svg>

        @if (tip(); as t) {
          <app-chart-tip [x]="t.x" [y]="mt" [bounds]="width()">
            <div class="text-muted-foreground mb-1 text-[11px] tabular-nums">{{ t.title }}</div>
            <ul class="flex flex-col gap-1">
              @for (r of t.rows; track r.key) {
                <li class="flex items-center gap-2">
                  <span class="h-0.5 w-2.5 shrink-0 rounded-full" [style.background]="r.color"></span>
                  <span class="text-muted-foreground min-w-0 flex-1 truncate">{{ r.label }}</span>
                  <span class="text-foreground font-medium tabular-nums">{{ r.value }}</span>
                </li>
              }
            </ul>
          </app-chart-tip>
        }
        @if (msTip(); as t) {
          <app-chart-tip [x]="t.x" [y]="t.y" [bounds]="width()" [above]="true">
            <div class="text-foreground font-medium">{{ t.name }}</div>
            <div class="text-muted-foreground tabular-nums">{{ t.date }} · {{ t.progress }}</div>
          </app-chart-tip>
        }
      </div>
      @if (!compactMode() && m.totals.defaulted > 0) {
        <p class="text-muted-foreground mt-1.5 text-[11px]">{{ m.totals.defaulted }} {{ m.totals.defaulted === 1 ? 'issue has' : 'issues have' }} no estimate and {{ m.totals.defaulted === 1 ? 'counts' : 'count' }} as 1 point.</p>
      }
    }
  `,
})
export class ProgressChart {
  private readonly store = inject(NablaStore);
  private readonly info = inject(MilestoneInfo);

  /** The workstream to chart (give this or `project`). */
  readonly ws = input<Workstream | null>(null);
  /** The project to chart: all issues of its workstreams. */
  readonly project = input<Project | null>(null);
  /** Chart only the issues of this milestone (and its target date). */
  readonly milestone = input<Milestone | null>(null);
  readonly height = input(200);
  /** Hide the Scope / Started / Completed header (when the page shows its own). */
  readonly showHeader = input(true);
  /** Tighter footer (no estimate hint). */
  readonly compactMode = input(false, { alias: 'compact' });

  protected readonly hatchId = `ms-hatch-${++seq}`;
  protected readonly scope = SCOPE;
  protected readonly started = STARTED;
  protected readonly completed = COMPLETED;
  protected readonly red = RED;
  protected readonly mt = 12;
  protected readonly mr = 12;
  protected readonly mb = 26;
  protected readonly hover = signal<number | null>(null);
  protected readonly hoverMs = signal<string | null>(null);
  private readonly measure = trackWidth(320);
  protected readonly width = this.measure.width;

  private readonly wsIssues = computed(() => {
    const p = this.project();
    if (p) return this.store.issuesByProject().get(p.id) ?? [];
    const w = this.ws();
    return w ? (this.store.issuesByWorkstream().get(w.id) ?? []) : [];
  });
  private readonly issues = computed(() => {
    const m = this.milestone();
    return m ? this.wsIssues().filter((i) => i.milestoneIds?.includes(m.id)) : this.wsIssues();
  });

  private readonly linkedDay = computed(() => {
    const p = this.project();
    const ids = new Set(p ? (this.store.workstreamsByProject().get(p.id) ?? []).map((x) => x.id) : [this.ws()?.id ?? '']);
    const map = new Map<string, number>();
    for (const e of this.store.events()) {
      if (e.type !== 'issue.linked' || !e.workstreamId || !ids.has(e.workstreamId) || e.subject.type !== 'issue') continue;
      const d = dayOf(e.at);
      const cur = map.get(e.subject.id);
      if (cur === undefined || d < cur) map.set(e.subject.id, d);
    }
    return map;
  });

  protected readonly model = computed(() => {
    const scope = this.project() ?? this.ws();
    const m = this.milestone();
    const target = m ? m.targetDate : scope?.targetDate;
    return buildBurnup({
      issues: this.issues(),
      points: usesPoints(this.wsIssues(), this.store.estimateScale()),
      startDay: dayOf(scope?.startDate ?? scope?.createdAt ?? new Date()),
      targetDay: target ? dayOf(target) : null,
      today: todayDay(),
      linkedDay: this.linkedDay(),
    });
  });

  // ───────── legend / header ─────────

  protected readonly legend = computed(() => {
    const t = this.model().totals;
    const f = (n: number): string => (t.points ? `◬ ${fmtNum(n)}` : fmtNum(n));
    return [
      { key: 'scope', label: 'Scope', color: SCOPE, value: f(t.scope) },
      { key: 'started', label: 'Started', color: STARTED, value: f(t.started) },
      { key: 'completed', label: 'Completed', color: COMPLETED, value: f(t.completed) },
    ];
  });

  protected readonly health = computed(() => {
    switch (this.model().health) {
      case 'done':
        return { label: 'Completed', color: 'var(--status-shipped)' };
      case 'on-track':
        return { label: 'On track', color: 'var(--status-shipped)' };
      case 'at-risk':
        return { label: 'At risk', color: 'var(--status-needs-input)' };
      case 'late':
        return { label: 'Past target', color: RED };
      default:
        return { label: 'Not started', color: 'var(--muted-foreground)' };
    }
  });

  protected readonly eta = computed(() => {
    const m = this.model();
    if (m.health === 'done' || m.etaDay === null) return null;
    return `~${format(dateOfDay(m.etaDay), 'MMM d')} at current pace`;
  });

  protected readonly summary = computed(() => {
    const m = this.model();
    const t = m.totals;
    const unit = (n: number): string => unitLabel(n, t.points);
    return `Progress: ${unit(t.completed)} completed, ${unit(t.started)} started of ${unit(t.scope)} scope. ${this.health().label}.`;
  });

  // ───────── geometry ─────────

  private readonly yScale = computed(() => niceScale(this.model().yMax, { integer: !this.model().points || this.model().yMax >= 10 }));
  protected readonly ml = computed(() => Math.max(26, Math.max(...this.yScale().ticks.map((t) => compact(t).length), 1) * 6.6 + 14));
  protected readonly innerW = computed(() => Math.max(10, this.width() - this.ml() - this.mr));
  protected readonly innerH = computed(() => this.height() - this.mt - this.mb);

  protected px(day: number): number {
    const m = this.model();
    return this.ml() + ((day - m.startDay) / Math.max(1, m.xMax - m.startDay)) * this.innerW();
  }
  protected py(v: number): number {
    return this.mt + this.innerH() - (v / this.yScale().max) * this.innerH();
  }
  protected diamondPoints(x: number, y: number): string {
    const r = 5.5;
    return `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`;
  }

  protected readonly yTicks = computed(() => this.yScale().ticks.map((value) => ({ value, y: this.py(value), label: compact(value) })));

  protected readonly xTicks = computed(() => {
    const m = this.model();
    const span = m.xMax - m.startDay;
    const perDay = this.innerW() / Math.max(1, span);
    const steps = [1, 2, 7, 14, 30, 60, 91, 182, 365];
    const step = steps.find((s) => s * perDay >= 62) ?? 365;
    const out: { day: number; x: number; label: string; anchor: string }[] = [];
    for (let d = m.startDay; d <= m.xMax; d += step) {
      const date = dateOfDay(d);
      out.push({ day: d, x: this.px(d), label: format(date, step >= 60 ? "MMM ''yy" : 'MMM d'), anchor: d === m.startDay ? 'start' : 'middle' });
    }
    // drop a last tick that would collide with the edge
    return out.filter((t) => t.x <= this.width() - this.mr - 14 || t.day === m.startDay);
  });

  protected readonly todayX = computed(() => this.px(this.model().today));
  protected readonly targetX = computed(() => {
    const m = this.model();
    return m.targetDay !== null && m.targetDay > m.startDay && m.targetDay >= m.today ? this.px(m.targetDay) : null;
  });
  protected readonly overdueBand = computed(() => {
    const m = this.model();
    if (!m.overdue || m.targetDay === null) return null;
    const x = Math.max(this.ml(), this.px(m.targetDay));
    return { x, w: Math.max(2, this.px(m.today) - x) };
  });

  protected readonly paths = computed(() => {
    const m = this.model();
    const line = (get: (p: { scope: number; started: number; completed: number }) => number): { d: string; pts: [number, number][] } => {
      const pts = simplify(m.series, get).map((p) => [this.px(p.day), this.py(get(p))] as [number, number]);
      return { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(''), pts };
    };
    const scope = line((p) => p.scope);
    const started = line((p) => p.started);
    const done = line((p) => p.completed);
    const base = this.py(0);
    const first = done.pts[0];
    const last = done.pts[done.pts.length - 1];
    return {
      scope: scope.d,
      started: started.d,
      completed: done.d,
      completedArea: first ? `${done.d}L${last[0].toFixed(1)},${base}L${first[0].toFixed(1)},${base}Z` : '',
    };
  });

  protected readonly cone = computed(() => {
    const m = this.model();
    const p = m.projection;
    if (!p) return null;
    const last = m.series[m.series.length - 1];
    const x0 = this.px(m.today);
    const x1 = this.px(p.targetDay);
    const y0 = this.py(last.completed);
    const yProj = this.py(p.projectedAtTarget);
    const yReq = this.py(p.required);
    const f = (n: number): string => n.toFixed(1);
    return {
      projected: `M${f(x0)},${f(y0)}L${f(x1)},${f(yProj)}`,
      required: `M${f(x0)},${f(y0)}L${f(x1)},${f(yReq)}`,
      scope: `M${f(x0)},${f(this.py(last.scope))}L${f(x1)},${f(this.py(last.scope))}`,
      area: `M${f(x0)},${f(y0)}L${f(x1)},${f(yProj)}L${f(x1)},${f(yReq)}Z`,
    };
  });

  protected readonly bars = computed(() => {
    const m = this.model();
    const zone = this.innerH() * 0.17;
    const max = Math.max(1, ...m.bars.map((b) => b.value));
    return m.bars
      .filter((b) => b.value > 0)
      .map((b) => {
        const x0 = this.px(b.from);
        const x1 = Math.min(this.px(b.to), this.px(m.today + 0.5));
        const h = Math.max(2, (b.value / max) * zone);
        return { from: b.from, x: x0 + 1, w: Math.max(2, x1 - x0 - 2), h, y: this.py(0) - h };
      });
  });

  protected readonly diamonds = computed(() => {
    const m = this.model();
    const one = this.milestone();
    const p = this.project();
    const w = this.ws();
    const list = one ? [one] : p ? (this.store.milestonesByProject().get(p.id) ?? []) : w ? (this.store.milestonesByWorkstream().get(w.id) ?? []) : [];
    const states = this.info.states();
    const y = this.mt + this.innerH();
    return list
      .filter((x) => x.targetDate)
      .map((x) => {
        const day = dayOf(x.targetDate!);
        const st = states.get(x.id);
        return {
          id: x.id,
          day,
          x: this.px(Math.min(Math.max(day, m.startDay), m.xMax)),
          y,
          fill: st === 'done' ? 'var(--status-shipped)' : 'var(--background)',
          stroke: st === 'done' ? 'var(--status-shipped)' : st === 'overdue' ? RED : 'var(--entity-workstream)',
        };
      });
  });

  // ───────── hover ─────────

  protected readonly hoverX = computed(() => {
    const d = this.hover();
    return d === null ? null : this.px(d);
  });

  protected readonly dots = computed(() => {
    const d = this.hover();
    const m = this.model();
    if (d === null || d > m.today) return [];
    const p = m.series[d - m.startDay];
    if (!p) return [];
    const x = this.px(d);
    return [
      { key: 'scope', color: SCOPE, x, y: this.py(p.scope) },
      { key: 'started', color: STARTED, x, y: this.py(p.started) },
      { key: 'completed', color: COMPLETED, x, y: this.py(p.completed) },
    ];
  });

  protected readonly tip = computed(() => {
    const d = this.hover();
    const m = this.model();
    if (d === null) return null;
    const v = (n: number): string => (m.points ? `◬ ${fmtNum(n)}` : fmtNum(n));
    const title = format(dateOfDay(d), 'EEE, MMM d, yyyy');
    if (d <= m.today) {
      const p = m.series[d - m.startDay];
      if (!p) return null;
      return {
        x: this.px(d),
        title,
        rows: [
          { key: 'scope', label: 'Scope', color: SCOPE, value: v(p.scope) },
          { key: 'started', label: 'Started', color: STARTED, value: v(p.started) },
          { key: 'completed', label: 'Completed', color: COMPLETED, value: v(p.completed) },
        ],
      };
    }
    const last = m.series[m.series.length - 1];
    const proj = m.projection;
    if (!proj) return null;
    const t = (d - m.today) / Math.max(1, proj.targetDay - m.today);
    return {
      x: this.px(d),
      title: `${title} · projected`,
      rows: [
        { key: 'scope', label: 'Scope', color: SCOPE, value: v(last.scope) },
        { key: 'proj', label: 'At current pace', color: COMPLETED, value: v(last.completed + (proj.projectedAtTarget - last.completed) * t) },
        { key: 'req', label: 'Required', color: COMPLETED, value: v(last.completed + (proj.required - last.completed) * t) },
      ],
    };
  });

  protected readonly msTip = computed(() => {
    const id = this.hoverMs();
    const d = id ? this.diamonds().find((x) => x.id === id) : undefined;
    const ms = id ? this.store.getMilestone(id) : undefined;
    const s = id ? this.info.stats().get(id) : undefined;
    if (!d || !ms || !s) return null;
    return { x: d.x, y: d.y - 4, name: ms.name, date: format(dateOfDay(d.day), 'MMM d'), progress: progressLabel(s) };
  });

  protected onMove(ev: PointerEvent): void {
    const m = this.model();
    const r = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width)));
    const day = m.startDay + Math.round(ratio * (m.xMax - m.startDay));
    this.hover.set(day > m.today && !m.projection ? m.today : day);
  }

  protected onKey(ev: KeyboardEvent): void {
    const m = this.model();
    const cur = this.hover() ?? m.today;
    const max = m.projection ? m.xMax : m.today;
    if (ev.key === 'ArrowLeft') this.hover.set(Math.max(m.startDay, cur - 1));
    else if (ev.key === 'ArrowRight') this.hover.set(Math.min(max, cur + 1));
    else if (ev.key === 'Escape') this.hover.set(null);
    else return;
    ev.preventDefault();
  }
}
