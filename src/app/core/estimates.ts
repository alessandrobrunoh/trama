// Issue estimates (story points). The stored value is always a number (`Issue.estimate`);
// the scale only decides which values are offered and how they are labelled.
// `EstimateScale` (and the workspace setting `estimateScale`) live in contracts/domain.ts; pass the
// workspace's scale into the helpers below (default: fibonacci). The 'none' scale offers no options.

import type { EstimateScale } from './contracts/domain';

export interface EstimateOption {
  /** Stored points. */
  value: number;
  /** Shown to people: "5", "M". */
  label: string;
}

export interface EstimateScaleDef {
  label: string;
  /** Short name used in tooltips: "Fibonacci scale". */
  name: string;
  /** One-line description for a settings picker. */
  description: string;
  options: readonly EstimateOption[];
}

const numbers = (values: readonly number[]): EstimateOption[] => values.map((value) => ({ value, label: String(value) }));

export const ESTIMATE_SCALE_DEFS: Record<EstimateScale, EstimateScaleDef> = {
  none: {
    label: 'Not used',
    name: 'No',
    description: 'Estimates are turned off. Existing values are kept.',
    options: [],
  },
  linear: {
    label: 'Linear',
    name: 'Linear',
    description: 'Evenly spaced from 1 to 10. Easy to reason about and precise for small work.',
    options: numbers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  },
  fibonacci: {
    label: 'Fibonacci',
    name: 'Fibonacci',
    description: 'Gaps widen as work grows, so big estimates stay honest. Includes 0.',
    options: numbers([0, 1, 2, 3, 5, 8, 13, 21]),
  },
  exponential: {
    label: 'Exponential',
    name: 'Exponential',
    description: 'Doubles every step. Forces a clear call between small and big.',
    options: numbers([1, 2, 4, 8, 16, 32]),
  },
  tshirt: {
    label: 'T-shirt',
    name: 'T-shirt',
    description: 'Relative sizes instead of numbers. Stored as 1, 2, 3, 5 and 8 points.',
    options: [
      { value: 1, label: 'XS' },
      { value: 2, label: 'S' },
      { value: 3, label: 'M' },
      { value: 5, label: 'L' },
      { value: 8, label: 'XL' },
    ],
  },
};

/** Scales in the order a settings picker lists them. */
export const ESTIMATE_SCALE_ORDER: readonly EstimateScale[] = ['none', 'linear', 'fibonacci', 'exponential', 'tshirt'];

export const DEFAULT_ESTIMATE_SCALE: EstimateScale = 'fibonacci';

/** The values a person can pick on a scale, ascending. */
export function estimateOptions(scale: EstimateScale = DEFAULT_ESTIMATE_SCALE): readonly EstimateOption[] {
  return (ESTIMATE_SCALE_DEFS[scale] ?? ESTIMATE_SCALE_DEFS[DEFAULT_ESTIMATE_SCALE]).options;
}

/**
 * "5" / "M". A value that is not on the scale (e.g. set through the API, or the workspace
 * switched scales) is shown as a plain number so nothing is lost.
 */
export function formatEstimate(n: number | null | undefined, scale: EstimateScale = DEFAULT_ESTIMATE_SCALE): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const hit = estimateOptions(scale).find((o) => o.value === n);
  return hit ? hit.label : String(Math.round(n * 100) / 100);
}

const num = (n: number): string => String(Math.round(n * 100) / 100);

/** "1 point" / "3 points". */
export function formatPoints(n: number): string {
  return `${num(n)} ${n === 1 ? 'point' : 'points'}`;
}

/** "3 points" on number scales, "M · 3 points" on the t-shirt scale. Used in pickers and the detail property. */
export function formatEstimateLong(n: number | null | undefined, scale: EstimateScale = DEFAULT_ESTIMATE_SCALE): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  const short = formatEstimate(n, scale);
  return short !== num(n) ? `${short} · ${formatPoints(n)}` : formatPoints(n);
}

/** Tooltip: "3 points · Fibonacci scale" ("M · 3 points · T-shirt scale"). */
export function estimateTooltip(n: number | null | undefined, scale: EstimateScale = DEFAULT_ESTIMATE_SCALE): string {
  const long = formatEstimateLong(n, scale);
  if (!long) return '';
  if (scale === 'none') return long;
  const onScale = estimateOptions(scale).some((o) => o.value === n);
  return `${long} · ${onScale ? `${ESTIMATE_SCALE_DEFS[scale].name} scale` : 'outside the current scale'}`;
}

/**
 * Where a value sits on its scale, 0..1 (0 = zero points, 1 = the top of the scale). Positive options
 * are ranked evenly, so "M" on a t-shirt scale is 0.6 and "5" on Fibonacci 0.67. A value that is not on
 * the scale is placed proportionally to the largest option.
 */
export function estimateFraction(n: number | null | undefined, scale: EstimateScale = DEFAULT_ESTIMATE_SCALE): number {
  if (n === null || n === undefined || !Number.isFinite(n) || n <= 0) return 0;
  const steps = estimateOptions(scale).map((o) => o.value).filter((v) => v > 0);
  if (!steps.length) return Math.min(1, n / 13);
  const at = steps.indexOf(n);
  if (at >= 0) return (at + 1) / steps.length;
  return Math.max(0.1, Math.min(1, n / steps[steps.length - 1]));
}
