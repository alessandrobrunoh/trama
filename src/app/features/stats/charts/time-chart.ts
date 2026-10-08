import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ChartTip } from './chart-tip';
import { SURFACE, barPath, compact, niceScale, trackWidth, type ChartSeries } from './chart-utils';

type Mode = 'line' | 'stacked' | 'bars';

interface Seg {
  line: string;
  area: string;
}

/**
 * One chart for every "value per x" story. Pure SVG, geometry derived from the measured width.
 *  - `line`:    one 2px line per series with a faint wash and an end dot (opened vs closed)
 *  - `stacked`: stacked areas, first series at the bottom (cumulative flow)
 *  - `bars`:    columns, grouped when there are several series (histograms, per-period counts)
 * Hover shows a crosshair (or a band for bars) and one tooltip listing every series at that x.
 */
@Component({
  selector: 'app-time-chart',
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
              @if (mode() === 'line') {
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

    <div
      class="relative outline-none"
      tabindex="0"
      [attr.aria-label]="ariaLabel()"
      (keydown)="onKey($event)"
      (blur)="hover.set(null)"
    >
      <svg
        [attr.viewBox]="'0 0 ' + width() + ' ' + height()"
        [attr.width]="width()"
        [attr.height]="height()"
        class="block max-w-full overflow-visible select-none"
        role="img"
        [attr.aria-label]="ariaLabel()"
      >
        <!-- dashed gridlines + y labels -->
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
          <text
            [attr.x]="ml() - 8"
            [attr.y]="t.y"
            text-anchor="end"
            dominant-baseline="middle"
            font-size="11"
            class="tabular-nums"
            style="fill: var(--muted-foreground)"
          >
            {{ t.label }}
          </text>
        }

        <!-- x labels -->
        @for (t of xTicks(); track t.i) {
          <text
            [attr.x]="t.x"
            [attr.y]="height() - 6"
            [attr.text-anchor]="t.anchor"
            font-size="11"
            class="tabular-nums"
            style="fill: var(--muted-foreground)"
          >
            {{ t.label }}
          </text>
        }

        @if (hover() !== null && mode() === 'bars') {
          <rect
            [attr.x]="hoverBand().x"
            [attr.width]="hoverBand().w"
            [attr.y]="mt"
            [attr.height]="innerH()"
            rx="4"
            style="fill: var(--hover)"
          />
        }

        @switch (mode()) {
          @case ('line') {
            @for (l of lines(); track l.key) {
              @for (seg of l.segs; track $index) {
                <path [attr.d]="seg.area" [style.fill]="l.color" fill-opacity="0.1" stroke="none" />
                <path
                  [attr.d]="seg.line"
                  fill="none"
                  [style.stroke]="l.color"
                  stroke-width="2"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                />
              }
            }
          }
          @case ('stacked') {
            @for (l of layers(); track l.key) {
              <path
                [attr.d]="l.d"
                [style.fill]="l.color"
                fill-opacity="0.9"
                [style.stroke]="surface"
                stroke-width="1.5"
                stroke-linejoin="round"
              />
            }
          }
          @case ('bars') {
            @for (b of bars(); track b.id) {
              <path [attr.d]="b.d" [style.fill]="b.color" [attr.fill-opacity]="hover() === null || hover() === b.i ? 1 : 0.55" />
            }
          }
        }

        <!-- crosshair + point markers -->
        @if (hover() !== null && mode() !== 'bars') {
          <line
            [attr.x1]="px(hover()!)"
            [attr.x2]="px(hover()!)"
            [attr.y1]="mt"
            [attr.y2]="mt + innerH()"
            style="stroke: var(--muted-foreground)"
            stroke-opacity="0.55"
            stroke-width="1"
          />
        }
        @if (mode() === 'line') {
          @for (d of dots(); track d.key) {
            <circle [attr.cx]="d.x" [attr.cy]="d.y" r="4" [style.fill]="d.color" [style.stroke]="surface" stroke-width="2" />
          }
        }
        @if (mode() === 'stacked' && hover() !== null) {
          @for (d of stackDots(); track d.key) {
            <circle [attr.cx]="d.x" [attr.cy]="d.y" r="3.5" [style.fill]="d.color" [style.stroke]="surface" stroke-width="2" />
          }
        }

        <!-- hit area: bigger than any mark, snaps to the nearest x -->
        <rect
          [attr.x]="ml()"
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
          @if (t.total) {
            <div class="border-border mt-1.5 flex items-center justify-between gap-2 border-t pt-1.5">
              <span class="text-muted-foreground">Total</span>
              <span class="text-foreground font-medium tabular-nums">{{ t.total }}</span>
            </div>
          }
        </app-chart-tip>
      }

      <!-- table view for assistive tech: every value, no hover required -->
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
export class TimeChart {
  readonly series = input.required<readonly ChartSeries[]>();
  readonly labels = input.required<readonly string[]>();
  /** Longer x names for the tooltip; falls back to `labels`. */
  readonly titles = computed(() => this.fullTitles() ?? this.labels());
  readonly fullTitles = input<readonly string[] | undefined>(undefined, { alias: 'tooltipTitles' });
  readonly mode = input<Mode>('line');
  readonly height = input(190);
  /** Whole-number axis (counts). Turn off for durations. */
  readonly integer = input(true);
  readonly valueFormat = input<(value: number) => string>((v) => compact(v));
  readonly ariaLabel = input('Chart');

  protected readonly surface = SURFACE;
  protected readonly mt = 10;
  protected readonly mr = 12;
  protected readonly mb = 24;
  protected readonly hover = signal<number | null>(null);
  private readonly hiddenKeys = signal<ReadonlySet<string>>(new Set());
  private readonly measure = trackWidth();
  protected readonly width = this.measure.width;

  protected readonly visible = computed(() => this.series().filter((s) => !this.hiddenKeys().has(s.key)));
  private readonly n = computed(() => this.labels().length);

  private readonly scale = computed(() => {
    const vis = this.visible();
    let max = 0;
    if (this.mode() === 'stacked') {
      for (let i = 0; i < this.n(); i++) max = Math.max(max, vis.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
    } else {
      for (const s of vis) for (const v of s.values) if (v != null && v > max) max = v;
    }
    return niceScale(max, { integer: this.integer() });
  });

  protected readonly ml = computed(() => {
    const widest = Math.max(...this.scale().ticks.map((t) => this.valueFormat()(t).length), 1);
    return Math.max(26, widest * 6.6 + 14);
  });
  protected readonly innerW = computed(() => Math.max(10, this.width() - this.ml() - this.mr));
  protected readonly innerH = computed(() => this.height() - this.mt - this.mb);
  private readonly band = computed(() => this.innerW() / Math.max(1, this.n()));

  protected px(i: number): number {
    const n = this.n();
    if (this.mode() === 'bars') return this.ml() + this.band() * (i + 0.5);
    return n <= 1 ? this.ml() + this.innerW() / 2 : this.ml() + (i / (n - 1)) * this.innerW();
  }
  private py(v: number): number {
    return this.mt + this.innerH() - (v / this.scale().max) * this.innerH();
  }

  protected readonly grid = computed(() =>
    this.scale().ticks.map((value) => ({ value, y: this.py(value), label: this.valueFormat()(value) })),
  );

  protected readonly xTicks = computed(() => {
    const labels = this.labels();
    const n = labels.length;
    const maxLabelLen = Math.max(...labels.map((l) => l.length), 1);
    const slot = maxLabelLen * 6.4 + 16;
    const per = Math.max(1, Math.ceil(slot / (this.innerW() / Math.max(1, this.mode() === 'bars' ? n : n - 1))));
    const out: { i: number; x: number; label: string; anchor: string }[] = [];
    for (let i = 0; i < n; i += per) {
      let anchor = 'middle';
      const x = this.px(i);
      if (this.mode() !== 'bars') {
        if (i === 0 && n > 1) anchor = 'start';
      }
      out.push({ i, x, label: labels[i], anchor });
    }
    return out;
  });

  protected readonly lines = computed(() =>
    this.visible().map((s) => {
      const segs: Seg[] = [];
      let cur: [number, number][] = [];
      const flush = () => {
        if (!cur.length) return;
        const base = this.py(0);
        const line = cur.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
        const first = cur[0];
        const last = cur[cur.length - 1];
        segs.push({ line: cur.length === 1 ? `${line}h0.01` : line, area: `${line}L${last[0].toFixed(1)},${base}L${first[0].toFixed(1)},${base}Z` });
        cur = [];
      };
      s.values.forEach((v, i) => {
        if (v == null) flush();
        else cur.push([this.px(i), this.py(v)]);
      });
      flush();
      return { key: s.key, color: s.color, segs };
    }),
  );

  /** Last real value per line, with a surface ring; follows the pointer while hovering. */
  protected readonly dots = computed(() => {
    const h = this.hover();
    return this.visible().flatMap((s) => {
      let i = h;
      if (i === null) {
        i = -1;
        s.values.forEach((v, k) => {
          if (v != null) i = k;
        });
      }
      const v = i >= 0 ? s.values[i] : null;
      return v == null || i === null ? [] : [{ key: s.key, color: s.color, x: this.px(i), y: this.py(v) }];
    });
  });

  private readonly stacks = computed(() => {
    const vis = this.visible();
    const n = this.n();
    const base = new Array<number>(n).fill(0);
    return vis.map((s) => {
      const lower = [...base];
      const upper = s.values.map((v, i) => (base[i] += v ?? 0));
      return { s, lower, upper: [...upper] };
    });
  });

  protected readonly layers = computed(() =>
    this.stacks().map(({ s, lower, upper }) => {
      const top = upper.map((v, i) => `${i ? 'L' : 'M'}${this.px(i).toFixed(1)},${this.py(v).toFixed(1)}`).join('');
      const bottom = lower
        .map((v, i) => `L${this.px(i).toFixed(1)},${this.py(v).toFixed(1)}`)
        .reverse()
        .join('');
      return { key: s.key, color: s.color, d: `${top}${bottom}Z` };
    }),
  );

  protected readonly stackDots = computed(() => {
    const h = this.hover();
    if (h === null) return [];
    return this.stacks()
      .filter(({ s }) => (s.values[h] ?? 0) > 0)
      .map(({ s, upper }) => ({ key: s.key, color: s.color, x: this.px(h), y: this.py(upper[h]) }));
  });

  protected readonly bars = computed(() => {
    const vis = this.visible();
    const k = Math.max(1, vis.length);
    const gap = 2;
    const barW = Math.max(2, Math.min(24, (this.band() * 0.72 - gap * (k - 1)) / k));
    const groupW = barW * k + gap * (k - 1);
    const out: { id: string; i: number; d: string; color: string }[] = [];
    for (let i = 0; i < this.n(); i++) {
      const x0 = this.px(i) - groupW / 2;
      vis.forEach((s, j) => {
        const v = s.values[i];
        if (!v) return;
        const y = this.py(v);
        out.push({ id: `${s.key}:${i}`, i, color: s.color, d: barPath(x0 + j * (barW + gap), y, barW, this.py(0) - y) });
      });
    }
    return out;
  });

  protected readonly hoverBand = computed(() => {
    const i = this.hover() ?? 0;
    return { x: this.ml() + this.band() * i + 1, w: Math.max(1, this.band() - 2) };
  });

  protected readonly tip = computed(() => {
    const i = this.hover();
    if (i === null || i >= this.n()) return null;
    const fmt = this.valueFormat();
    const vis = this.visible();
    const stacked = this.mode() === 'stacked';
    const rows = vis.map((s) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      value: s.values[i] == null ? 'no data' : fmt(s.values[i]!),
    }));
    if (stacked) rows.reverse();
    const total = stacked ? fmt(vis.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)) : '';
    return { x: this.px(i), title: this.titles()[i] ?? this.labels()[i], rows, total };
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
    if (!svg) return;
    const x = event.clientX - svg.getBoundingClientRect().left - this.ml();
    const n = this.n();
    if (!n) return;
    const raw = this.mode() === 'bars' ? Math.floor(x / this.band()) : n <= 1 ? 0 : Math.round((x / this.innerW()) * (n - 1));
    this.hover.set(Math.min(n - 1, Math.max(0, raw)));
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
