import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { ChartTip } from './chart-tip';
import { SURFACE, trackWidth } from './chart-utils';
import { logScale } from './log-scale';

export interface ScatterPoint {
  id: string;
  key: string;
  title: string;
  /** Index of the column (estimate bucket) the point belongs to. */
  col: number;
  /** Days. */
  y: number;
  /** Tinted differently (took far longer than its bucket's median). */
  flagged: boolean;
  /** Tooltip line: "5 pts · 12d · 2.4× typical". */
  detail: string;
}

export interface ScatterColumn {
  label: string;
  n: number;
  /** Median of the plotted points; drawn as a tick. */
  median?: number;
}

/**
 * Dot plot: one column per estimate, actual days on a log axis, a median tick per column. Dots are
 * jittered sideways (deterministically) so equal values don't hide each other. Hover picks the nearest
 * dot; click emits its id. The two dot groups are legend toggles.
 */
@Component({
  selector: 'app-scatter-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartTip],
  host: { class: 'relative block min-w-0' },
  template: `
    <ul class="mb-2 flex flex-wrap gap-x-1 gap-y-1" aria-label="Legend (click to show or hide)">
      @for (g of groups; track g.key) {
        <li>
          <button
            type="button"
            class="hover:bg-hover text-muted-foreground flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors"
            [class.opacity-45]="hidden().has(g.key)"
            [attr.aria-pressed]="!hidden().has(g.key)"
            (click)="toggle(g.key)"
          >
            <span class="size-2 rounded-full" [style.background]="g.color"></span>
            <span [class.line-through]="hidden().has(g.key)">{{ g.label }}</span>
          </button>
        </li>
      }
      <li class="text-muted-foreground flex items-center gap-1.5 px-1.5 py-0.5 text-xs">
        <span class="h-0.5 w-3 rounded-full" style="background: var(--foreground)"></span>
        Median
      </li>
    </ul>

    <div class="relative">
      <svg
        [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
        [attr.width]="width()"
        [attr.height]="height()"
        class="block max-w-full overflow-visible select-none"
        role="img"
        [attr.aria-label]="ariaLabel()"
      >
        @for (t of scale().ticks; track t.value) {
          <line
            [attr.x1]="ml()"
            [attr.x2]="width() - mr"
            [attr.y1]="py(t.value)"
            [attr.y2]="py(t.value)"
            [style.stroke]="$first ? 'var(--border-strong)' : 'var(--border)'"
            [attr.stroke-dasharray]="$first ? null : '3 4'"
            stroke-width="1"
          />
          <text [attr.x]="ml() - 8" [attr.y]="py(t.value)" text-anchor="end" dominant-baseline="middle" font-size="11" class="tabular-nums" style="fill: var(--muted-foreground)">{{ t.label }}</text>
        }

        @for (c of columns(); track $index; let i = $index) {
          <text [attr.x]="cx(i)" [attr.y]="height() - 15" text-anchor="middle" font-size="11" class="tabular-nums" style="fill: var(--muted-foreground)">{{ c.label }}</text>
          <text [attr.x]="cx(i)" [attr.y]="height() - 3" text-anchor="middle" font-size="9.5" class="tabular-nums" style="fill: var(--muted-foreground)" fill-opacity="0.7">n={{ c.n }}</text>
        }

        @if (medianLine(); as m) {
          <path [attr.d]="m" fill="none" style="stroke: var(--muted-foreground)" stroke-opacity="0.5" stroke-width="1" stroke-dasharray="4 4" />
        }
        @for (m of medians(); track m.i) {
          <line [attr.x1]="m.x - m.w" [attr.x2]="m.x + m.w" [attr.y1]="m.y" [attr.y2]="m.y" style="stroke: var(--foreground)" stroke-width="2" stroke-linecap="round" />
        }

        @for (p of dots(); track p.id) {
          <circle
            [attr.cx]="p.x"
            [attr.cy]="p.y"
            [attr.r]="hover()?.id === p.id ? 6 : 4.5"
            [style.fill]="p.color"
            [attr.fill-opacity]="hover() === null || hover()?.id === p.id ? 0.92 : 0.5"
            [style.stroke]="surface"
            stroke-width="1.5"
          />
        }

        <rect
          [attr.x]="ml()"
          [attr.y]="mt"
          [attr.width]="innerW()"
          [attr.height]="innerH()"
          fill="transparent"
          [style.cursor]="hover() ? 'pointer' : 'default'"
          (pointermove)="onMove($event)"
          (pointerleave)="hover.set(null)"
          (click)="onClick()"
        />
      </svg>

      @if (hover(); as h) {
        <app-chart-tip [x]="h.x" [y]="h.y" [bounds]="width()">
          <div class="text-muted-foreground font-mono text-[11px]">{{ h.key }}</div>
          <div class="text-foreground mt-0.5 line-clamp-2 font-medium">{{ h.title }}</div>
          <div class="text-muted-foreground mt-1 tabular-nums">{{ h.detail }}</div>
          <div class="text-meta mt-1 text-[10px]">Click to open</div>
        </app-chart-tip>
      }

      <table class="sr-only">
        <caption>{{ ariaLabel() }}</caption>
        <thead>
          <tr><th scope="col">Issue</th><th scope="col">Estimate</th><th scope="col">Detail</th></tr>
        </thead>
        <tbody>
          @for (p of points(); track p.id) {
            <tr><th scope="row">{{ p.key }} {{ p.title }}</th><td>{{ columns()[p.col]?.label }}</td><td>{{ p.detail }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ScatterChart {
  readonly points = input.required<readonly ScatterPoint[]>();
  readonly columns = input.required<readonly ScatterColumn[]>();
  readonly height = input(260);
  readonly ariaLabel = input('Actual time against estimate');
  readonly pointClick = output<string>();

  protected readonly surface = SURFACE;
  protected readonly mt = 10;
  protected readonly mr = 12;
  protected readonly mb = 34;
  protected readonly groups = [
    { key: 'typical', label: 'Typical', color: 'var(--chart-1)' },
    { key: 'slow', label: 'More than 2× its median', color: 'var(--chart-5)' },
  ] as const;
  protected readonly hidden = signal<ReadonlySet<string>>(new Set());
  protected readonly hover = signal<{ id: string; key: string; title: string; detail: string; x: number; y: number } | null>(null);
  private readonly measure = trackWidth();
  protected readonly width = this.measure.width;

  protected readonly scale = computed(() => logScale(this.points().map((p) => p.y)));
  protected readonly ml = computed(() => 40);
  protected readonly innerW = computed(() => Math.max(10, this.width() - this.ml() - this.mr));
  protected readonly innerH = computed(() => this.height() - this.mt - this.mb);
  private readonly band = computed(() => this.innerW() / Math.max(1, this.columns().length));

  protected cx(i: number): number {
    return this.ml() + this.band() * (i + 0.5);
  }
  protected py(v: number): number {
    return this.mt + this.innerH() * (1 - this.scale().frac(v));
  }

  protected readonly dots = computed(() => {
    const hid = this.hidden();
    const half = Math.min(this.band() * 0.34, 34);
    return this.points()
      .filter((p) => !hid.has(p.flagged ? 'slow' : 'typical'))
      .map((p) => ({
        id: p.id,
        key: p.key,
        title: p.title,
        detail: p.detail,
        color: p.flagged ? 'var(--chart-5)' : 'var(--chart-1)',
        x: this.cx(p.col) + jitter(p.id) * half,
        y: this.py(p.y),
      }));
  });

  protected readonly medians = computed(() =>
    this.columns().flatMap((c, i) => (c.median === undefined ? [] : [{ i, x: this.cx(i), y: this.py(c.median), w: Math.min(this.band() * 0.4, 24) }])),
  );
  protected readonly medianLine = computed(() => {
    const m = this.medians();
    return m.length > 1 ? m.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('') : '';
  });

  protected toggle(key: string): void {
    const next = new Set(this.hidden());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.hidden.set(next);
  }

  protected onMove(event: PointerEvent): void {
    const svg = (event.currentTarget as SVGGraphicsElement).ownerSVGElement;
    if (!svg) return;
    const box = svg.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    let best: ReturnType<ScatterChart['dots']>[number] | null = null;
    let bestD = 14 * 14;
    for (const d of this.dots()) {
      const dist = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (dist <= bestD) {
        best = d;
        bestD = dist;
      }
    }
    this.hover.set(best ? { id: best.id, key: best.key, title: best.title, detail: best.detail, x: best.x, y: best.y } : null);
  }

  protected onClick(): void {
    const h = this.hover();
    if (h) this.pointClick.emit(h.id);
  }
}

/** Stable pseudo-random in [-1, 1] from an id. */
function jitter(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 0) % 2001) - 1000) / 1000;
}
