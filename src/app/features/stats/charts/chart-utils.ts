import { DestroyRef, ElementRef, afterNextRender, inject, signal, type Signal } from '@angular/core';

/** One drawn series. `color` is any CSS color, in practice a design token: `var(--chart-1)`. */
export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  /** One value per x position. `null` leaves a gap (no data, which is different from zero). */
  values: readonly (number | null)[];
}

/** A slice of a part-to-whole chart. */
export interface ChartSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/** Surface the marks sit on; used for the 2px gaps and rings that separate touching marks. */
export const SURFACE = 'var(--background)';

/** Token cycle for plain categorical series. Fixed order, never cycled past five. */
export const SERIES_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'] as const;

export interface YScale {
  max: number;
  ticks: number[];
}

/** Round a maximum up to a clean axis: 0 / 5 / 10 … Never returns a max of 0. */
export function niceScale(rawMax: number, opts: { integer?: boolean; target?: number } = {}): YScale {
  const target = opts.target ?? 4;
  const top = Math.max(rawMax, opts.integer ? 1 : 0.0001);
  const rough = top / target;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  let step = mult * pow;
  if (opts.integer) step = Math.max(1, Math.ceil(step));
  const count = Math.ceil(top / step - 1e-9);
  const ticks = Array.from({ length: count + 1 }, (_, i) => +(i * step).toFixed(6));
  return { max: ticks[ticks.length - 1], ticks };
}

/** 1,284 / 12.9K — used on axes and tooltips. */
export function compact(value: number, digits = 1): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${+(value / 1_000_000).toFixed(digits)}M`;
  if (abs >= 10_000) return `${+(value / 1_000).toFixed(digits)}K`;
  return value.toLocaleString('en-US', { maximumFractionDigits: Number.isInteger(value) ? 0 : digits });
}

/** Path for a bar with a 4px rounded data-end and a square baseline. */
export function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0 || w <= 0) return '';
  const rad = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rad}Q${x},${y} ${x + rad},${y}H${x + w - rad}Q${x + w},${y} ${x + w},${y + rad}V${y + h}Z`;
}

/** Track an element's width (ResizeObserver). Chart geometry is derived from it, not from CSS scaling. */
export function trackWidth(initial = 560): { host: ElementRef<HTMLElement>; width: Signal<number> } {
  const host = inject<ElementRef<HTMLElement>>(ElementRef);
  const destroyRef = inject(DestroyRef);
  const width = signal(initial);
  afterNextRender(() => {
    const el = host.nativeElement;
    width.set(Math.max(120, Math.round(el.getBoundingClientRect().width) || initial));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) width.set(Math.max(120, w));
    });
    ro.observe(el);
    destroyRef.onDestroy(() => ro.disconnect());
  });
  return { host, width: width.asReadonly() };
}
