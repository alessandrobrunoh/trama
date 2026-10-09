import type { DurationStats, HistogramBucket, InsightActor } from '../contracts/domain.js';

export const DAY = 86_400_000;

/** One decimal, never `-0`. */
export function round1(n: number): number {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? 0 : r;
}

export function daysBetween(from: Date | number, to: Date | number): number {
  return ((typeof to === 'number' ? to : to.getTime()) - (typeof from === 'number' ? from : from.getTime())) / DAY;
}

/**
 * Nearest-rank percentile: the smallest observed value with at least `p` percent of the samples at
 * or below it. Always an observed value (no interpolation), and the single sample for n = 1.
 */
export function percentile(sorted: readonly number[], p: number): number | undefined {
  if (!sorted.length) return undefined;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

export function durationStats(values: readonly number[]): DurationStats {
  const sorted = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50: round1(percentile(sorted, 50)!),
    p85: round1(percentile(sorted, 85)!),
    p95: round1(percentile(sorted, 95)!),
    mean: round1(sum / sorted.length),
    max: round1(sorted[sorted.length - 1]),
  };
}

/** Day edges of the duration histogram: <1d, 1-3d, 3-7d, 1-2w, 2-4w, 4w+. */
export const HISTOGRAM_EDGES = [1, 3, 7, 14, 28] as const;
const HISTOGRAM_LABELS = ['< 1d', '1–3d', '3–7d', '1–2w', '2–4w', '4w+'];

export function histogram(values: readonly number[]): HistogramBucket[] {
  const buckets: HistogramBucket[] = HISTOGRAM_LABELS.map((label, i) => ({
    label,
    from: i === 0 ? 0 : HISTOGRAM_EDGES[i - 1],
    ...(i < HISTOGRAM_EDGES.length ? { to: HISTOGRAM_EDGES[i] } : {}),
    count: 0,
  }));
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) continue;
    const i = HISTOGRAM_EDGES.findIndex((e) => v < e);
    buckets[i === -1 ? HISTOGRAM_EDGES.length : i].count += 1;
  }
  return buckets;
}

export const UNASSIGNED: InsightActor = { type: 'unassigned', name: 'Nobody assigned' };

export type NameIndex = ReadonlyMap<string, { name: string; type: 'user' | 'agent' }>;

/** Resolves a user or agent id to an actor; unknown ids keep the id as the name. */
export function actorOf(id: string | null | undefined, names: NameIndex): InsightActor {
  if (!id) return UNASSIGNED;
  const hit = names.get(id);
  return hit ? { type: hit.type, id, name: hit.name } : { type: 'user', id, name: id };
}

export function short(s: string, n = 140): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3d", "5h", "<1h": for sentences in item details. */
export function span(days: number): string {
  if (days < 1 / 24) return '<1h';
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 10) return `${round1(days)}d`;
  return `${Math.round(days)}d`;
}
