// The Progress view of a task (v3 "34 Task detail · Progress"): a small burn-up of its subtasks. Scope in grey,
// Started and Done in amber, a dashed projection from today to the due date, and the Today / Due markers. The
// series come from the subtasks' own dates (`buildBurnup`, shared with the project and milestone chart); the
// plot is plain SVG, 60px tall, as wide as the section.
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { format } from 'date-fns';
import { TramaStore, type Issue } from '../../core';
import { trackWidth } from '../stats/charts/chart-utils';
import {
  buildBurnup,
  dateOfDay,
  dayOf,
  fmtNum,
  todayDay,
  usesPoints,
  type BurnHealth,
} from '../milestones/milestone-model';

const PLOT_H = 60;
/** Y of the base line; the series are drawn in the 56px above it, starting 2px down. */
const BASE_Y = 58;
const TOP = 2;

const HEALTH: Record<BurnHealth, { label: string; tone: 'yellow' | 'green' | 'red' | 'faint' }> = {
  done: { label: 'Done', tone: 'green' },
  'on-track': { label: 'On track', tone: 'green' },
  'at-risk': { label: 'At risk', tone: 'yellow' },
  late: { label: 'Past due', tone: 'red' },
  idle: { label: 'Not started', tone: 'faint' },
};

@Component({
  selector: 'app-task-burnup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'bg-card border-border flex min-w-0 flex-col gap-2.5 border px-3.5 pt-2.5 pb-2' },
  template: `
    @let m = model();
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
        @for (s of legend(); track s.key) {
          <span class="flex items-center gap-1.5">
            <span class="h-0.5 w-2.5 shrink-0" [style.background]="s.color"></span>
            <span class="text-muted-foreground text-xs leading-4">{{ s.label }}</span>
            <span class="text-foreground font-mono text-[11.5px] leading-[14px]">{{ s.value }}</span>
          </span>
        }
      </div>
      <div class="flex items-center gap-2.5">
        <span class="text-faint font-mono text-[11px] leading-[14px]">{{ projection() }}</span>
        <span
          class="flex items-center gap-1.5 px-[7px] py-0.5"
          [class]="badge().box"
        >
          <span class="size-1.5 shrink-0" [class]="badge().dot"></span>
          <span class="text-[11.5px] leading-[14px]" [class]="badge().text">{{ badge().label }}</span>
        </span>
      </div>
    </div>

    <svg
      class="block w-full overflow-visible"
      role="img"
      [attr.aria-label]="summary()"
      [attr.width]="width()"
      [attr.height]="plotH"
      [attr.viewBox]="'0 0 ' + width() + ' ' + plotH"
    >
      <rect x="0" [attr.y]="baseY" [attr.width]="width()" height="1" style="fill: var(--border)" />
      @if (dueX(); as dx) {
        <rect [attr.x]="dx" y="0" width="1" [attr.height]="plotH" style="fill: var(--red)" />
      }
      @if (todayX() < width() - 2) {
        <rect [attr.x]="todayX()" y="0" width="1" [attr.height]="plotH" style="fill: var(--line)" />
      }
      @if (proj(); as p) {
        <path [attr.d]="p.area" style="fill: var(--yellow)" fill-opacity="0.1" />
        <path [attr.d]="p.line" fill="none" style="stroke: var(--yellow)" stroke-width="1.25" stroke-dasharray="4 4" />
        <path [attr.d]="p.scope" fill="none" style="stroke: var(--muted-foreground)" stroke-width="1.25" stroke-dasharray="4 4" />
      }
      <path [attr.d]="paths().scope" fill="none" style="stroke: var(--muted-foreground)" stroke-width="1.25" />
      <path [attr.d]="paths().started" fill="none" style="stroke: var(--yellow)" stroke-width="1.25" />
      <path [attr.d]="paths().done" fill="none" style="stroke: var(--yellow)" stroke-width="1.75" />
    </svg>

    <div class="text-faint relative h-[13px] font-mono text-[10px] leading-[13px]">
      <span class="absolute left-0 top-0">{{ startLabel() }}</span>
      @if (showToday()) {
        <span class="absolute top-0" [style.left.px]="todayX() - 15">Today</span>
      }
      @if (m.targetDay !== null) {
        <span class="text-red absolute top-0 right-0">Due {{ dueLabel() }}</span>
      }
    </div>
  `,
})
export class TaskBurnup {
  private readonly store = inject(TramaStore);
  private readonly measure = trackWidth(776);
  protected readonly width = this.measure.width;
  protected readonly plotH = PLOT_H;
  protected readonly baseY = BASE_Y;

  /** The task whose subtasks are charted. */
  readonly issue = input.required<Issue>();
  /** Every task below it, at any depth. */
  readonly tasks = input.required<readonly Issue[]>();

  protected readonly model = computed(() => {
    const i = this.issue();
    const tasks = this.tasks();
    return buildBurnup({
      issues: tasks,
      points: usesPoints(tasks, this.store.estimateScale()),
      startDay: dayOf(i.startedAt ?? i.createdAt),
      targetDay: i.dueDate ? dayOf(i.dueDate) : null,
      today: todayDay(),
      linkedDay: new Map<string, number>(),
    });
  });

  private readonly yMax = computed(() => Math.max(this.model().yMax, 1));

  private x(day: number): number {
    const m = this.model();
    return ((day - m.startDay) / Math.max(1, m.xMax - m.startDay)) * (this.width() - 1);
  }
  private y(value: number): number {
    return TOP + (BASE_Y - TOP) * (1 - value / this.yMax());
  }

  protected readonly todayX = computed(() => this.x(this.model().today));
  protected readonly dueX = computed(() => {
    const m = this.model();
    return m.targetDay !== null ? this.x(Math.max(m.targetDay, m.startDay + 1)) : null;
  });
  protected readonly showToday = computed(() => {
    const dx = this.dueX();
    return this.todayX() > 40 && (dx === null || dx - this.todayX() > 60);
  });

  /** Step lines: a level holds until the day it changes. */
  protected readonly paths = computed(() => {
    const m = this.model();
    const step = (get: (p: { scope: number; started: number; completed: number }) => number): string => {
      let d = '';
      let prev = NaN;
      for (const p of m.series) {
        const v = get(p);
        const px = this.x(p.day).toFixed(1);
        if (d === '') d = `M${px},${this.y(v).toFixed(1)}`;
        else if (v !== prev) d += `H${px}V${this.y(v).toFixed(1)}`;
        prev = v;
      }
      return d + `H${this.todayX().toFixed(1)}`;
    };
    return {
      scope: step((p) => p.scope),
      started: step((p) => p.started),
      done: step((p) => p.completed),
    };
  });

  /** From today to the due date: where the pace lands and the scope it has to reach. */
  protected readonly proj = computed(() => {
    const m = this.model();
    const last = m.series[m.series.length - 1];
    const dx = this.dueX();
    if (!m.projection || !last || dx === null) return null;
    const x0 = this.todayX();
    const f = (n: number): string => n.toFixed(1);
    const y1 = this.y(m.projection.projectedAtTarget);
    return {
      line: `M${f(x0)},${f(this.y(last.completed))}L${f(dx)},${f(y1)}`,
      area: `M${f(x0)},${f(this.y(last.completed))}L${f(dx)},${f(y1)}V${BASE_Y}H${f(x0)}Z`,
      scope: `M${f(x0)},${f(this.y(last.scope))}H${f(dx)}`,
    };
  });

  protected readonly legend = computed(() => {
    const t = this.model().totals;
    const unit = (n: number): string => (t.points ? `${fmtNum(n)} pts` : fmtNum(n));
    return [
      { key: 'scope', label: 'Scope', color: 'var(--muted-foreground)', value: unit(t.scope) },
      { key: 'started', label: 'Started', color: 'var(--yellow)', value: fmtNum(t.started) },
      { key: 'done', label: 'Done', color: 'var(--yellow)', value: fmtNum(t.completed) },
    ];
  });

  protected readonly projection = computed(() => {
    const m = this.model();
    const left = m.totals.scope - m.totals.completed;
    const what = m.totals.points ? `${fmtNum(left)} pts left` : `${fmtNum(left)} ${left === 1 ? 'task' : 'tasks'} left`;
    if (left <= 0) return 'all done';
    if (m.targetDay === null) return what;
    const days = m.targetDay - m.today;
    if (days < 0) return `${what} · ${-days} ${days === -1 ? 'day' : 'days'} past due`;
    if (days === 0) return `${what} · due today`;
    return `${what} · ${days} ${days === 1 ? 'day' : 'days'} to due`;
  });

  protected readonly badge = computed(() => {
    const h = HEALTH[this.model().health];
    const tone = {
      yellow: { box: 'bg-yellow/10', dot: 'bg-yellow', text: 'text-yellow' },
      green: { box: 'bg-green/10', dot: 'bg-green', text: 'text-green' },
      red: { box: 'bg-red/10', dot: 'bg-red', text: 'text-red' },
      faint: { box: 'bg-secondary', dot: 'bg-faint', text: 'text-muted-foreground' },
    }[h.tone];
    return { label: h.label, ...tone };
  });

  protected readonly startLabel = computed(() => format(dateOfDay(this.model().startDay), 'MMM d'));
  protected readonly dueLabel = computed(() => {
    const d = this.model().targetDay;
    return d === null ? '' : format(dateOfDay(d), 'MMM d');
  });

  protected readonly summary = computed(() => {
    const t = this.model().totals;
    return `Subtask progress: ${fmtNum(t.completed)} done and ${fmtNum(t.started)} started of ${fmtNum(t.scope)}${t.points ? ' points' : ''}. ${this.badge().label}.`;
  });
}
