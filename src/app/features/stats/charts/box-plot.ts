import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ChartTip } from './chart-tip';
import { SURFACE, trackWidth } from './chart-utils';
import { dayLabel, logScale } from './log-scale';

export interface BoxStat {
  label: string;
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  /** Raw values, drawn as a strip when there are too few for a box (n < 3). */
  values: readonly number[];
  /** Its box overlaps a neighbour's: the estimates don't separate these two. */
  overlaps: boolean;
}

/**
 * Box-and-whisker per estimate on a log axis of days (min – p25 – median – p75 – max). Boxes whose
 * interquartile range overlaps a neighbour are outlined with a dashed amber edge and flagged in the
 * tooltip: those estimates don't tell the sizes apart.
 */
@Component({
  selector: 'app-box-plot',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartTip],
  host: { class: 'relative block min-w-0' },
  template: `
    <ul class="mb-2 flex flex-wrap gap-x-4 gap-y-1 px-1.5 text-xs" aria-label="Legend">
      <li class="text-muted-foreground flex items-center gap-1.5">
        <span class="h-2.5 w-3.5 rounded-[2px] border" style="border-color: var(--chart-1); background: color-mix(in oklab, var(--chart-1) 22%, transparent)"></span>
        Middle half (p25–p75)
      </li>
      <li class="text-muted-foreground flex items-center gap-1.5">
        <span class="h-0.5 w-3 rounded-full" style="background: var(--foreground)"></span>
        Median
      </li>
      <li class="text-muted-foreground flex items-center gap-1.5">
        <span class="h-2.5 w-3.5 rounded-[2px] border border-dashed" style="border-color: var(--tone-amber)"></span>
        Overlaps a neighbour
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
            [attr.x1]="ml"
            [attr.x2]="width() - mr"
            [attr.y1]="py(t.value)"
            [attr.y2]="py(t.value)"
            [style.stroke]="$first ? 'var(--border-strong)' : 'var(--border)'"
            [attr.stroke-dasharray]="$first ? null : '3 4'"
            stroke-width="1"
          />
          <text [attr.x]="ml - 8" [attr.y]="py(t.value)" text-anchor="end" dominant-baseline="middle" font-size="11" class="tabular-nums" style="fill: var(--muted-foreground)">{{ t.label }}</text>
        }

        @for (b of boxes(); track $index; let i = $index) {
          @if (hover() === i) {
            <rect [attr.x]="ml + band() * i + 1" [attr.width]="band() - 2" [attr.y]="mt" [attr.height]="innerH()" rx="4" style="fill: var(--hover)" />
          }
          <text [attr.x]="cx(i)" [attr.y]="height() - 15" text-anchor="middle" font-size="11" class="tabular-nums" style="fill: var(--muted-foreground)">{{ b.label }}</text>
          <text [attr.x]="cx(i)" [attr.y]="height() - 3" text-anchor="middle" font-size="9.5" class="tabular-nums" style="fill: var(--muted-foreground)" fill-opacity="0.7">n={{ b.n }}</text>

          @if (b.n >= 3) {
            <!-- whisker -->
            <line [attr.x1]="cx(i)" [attr.x2]="cx(i)" [attr.y1]="py(b.min)" [attr.y2]="py(b.max)" style="stroke: var(--muted-foreground)" stroke-opacity="0.7" stroke-width="1.25" />
            <line [attr.x1]="cx(i) - capW()" [attr.x2]="cx(i) + capW()" [attr.y1]="py(b.min)" [attr.y2]="py(b.min)" style="stroke: var(--muted-foreground)" stroke-opacity="0.7" stroke-width="1.25" />
            <line [attr.x1]="cx(i) - capW()" [attr.x2]="cx(i) + capW()" [attr.y1]="py(b.max)" [attr.y2]="py(b.max)" style="stroke: var(--muted-foreground)" stroke-opacity="0.7" stroke-width="1.25" />
            <rect
              [attr.x]="cx(i) - boxW() / 2"
              [attr.width]="boxW()"
              [attr.y]="py(b.p75)"
              [attr.height]="Math.max(2, py(b.p25) - py(b.p75))"
              rx="3"
              style="fill: var(--chart-1)"
              [attr.fill-opacity]="hover() === null || hover() === i ? 0.28 : 0.14"
              [style.stroke]="b.overlaps ? 'var(--tone-amber)' : 'var(--chart-1)'"
              [attr.stroke-dasharray]="b.overlaps ? '4 3' : null"
              stroke-width="1.5"
            />
            <line [attr.x1]="cx(i) - boxW() / 2" [attr.x2]="cx(i) + boxW() / 2" [attr.y1]="py(b.median)" [attr.y2]="py(b.median)" style="stroke: var(--foreground)" stroke-width="2" stroke-linecap="round" />
          } @else {
            @for (v of b.values; track $index; let k = $index) {
              <circle [attr.cx]="cx(i) + (k - (b.values.length - 1) / 2) * 9" [attr.cy]="py(v)" r="4" style="fill: var(--chart-1)" [style.stroke]="surface" stroke-width="1.5" fill-opacity="0.9" />
            }
          }
        }

        <rect
          [attr.x]="ml"
          [attr.y]="mt"
          [attr.width]="innerW()"
          [attr.height]="innerH()"
          fill="transparent"
          (pointermove)="onMove($event)"
          (pointerleave)="hover.set(null)"
        />
      </svg>

      @if (tip(); as t) {
        <app-chart-tip [x]="t.x" [y]="mt" [bounds]="width()">
          <div class="text-foreground mb-1 font-medium">Estimate {{ t.b.label }} <span class="text-muted-foreground font-normal">· {{ t.b.n }} issue{{ t.b.n === 1 ? '' : 's' }}</span></div>
          @if (t.b.n >= 3) {
            <dl class="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
              <dt class="text-muted-foreground">Slowest</dt><dd class="text-end">{{ day(t.b.max) }}</dd>
              <dt class="text-muted-foreground">p75</dt><dd class="text-end">{{ day(t.b.p75) }}</dd>
              <dt class="text-muted-foreground">Median</dt><dd class="text-foreground text-end font-medium">{{ day(t.b.median) }}</dd>
              <dt class="text-muted-foreground">p25</dt><dd class="text-end">{{ day(t.b.p25) }}</dd>
              <dt class="text-muted-foreground">Fastest</dt><dd class="text-end">{{ day(t.b.min) }}</dd>
            </dl>
          } @else {
            <p class="text-muted-foreground">Too few issues for a box (needs 3). Dots show each one.</p>
          }
          @if (t.b.overlaps) {
            <p class="mt-1.5" style="color: var(--tone-amber)">Overlaps a neighbouring estimate</p>
          }
        </app-chart-tip>
      }

      <table class="sr-only">
        <caption>{{ ariaLabel() }}</caption>
        <thead>
          <tr><th scope="col">Estimate</th><th scope="col">Issues</th><th scope="col">Min</th><th scope="col">p25</th><th scope="col">Median</th><th scope="col">p75</th><th scope="col">Max</th></tr>
        </thead>
        <tbody>
          @for (b of boxes(); track $index) {
            <tr><th scope="row">{{ b.label }}</th><td>{{ b.n }}</td><td>{{ day(b.min) }}</td><td>{{ day(b.p25) }}</td><td>{{ day(b.median) }}</td><td>{{ day(b.p75) }}</td><td>{{ day(b.max) }}</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class BoxPlot {
  readonly boxes = input.required<readonly BoxStat[]>();
  readonly height = input(260);
  readonly ariaLabel = input('Cycle time by estimate');

  protected readonly Math = Math;
  protected readonly surface = SURFACE;
  protected readonly ml = 40;
  protected readonly mt = 10;
  protected readonly mr = 12;
  protected readonly mb = 34;
  protected readonly hover = signal<number | null>(null);
  private readonly measure = trackWidth();
  protected readonly width = this.measure.width;

  protected readonly scale = computed(() => logScale(this.boxes().flatMap((b) => [b.min, b.max, ...b.values])));
  protected readonly innerW = computed(() => Math.max(10, this.width() - this.ml - this.mr));
  protected readonly innerH = computed(() => this.height() - this.mt - this.mb);
  protected readonly band = computed(() => this.innerW() / Math.max(1, this.boxes().length));
  protected readonly boxW = computed(() => Math.max(10, Math.min(36, this.band() * 0.5)));
  protected readonly capW = computed(() => this.boxW() * 0.28);

  protected cx(i: number): number {
    return this.ml + this.band() * (i + 0.5);
  }
  protected py(v: number): number {
    return this.mt + this.innerH() * (1 - this.scale().frac(v));
  }
  protected day(v: number): string {
    return dayLabel(v);
  }

  protected readonly tip = computed(() => {
    const i = this.hover();
    const b = i === null ? undefined : this.boxes()[i];
    return b && i !== null ? { b, x: this.cx(i) } : null;
  });

  protected onMove(event: PointerEvent): void {
    const svg = (event.currentTarget as SVGGraphicsElement).ownerSVGElement;
    if (!svg) return;
    const x = event.clientX - svg.getBoundingClientRect().left - this.ml;
    const n = this.boxes().length;
    if (!n) return;
    this.hover.set(Math.min(n - 1, Math.max(0, Math.floor(x / this.band()))));
  }
}
