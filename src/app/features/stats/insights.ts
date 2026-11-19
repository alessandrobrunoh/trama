// Periods and number formatting shared by the statistics page and the Inbox.
import type { KpiDelta } from './charts/kpi-tile';

export type Period = '7d' | '30d' | '90d';
export const PERIODS: readonly { id: Period; label: string; long: string; prev: string }[] = [
  { id: '7d', label: '7d', long: 'Last 7 days', prev: 'previous 7 days' },
  { id: '30d', label: '30d', long: 'Last 30 days', prev: 'previous 30 days' },
  { id: '90d', label: '90d', long: 'Last 90 days', prev: 'previous 90 days' },
];

/** 5h / 3.5d / 12d */
export function formatDuration(days: number): string {
  if (days < 1 / 24) return '<1h';
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 10) return `${+days.toFixed(1)}d`;
  return `${Math.round(days)}d`;
}

export function pctDelta(cur: number, prev: number | undefined, goodWhen: 'up' | 'down' | null, against: string): KpiDelta | undefined {
  if (prev === undefined) return undefined;
  const title = `${against}: ${+prev.toFixed(1)}`;
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9) return { text: 'no change', direction: 'flat', tone: 'neutral', title };
  const direction = diff > 0 ? 'up' : 'down';
  const tone = goodWhen === null ? 'neutral' : direction === goodWhen ? 'good' : 'bad';
  // Percentages off a tiny base (1 → 18 = "1700%") are noise: show the absolute change instead.
  const pct = prev > 0 ? Math.abs(diff / prev) * 100 : Infinity;
  const text = prev >= 5 && pct <= 300 ? `${Math.round(pct)}%` : `${diff > 0 ? '+' : '−'}${+Math.abs(diff).toFixed(1)}`;
  return { text, direction, tone, title };
}

export function absDelta(diff: number, goodWhen: 'up' | 'down' | null, title: string): KpiDelta {
  if (diff === 0) return { text: 'no change', direction: 'flat', tone: 'neutral', title };
  const direction = diff > 0 ? 'up' : 'down';
  return { text: String(Math.abs(diff)), direction, tone: goodWhen === null ? 'neutral' : direction === goodWhen ? 'good' : 'bad', title };
}
