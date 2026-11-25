// The burn-up of a project (v3 "33 · Project · Progress") or of one of its milestones as a 180×34 sparkline:
// Scope (grey), Started and Completed (amber) from the start date to today, then the dashed line to the
// day the work lands at the current pace with its amber wash, and the milestones as diamonds on the axis.
// Series are rebuilt from the tasks' timestamps (`buildBurnup`); tasks without an estimate count as 1 point.
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { format } from 'date-fns';
import { TramaStore, type Milestone, type Project } from '../../core';
import { ChartTip } from '../stats/charts/chart-tip';
import { niceScale, trackWidth } from '../stats/charts/chart-utils';
import {
  dateOfDay,
  dayOf,
  fmtNum,
  simplify,
  todayDay,
  usesPoints,
  type BurnPoint,
} from '../milestones/milestone-model';
import { MilestoneInfo } from '../milestones/milestone-stats';
import { buildBurnView, burnBadge, projectTargetDay, slackText, type BurnTone } from './project-burnup-model';

/** Plot area of the full chart: 158px tall, 4px above the top line and below the zero line. */
const PLOT_H = 158;
const PLOT_TOP = 4;
const PLOT_BOTTOM = 154;
const X_AXIS_H = 26;
const Y_AXIS_W = 28;
const MINI_W = 180;
const MINI_H = 34;

const TONE_TEXT: Record<BurnTone, string> = {
  ok: 'text-status-done',
  warn: 'text-status-in-progress',
  late: 'text-red',
  idle: 'text-muted-foreground',
};
const TONE_FILL: Record<BurnTone, string> = {
  ok: 'bg-status-done/10',
  warn: 'bg-status-in-progress/10',
  late: 'bg-red/10',
  idle: 'bg-muted-foreground/10',
};
const TONE_DOT: Record<BurnTone, string> = {
  ok: 'bg-status-done',
  warn: 'bg-status-in-progress',
  late: 'bg-red',
  idle: 'bg-muted-foreground',
};

@Component({
  selector: 'app-project-burnup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartTip],
  host: {
    '[class]': 'mini() ? "block h-[34px] w-[180px] shrink-0" : "bg-card border-border relative flex min-w-0 flex-col gap-3.5 border px-4 pt-3.5 pb-3"',
  },
  template: `
    @let m = view().model;
    @if (mini()) {
      <svg [attr.viewBox]="'0 0 ' + miniW + ' ' + miniH" [attr.width]="miniW" [attr.height]="miniH" class="block overflow-visible" role="img" [attr.aria-label]="summary()">
        @if (m.totals.scope > 0) {
          <line [attr.x1]="0" [attr.x2]="miniW" [attr.y1]="miniH - 0.5" [attr.y2]="miniH - 0.5" class="stroke-border" stroke-width="1" />
          @if (projArea(); as a) {
            <path [attr.d]="a" class="fill-status-in-progress" fill-opacity="0.1" />
          }
          @if (todayInside()) {
            <line [attr.x1]="todayX()" [attr.x2]="todayX()" y1="0" [attr.y2]="miniH" class="stroke-line" stroke-width="1" />
          }
          @if (scopeAhead(); as s) {
            <path [attr.d]="s" class="stroke-muted-foreground" fill="none" stroke-width="1" stroke-dasharray="3 3" />
          }
          <path [attr.d]="paths().scope" class="stroke-muted-foreground" fill="none" stroke-width="1.25" stroke-linejoin="round" />
          <path [attr.d]="paths().completed" class="stroke-status-in-progress" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
          @if (projLine(); as p) {
            <path [attr.d]="p" class="stroke-status-in-progress" fill="none" stroke-width="1.25" stroke-dasharray="3 3" />
          }
        }
      </svg>
    } @else {
      <div class="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div class="flex flex-wrap items-center gap-x-[18px] gap-y-1.5">
          @for (s of legend(); track s.key) {
            <span class="inline-flex items-center gap-1.5">
              <span class="h-0.5 w-3 shrink-0" [class]="s.cls"></span>
              <span class="text-muted-foreground text-[12.5px] leading-4">{{ s.label }}</span>
              <span class="text-foreground font-mono text-xs leading-4 tabular-nums">{{ s.value }}</span>
            </span>
          }
        </div>
        <div class="flex items-center gap-3">
          @if (projected(); as p) {
            <span class="text-faint font-mono text-[11px] leading-4">{{ p }}</span>
          }
          @if (badge(); as b) {
            <span class="inline-flex items-center gap-1.5 px-2 py-[3px] text-xs leading-4" [class]="toneFill[b.tone] + ' ' + toneText[b.tone]">
              <span class="size-[7px] shrink-0" [class]="toneDot[b.tone]" aria-hidden="true"></span>{{ b.label }}
            </span>
          }
        </div>
      </div>

      @if (m.totals.scope === 0) {
        <p class="text-faint flex h-[158px] items-center justify-center text-center font-mono text-[11px]">
          Link tasks to see progress over time.
        </p>
      } @else {
        <div class="relative outline-none" tabindex="0" [attr.aria-label]="summary()" (keydown)="onKey($event)" (blur)="hover.set(null)">
          <svg [attr.viewBox]="'0 0 ' + width() + ' ' + bigH" [attr.width]="width()" [attr.height]="bigH" class="block max-w-full overflow-visible select-none" role="img" [attr.aria-label]="summary()">
            @for (t of yTicks(); track t.value) {
              <line [attr.x1]="ml" [attr.x2]="width()" [attr.y1]="t.y" [attr.y2]="t.y" [class]="t.value === 0 ? 'stroke-border' : 'stroke-grid'" stroke-width="1" />
              <text x="0" [attr.y]="t.y" dominant-baseline="middle" font-size="10" class="fill-faint font-mono">{{ t.label }}</text>
            }
            @for (t of xTicks(); track t.day) {
              <text [attr.x]="t.x" [attr.y]="bigH - 6" [attr.text-anchor]="t.anchor" font-size="10" class="fill-faint font-mono">{{ t.label }}</text>
            }

            @if (todayInside()) {
              <line [attr.x1]="todayX()" [attr.x2]="todayX()" y1="0" [attr.y2]="plotH" class="stroke-line" stroke-width="1" />
              <text [attr.x]="todayX() + 5" y="12" font-size="10" class="fill-faint font-mono">Today</text>
            }
            @if (projArea(); as a) {
              <path [attr.d]="a" class="fill-status-in-progress" fill-opacity="0.1" />
            }
            @if (scopeAhead(); as s) {
              <path [attr.d]="s" class="stroke-muted-foreground" fill="none" stroke-width="1.25" stroke-dasharray="4 4" />
            }
            <path [attr.d]="paths().scope" class="stroke-muted-foreground" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
            <path [attr.d]="paths().started" class="stroke-status-in-progress" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
            <path [attr.d]="paths().completed" class="stroke-status-in-progress" fill="none" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
            @if (projLine(); as p) {
              <path [attr.d]="p" class="stroke-status-in-progress" fill="none" stroke-width="1.25" stroke-dasharray="4 4" />
            }

            @if (hoverX(); as hx) {
              <line [attr.x1]="hx" [attr.x2]="hx" y1="0" [attr.y2]="plotH" class="stroke-muted-foreground" stroke-opacity="0.55" stroke-width="1" />
            }
            @for (d of dots(); track d.key) {
              <rect [attr.x]="d.x - 3" [attr.y]="d.y - 3" width="6" height="6" [class]="d.cls" />
            }

            <rect [attr.x]="ml" y="0" [attr.width]="innerW()" [attr.height]="plotH" fill="transparent" (pointermove)="onMove($event)" (pointerleave)="hover.set(null)" />

            @for (d of diamonds(); track d.id) {
              <g (pointerenter)="hoverMs.set(d.id)" (pointerleave)="hoverMs.set(null)">
                <rect [attr.x]="d.x - 9" [attr.y]="d.y - 9" width="18" height="18" fill="transparent" />
                <polygon [attr.points]="diamondPoints(d.x, d.y)" class="fill-background" [class]="d.cls" stroke-width="1.5" stroke-linejoin="round" />
              </g>
            }
          </svg>

          @if (tip(); as t) {
            <app-chart-tip [x]="t.x" [y]="PLOT_TOP" [bounds]="width()">
              <div class="text-muted-foreground mb-1 font-mono text-[11px] tabular-nums">{{ t.title }}</div>
              <ul class="flex flex-col gap-1">
                @for (r of t.rows; track r.key) {
                  <li class="flex items-center gap-2">
                    <span class="h-0.5 w-2.5 shrink-0" [class]="r.cls"></span>
                    <span class="text-muted-foreground min-w-0 flex-1 truncate">{{ r.label }}</span>
                    <span class="text-foreground font-mono tabular-nums">{{ r.value }}</span>
                  </li>
                }
              </ul>
            </app-chart-tip>
          }
          @if (msTip(); as t) {
            <app-chart-tip [x]="t.x" [y]="t.y" [bounds]="width()" [above]="true">
              <div class="text-foreground font-medium">{{ t.name }}</div>
              <div class="text-muted-foreground font-mono text-[11px] tabular-nums">{{ t.date }} · {{ t.progress }}</div>
            </app-chart-tip>
          }
        </div>
        @if (m.totals.defaulted > 0) {
          <p class="text-faint font-mono text-[10.5px]">
            {{ m.totals.defaulted }} {{ m.totals.defaulted === 1 ? 'task has' : 'tasks have' }} no estimate and
            {{ m.totals.defaulted === 1 ? 'counts' : 'count' }} as 1 point.
          </p>
        }
      }
    }
  `,
})
export class ProjectBurnup {
  private readonly store = inject(TramaStore);
  private readonly info = inject(MilestoneInfo);

  readonly project = input.required<Project>();
  /** Chart only this milestone's tasks, up to its target date. */
  readonly milestone = input<Milestone | null>(null);
  /** The 180×34 sparkline. */
  readonly mini = input(false);

  protected readonly toneText = TONE_TEXT;
  protected readonly toneFill = TONE_FILL;
  protected readonly toneDot = TONE_DOT;
  protected readonly miniW = MINI_W;
  protected readonly miniH = MINI_H;
  protected readonly PLOT_TOP = PLOT_TOP;
  protected readonly plotH = PLOT_H;
  protected readonly bigH = PLOT_H + X_AXIS_H;
  protected readonly ml = Y_AXIS_W;
  protected readonly hover = signal<number | null>(null);
  protected readonly hoverMs = signal<string | null>(null);

  private readonly measure = trackWidth(752 + Y_AXIS_W);
  protected readonly width = this.measure.width;

  private readonly projectIssues = computed(() => this.store.issuesByProject().get(this.project().id) ?? []);
  private readonly milestones = computed(() => this.store.milestonesByProject().get(this.project().id) ?? []);
  private readonly milestoneDays = computed(() =>
    this.milestones()
      .filter((m) => m.targetDate)
      .map((m) => dayOf(m.targetDate!)),
  );
  private readonly issues = computed(() => {
    const ms = this.milestone();
    return ms ? this.projectIssues().filter((i) => i.milestoneIds?.includes(ms.id)) : this.projectIssues();
  });

  protected readonly view = computed(() => {
    const p = this.project();
    const ms = this.milestone();
    const last = this.milestoneDays().reduce((a, b) => Math.max(a, b), 0) || null;
    const projectTarget = projectTargetDay(p, this.milestones());
    const target = ms ? (ms.targetDate ? dayOf(ms.targetDate) : null) : projectTarget;
    return buildBurnView({
      issues: this.issues(),
      points: usesPoints(this.projectIssues(), this.store.estimateScale()),
      startDay: dayOf(p.startDate ?? p.createdAt),
      targetDay: target,
      today: todayDay(),
      endHint: this.mini() ? target : Math.max(projectTarget ?? 0, last ?? 0) || null,
      pad: this.mini() ? 0 : 14,
    });
  });

  // ───────── header ─────────

  protected readonly legend = computed(() => {
    const t = this.view().model.totals;
    const unit = (n: number): string => fmtNum(n);
    return [
      { key: 'scope', label: 'Scope', cls: 'bg-muted-foreground', value: t.points ? `${unit(t.scope)} pts` : `${unit(t.scope)} tasks` },
      { key: 'started', label: 'Started', cls: 'bg-status-in-progress', value: unit(t.started) },
      { key: 'completed', label: 'Completed', cls: 'bg-status-in-progress', value: unit(t.completed) },
    ];
  });

  protected readonly badge = computed(() => (this.view().model.totals.scope > 0 ? burnBadge(this.view().model) : null));

  protected readonly projected = computed(() => {
    const v = this.view();
    if (v.etaDay === null || v.model.health === 'done' || v.model.totals.scope === 0) return null;
    const when = `Projected ${format(dateOfDay(v.etaDay), 'MMM d')}`;
    return v.slackDays === null ? when : `${when} · ${slackText(v.slackDays)}`;
  });

  protected readonly summary = computed(() => {
    const t = this.view().model.totals;
    const u = (n: number): string => (t.points ? `${fmtNum(n)} points` : `${fmtNum(n)} tasks`);
    return `Progress: ${u(t.completed)} completed, ${u(t.started)} started of ${u(t.scope)} scope.`;
  });

  // ───────── geometry ─────────

  private readonly yScale = computed(() => {
    const m = this.view().model;
    return niceScale(m.yMax, { integer: !m.points || m.yMax >= 10 });
  });
  protected readonly innerW = computed(() => (this.mini() ? MINI_W : Math.max(10, this.width() - Y_AXIS_W)));
  private readonly left = computed(() => (this.mini() ? 0 : Y_AXIS_W));

  protected px(day: number): number {
    const v = this.view();
    const span = Math.max(1, v.endDay - v.model.startDay);
    return this.left() + ((day - v.model.startDay) / span) * this.innerW();
  }
  protected py(value: number): number {
    const top = this.mini() ? 2 : PLOT_TOP;
    const bottom = this.mini() ? MINI_H - 2 : PLOT_BOTTOM;
    return bottom - (value / this.yScale().max) * (bottom - top);
  }
  protected diamondPoints(x: number, y: number): string {
    const r = 5;
    return `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`;
  }

  protected readonly yTicks = computed(() => this.yScale().ticks.map((value) => ({ value, y: this.py(value), label: String(value) })));

  protected readonly xTicks = computed(() => {
    const v = this.view();
    const n = 6;
    const span = v.endDay - v.model.startDay;
    return Array.from({ length: n }, (_, i) => {
      const day = Math.round(v.model.startDay + (span * i) / (n - 1));
      return {
        day,
        x: this.px(day),
        label: format(dateOfDay(day), 'MMM d'),
        anchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
      };
    });
  });

  protected readonly todayX = computed(() => this.px(this.view().model.today));
  protected readonly todayInside = computed(() => {
    const v = this.view();
    return v.model.today > v.model.startDay && v.model.today < v.endDay;
  });

  private pathOf(points: readonly BurnPoint[], get: (p: BurnPoint) => number): string {
    return simplify(points, get)
      .map((p, i) => `${i ? 'L' : 'M'}${this.px(p.day).toFixed(1)},${this.py(get(p)).toFixed(1)}`)
      .join('');
  }

  protected readonly paths = computed(() => {
    const s = this.view().model.series;
    return {
      scope: this.pathOf(s, (p) => p.scope),
      started: this.pathOf(s, (p) => p.started),
      completed: this.pathOf(s, (p) => p.completed),
    };
  });

  private readonly last = computed(() => {
    const s = this.view().model.series;
    return s[s.length - 1];
  });

  /** Scope from today to the edge, dashed. */
  protected readonly scopeAhead = computed(() => {
    const v = this.view();
    if (v.model.totals.scope === 0 || v.endDay <= v.model.today) return null;
    const y = this.py(this.last().scope).toFixed(1);
    return `M${this.px(v.model.today).toFixed(1)},${y}H${this.px(v.endDay).toFixed(1)}`;
  });

  protected readonly projLine = computed(() => {
    const p = this.view().proj;
    if (!p) return null;
    const x0 = this.px(this.view().model.today);
    return `M${x0.toFixed(1)},${this.py(this.last().completed).toFixed(1)}L${this.px(p.toDay).toFixed(1)},${this.py(p.toValue).toFixed(1)}`;
  });

  /** Amber wash under the projection, down to the zero line. */
  protected readonly projArea = computed(() => {
    const p = this.view().proj;
    if (!p) return null;
    const x0 = this.px(this.view().model.today);
    const x1 = this.px(p.toDay);
    const base = this.py(0);
    const f = (n: number): string => n.toFixed(1);
    return `M${f(x0)},${f(this.py(this.last().completed))}L${f(x1)},${f(this.py(p.toValue))}V${f(base)}H${f(x0)}Z`;
  });

  protected readonly diamonds = computed(() => {
    if (this.mini()) return [];
    const v = this.view();
    const one = this.milestone();
    const list = one ? [one] : this.milestones();
    const states = this.info.states();
    const y = PLOT_BOTTOM;
    return list
      .filter((x) => x.targetDate)
      .map((x) => {
        const day = dayOf(x.targetDate!);
        const st = states.get(x.id);
        return {
          id: x.id,
          day,
          x: this.px(Math.min(Math.max(day, v.model.startDay), v.endDay)),
          y,
          cls: st === 'done' ? 'stroke-status-done' : st === 'overdue' ? 'stroke-red' : st === 'active' ? 'stroke-status-in-progress' : 'stroke-faint',
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
    const v = this.view();
    if (d === null || d > v.model.today) return [];
    const p = v.model.series[d - v.model.startDay];
    if (!p) return [];
    const x = this.px(d);
    return [
      { key: 'scope', cls: 'fill-muted-foreground', x, y: this.py(p.scope) },
      { key: 'started', cls: 'fill-status-in-progress', x, y: this.py(p.started) },
      { key: 'completed', cls: 'fill-status-in-progress', x, y: this.py(p.completed) },
    ];
  });

  protected readonly tip = computed(() => {
    const d = this.hover();
    const v = this.view();
    if (d === null) return null;
    const f = (n: number): string => fmtNum(n);
    const title = format(dateOfDay(d), 'EEE, MMM d, yyyy');
    if (d <= v.model.today) {
      const p = v.model.series[d - v.model.startDay];
      if (!p) return null;
      return {
        x: this.px(d),
        title,
        rows: [
          { key: 'scope', label: 'Scope', cls: 'bg-muted-foreground', value: f(p.scope) },
          { key: 'started', label: 'Started', cls: 'bg-status-in-progress', value: f(p.started) },
          { key: 'completed', label: 'Completed', cls: 'bg-status-in-progress', value: f(p.completed) },
        ],
      };
    }
    const proj = v.proj;
    if (!proj) return null;
    const last = this.last();
    const t = Math.min(1, (d - v.model.today) / Math.max(1, proj.toDay - v.model.today));
    return {
      x: this.px(d),
      title: `${title} · projected`,
      rows: [
        { key: 'scope', label: 'Scope', cls: 'bg-muted-foreground', value: f(last.scope) },
        { key: 'proj', label: 'At current pace', cls: 'bg-status-in-progress', value: f(last.completed + (proj.toValue - last.completed) * t) },
      ],
    };
  });

  protected readonly msTip = computed(() => {
    const id = this.hoverMs();
    const d = id ? this.diamonds().find((x) => x.id === id) : undefined;
    const ms = id ? this.store.getMilestone(id) : undefined;
    const s = id ? this.info.stats().get(id) : undefined;
    if (!d || !ms || !s) return null;
    const progress = s.issues === 0 ? 'No tasks' : `${s.percent}% of ${s.issues} ${s.issues === 1 ? 'task' : 'tasks'}`;
    return { x: d.x, y: d.y - 4, name: ms.name, date: format(dateOfDay(d.day), 'MMM d'), progress };
  });

  protected onMove(ev: PointerEvent): void {
    const v = this.view();
    const r = (ev.currentTarget as SVGRectElement).getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width)));
    const day = v.model.startDay + Math.round(ratio * (v.endDay - v.model.startDay));
    this.hover.set(day > v.model.today && !v.proj ? v.model.today : Math.min(day, v.proj ? v.proj.toDay : day));
  }

  protected onKey(ev: KeyboardEvent): void {
    const v = this.view();
    const cur = this.hover() ?? v.model.today;
    const max = v.proj ? v.proj.toDay : v.model.today;
    if (ev.key === 'ArrowLeft') this.hover.set(Math.max(v.model.startDay, cur - 1));
    else if (ev.key === 'ArrowRight') this.hover.set(Math.min(max, cur + 1));
    else if (ev.key === 'Escape') this.hover.set(null);
    else return;
    ev.preventDefault();
  }
}
