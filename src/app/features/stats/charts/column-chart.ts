import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ChartTip } from './chart-tip';
import { SURFACE, barPath, compact, niceScale, trackWidth, type ChartSeries } from './chart-utils';

export interface ColumnSeries extends ChartSeries {
  /** `bar` (default) draws columns; `line` overlays a 2px line (e.g. a rolling average). */
  type?: 'bar' | 'line';
}

/**
 * Columns per bucket, grouped or stacked, with optional line series laid over them (velocity + its
 * rolling average). One y axis. Stacked segments are separated by a 2px surface gap, only the top
 * segment has the rounded 4px data-end. Hover shows one tooltip with every series at that bucket;
 * legend entries toggle series; arrow keys walk the buckets.
 */
@Component({
  selector: 'app-column-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChartTip],
  host: { class: 'relative block min-w-0' },
  template: `
    @if (series().length > 1) {
      <ul class="mb-2 flex flex-wrap gap-x-1 gap-y-1" aria-label="Legend (click to show or hide a series)">
        @for (s of series(); track s.key) {
          <li>
            <button
              type="button"
              class="hover:bg-hover text-muted-foreground flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors"
              [class.opacity-45]="isHidden(s.key)"
              [attr.aria-pressed]="!isHidden(s.key)"
              (click)="toggle(s.key)"
            >
              @if (s.type === 'line') {
                <span class="h-0.5 w-3 rounded-full" [style.background]="s.color"></span>
              } @else {
                <span class="size-2 rounded-[2px]" [style.background]="s.color"></span>
              }
              <span [class.line-through]="isHidden(s.key)">{{ s.label }}</span>
            </button>
          </li>
        }
      </ul>
    }

    <div class="relative outline-none" tabindex="0" [attr.aria-label]="ariaLabel()" (keydown)="onKey($event)" (blur)="hover.set(null)">
      <svg
        [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
        [attr.width]="width()"
        [attr.height]="height()"
        class="block max-w-full overflow-visible select-none"
        role="img"
        [attr.aria-label]="ariaLabel()"
      >
        @for (t of grid(); track t.value) {
          <line
            [attr.x1]="ml()"
            [attr.x2]="width() - mr"
            [attr.y1]="t.y"
            [attr.y2]="t.y"
            [style.stroke]="t.value === 0 ? 'var(--border-strong)' : 'var(--border)'"
            [attr.stroke-dasharray]="t.value === 0 ? null : '3 4'"
            stroke-width="1"
          />
          <text [attr.x]="ml() - 8" [attr.y]="t.y" text-anchor="end" dominant-baseline="middle" font-size="11" class="tabular-nums" style="fill: var(--muted-foreground)">{{ t.label }}</text>
        }

        @for (t of xTicks(); track t.i) {
          <text [attr.x]="t.x" [attr.y]="height() - 6" text-anchor="middle" font-size="11" class="tabular-nums" style="fill: var(--muted-foreground)">{{ t.label }}</text>
        }

        @if (hover() !== null) {
          <rect [attr.x]="ml() + band() * hover()! + 1" [attr.width]="Math.max(1, band() - 2)" [attr.y]="mt" [attr.height]="innerH()" rx="4" style="fill: var(--hover)" />
        }

        @for (b of segments(); track b.id) {
          <path [attr.d]="b.d" [style.fill]="b.color" [attr.fill-opacity]="hover() === null || hover() === b.i ? 1 : 0.55" [style.stroke]="stacked() ? surface : 'none'" stroke-width="1.5" />
        }

        @for (l of lines(); track l.key) {
          @for (d of l.paths; track $index) {
            <path [attr.d]="d" fill="none" [style.stroke]="l.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
          }
          @if (l.dot; as dot) {
            <circle [attr.cx]="dot.x" [attr.cy]="dot.y" r="4" [style.fill]="l.color" [style.stroke]="surface" stroke-width="2" />
          }
        }

        <rect [attr.x]="ml()" [attr.y]="mt" [attr.width]="innerW()" [attr.height]="innerH()" fill="transparent" (pointermove)="onMove($event)" (pointerleave)="hover.set(null)" />
      </svg>

      @if (tip(); as t) {
        <app-chart-tip [x]="t.x" [y]="mt" [bounds]="width()">
          <div class="text-muted-foreground mb-1 text-[11px] tabular-nums">{{ t.title }}</div>
          <ul class="flex flex-col gap-1">
            @for (r of t.rows; track r.key) {
              <li class="flex items-center gap-2">
                @if (r.line) {
                  <span class="h-0.5 w-2.5 shrink-0 rounded-full" [style.background]="r.color"></span>
                } @else {
                  <span class="size-2 shrink-0 rounded-[2px]" [style.background]="r.color"></span>
                }
                <span class="text-muted-foreground min-w-0 flex-1 truncate">{{ r.label }}</span>
                <span class="text-foreground font-medium tabular-nums">{{ r.value }}</span>
              </li>
            }
          </ul>
          @if (t.total) {
            <div class="border-border mt-1.5 flex items-center justify-between gap-2 border-t pt-1.5">
              <span class="text-muted-foreground">Total</span>
              <span class="text-foreground font-medium tabular-nums">{{ t.total }}</span>
            </div>
          }
          @if (t.note) {
            <div class="text-meta mt-1.5 text-[11px]">{{ t.note }}</div>
          }
        </app-chart-tip>
      }

      <table class="sr-only">
        <caption>{{ ariaLabel() }}</caption>
        <thead>
          <tr>
            <th scope="col"></th>
            @for (s of series(); track s.key) {
              <th scope="col">{{ s.label }}</th>
            }
          </tr>
        </thead>
        <tbody>
          @for (l of titles(); track $index; let row = $index) {
            <tr>
              <th scope="row">{{ l }}</th>
              @for (s of series(); track s.key) {
                <td>{{ s.values[row] ?? 'no data' }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ColumnChart {
  readonly series = input.required<readonly ColumnSeries[]>();
  readonly labels = input.required<readonly string[]>();
  readonly fullTitles = input<readonly string[] | undefined>(undefined, { alias: 'tooltipTitles' });
  /** Extra line per bucket in the tooltip ("5 issues"). */
  readonly notes = input<readonly string[] | undefined>(undefined);
  readonly stacked = input(false);
  readonly height = input(190);
  /** Whole-number axis (counts). Turn off for durations. */
  readonly integer = input(true);
  readonly valueFormat = input<(value: number) => string>((v) => compact(v));
  readonly ariaLabel = input('Chart');

  protected readonly Math = Math;
  protected readonly titles = computed(() => this.fullTitles() ?? this.labels());
  protected readonly surface = SURFACE;
  protected readonly mt = 10;
  protected readonly mr = 12;
  protected readonly mb = 24;
  protected readonly hover = signal<number | null>(null);
  private readonly hiddenKeys = signal<ReadonlySet<string>>(new Set());
  private readonly measure = trackWidth();
  protected readonly width = this.measure.width;

  protected readonly visible = computed(() => this.series().filter((s) => !this.hiddenKeys().has(s.key)));
  private readonly bars = computed(() => this.visible().filter((s) => s.type !== 'line'));
  private readonly n = computed(() => this.labels().length);

  private readonly scale = computed(() => {
    let max = 0;
    const bars = this.bars();
    for (let i = 0; i < this.n(); i++) {
      if (this.stacked()) max = Math.max(max, bars.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
      else for (const s of bars) max = Math.max(max, s.values[i] ?? 0);
    }
    for (const s of this.visible()) if (s.type === 'line') for (const v of s.values) if (v != null && v > max) max = v;
    return niceScale(max, { integer: this.integer() });
  });

  protected readonly ml = computed(() => {
    const widest = Math.max(...this.scale().ticks.map((t) => this.valueFormat()(t).length), 1);
    return Math.max(26, widest * 6.6 + 14);
  });
  protected readonly innerW = computed(() => Math.max(10, this.width() - this.ml() - this.mr));
  protected readonly innerH = computed(() => this.height() - this.mt - this.mb);
  protected readonly band = computed(() => this.innerW() / Math.max(1, this.n()));

  private px(i: number): number {
    return this.ml() + this.band() * (i + 0.5);
  }
  private py(v: number): number {
    return this.mt + this.innerH() - (v / this.scale().max) * this.innerH();
  }

  protected readonly grid = computed(() => this.scale().ticks.map((value) => ({ value, y: this.py(value), label: this.valueFormat()(value) })));

  protected readonly xTicks = computed(() => {
    const labels = this.labels();
    const slot = Math.max(...labels.map((l) => l.length), 1) * 6.4 + 16;
    const per = Math.max(1, Math.ceil(slot / this.band()));
    const out: { i: number; x: number; label: string }[] = [];
    for (let i = labels.length - 1; i >= 0; i -= per) out.push({ i, x: this.px(i), label: labels[i] });
    return out.reverse();
  });

  protected readonly segments = computed(() => {
    const bars = this.bars();
    const stacked = this.stacked();
    const k = Math.max(1, stacked ? 1 : bars.length);
    const gap = 2;
    const barW = Math.max(3, Math.min(30, (this.band() * 0.7 - gap * (k - 1)) / k));
    const groupW = barW * k + gap * (k - 1);
    const out: { id: string; i: number; d: string; color: string }[] = [];
    for (let i = 0; i < this.n(); i++) {
      const x0 = this.px(i) - groupW / 2;
      let base = 0;
      const lastIdx = bars.reduce((acc, s, j) => ((s.values[i] ?? 0) > 0 ? j : acc), -1);
      bars.forEach((s, j) => {
        const v = s.values[i];
        if (!v) return;
        if (stacked) {
          const top = base + v;
          const y = this.py(top);
          out.push({ id: `${s.key}:${i}`, i, color: s.color, d: barPath(x0, y, barW, this.py(base) - y, j === lastIdx ? 4 : 0) });
          base = top;
        } else {
          const y = this.py(v);
          out.push({ id: `${s.key}:${i}`, i, color: s.color, d: barPath(x0 + j * (barW + gap), y, barW, this.py(0) - y) });
        }
      });
    }
    return out;
  });

  protected readonly lines = computed(() =>
    this.visible()
      .filter((s) => s.type === 'line')
      .map((s) => {
        const paths: string[] = [];
        let cur = '';
        let lastIdx = -1;
        s.values.forEach((v, i) => {
          if (v == null) {
            if (cur) paths.push(cur);
            cur = '';
            return;
          }
          const x = this.px(i);
          const y = this.py(v);
          cur += `${cur ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
          lastIdx = i;
        });
        if (cur) paths.push(cur);
        const h = this.hover();
        const hv = h === null ? null : s.values[h];
        const di = h !== null && hv != null ? h : lastIdx;
        const dv = di >= 0 ? s.values[di] : null;
        const dot = dv == null ? null : { x: this.px(di), y: this.py(dv) };
        return { key: s.key, color: s.color, paths, dot };
      }),
  );

  protected readonly tip = computed(() => {
    const i = this.hover();
    if (i === null || i >= this.n()) return null;
    const fmt = this.valueFormat();
    const vis = this.visible();
    const rows = vis.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      line: s.type === 'line',
      value: s.values[i] == null ? 'no data' : fmt(s.values[i]!),
    }));
    if (this.stacked()) rows.reverse();
    const bars = this.bars();
    const total = this.stacked() && bars.length > 1 ? fmt(bars.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)) : '';
    return { x: this.px(i), title: this.titles()[i] ?? this.labels()[i], rows, total, note: this.notes()?.[i] };
  });

  protected isHidden(key: string): boolean {
    return this.hiddenKeys().has(key);
  }

  protected toggle(key: string): void {
    const next = new Set(this.hiddenKeys());
    if (next.has(key)) next.delete(key);
    else if (this.visible().length > 1) next.add(key);
    this.hiddenKeys.set(next);
  }

  protected onMove(event: PointerEvent): void {
    const svg = (event.currentTarget as SVGGraphicsElement).ownerSVGElement;
    if (!svg || !this.n()) return;
    const x = event.clientX - svg.getBoundingClientRect().left - this.ml();
    this.hover.set(Math.min(this.n() - 1, Math.max(0, Math.floor(x / this.band()))));
  }

  protected onKey(event: KeyboardEvent): void {
    const n = this.n();
    if (!n) return;
    const cur = this.hover();
    if (event.key === 'ArrowRight') this.hover.set(cur === null ? n - 1 : Math.min(n - 1, cur + 1));
    else if (event.key === 'ArrowLeft') this.hover.set(cur === null ? n - 1 : Math.max(0, cur - 1));
    else if (event.key === 'Home') this.hover.set(0);
    else if (event.key === 'End') this.hover.set(n - 1);
    else if (event.key === 'Escape') this.hover.set(null);
    else return;
    event.preventDefault();
  }
}
