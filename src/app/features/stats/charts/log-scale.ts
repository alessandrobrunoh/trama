// Log-ish vertical scale for durations in days (1 hour … a year). Cycle times span orders of
// magnitude, so a linear axis would squash every quick issue onto the baseline.

export interface LogTick {
  value: number;
  label: string;
}

export interface LogScale {
  min: number;
  max: number;
  ticks: LogTick[];
  /** 0 at `min`, 1 at `max`. Values below `min` are clamped. */
  frac(value: number): number;
}

const HOUR = 1 / 24;
const STEPS = [HOUR, 0.25, 0.5, 1, 2, 3, 5, 7, 14, 30, 60, 90, 180, 365, 730];

/** 5h / 3.5d / 12d — same wording as the KPI tiles. */
export function dayLabel(days: number): string {
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 10) return `${+days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

export function logScale(values: readonly number[]): LogScale {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0);
  const lo = clean.length ? Math.min(...clean) : 1;
  const hi = clean.length ? Math.max(...clean) : 7;
  let a = 0;
  while (a < STEPS.length - 2 && STEPS[a + 1] <= lo) a += 1;
  let b = STEPS.length - 1;
  while (b > a + 1 && STEPS[b - 1] >= hi) b -= 1;
  let picked = STEPS.slice(a, b + 1);
  // keep the axis readable: at most 7 labels
  while (picked.length > 7) picked = picked.filter((_, i) => i % 2 === 0 || i === picked.length - 1);
  const min = picked[0];
  const max = picked[picked.length - 1];
  const span = Math.log(max) - Math.log(min) || 1;
  return {
    min,
    max,
    ticks: picked.map((value) => ({ value, label: dayLabel(value) })),
    frac: (v) => (Math.log(Math.min(max, Math.max(min, v))) - Math.log(min)) / span,
  };
}
