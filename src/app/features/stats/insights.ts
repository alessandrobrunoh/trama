// Period-aware charts and KPIs computed from a {@link Timeline}.
// Issue throughput and cycle time, computed from the event history.
// Anything that depends on status history is only produced where the loaded events cover it.
import { addDays, format, startOfDay } from 'date-fns';
import {
  ISSUE_KIND_META,
  ISSUE_STATUS_META,
  type IssueStatus,
} from '../../core';
import type { BarRow } from './charts/bar-list';
import type { ChartSeries } from './charts/chart-utils';
import type { KpiDelta } from './charts/kpi-tile';
import { ISSUE_COLOR } from './stats-colors';
import type { Change, Timeline } from './timeline';

const DAY = 86_400_000;

export type Period = '7d' | '30d' | '90d' | 'all';
export const PERIODS: readonly { id: Period; label: string; long: string; prev: string }[] = [
  { id: '7d', label: '7d', long: 'Last 7 days', prev: 'previous 7 days' },
  { id: '30d', label: '30d', long: 'Last 30 days', prev: 'previous 30 days' },
  { id: '90d', label: '90d', long: 'Last 90 days', prev: 'previous 90 days' },
  { id: 'all', label: 'All', long: 'All time', prev: '' },
];

export interface Kpi {
  label: string;
  value: string;
  delta?: KpiDelta;
  hint?: string;
  spark: number[];
  sparkColor: string;
}

export interface SeriesBlock {
  labels: string[];
  titles: string[];
  series: ChartSeries[];
  /** Honest caveat shown under the chart (partial history, etc.). */
  note?: string;
}

export interface IssueInsights {
  kpis: Kpi[];
  flow: SeriesBlock;
  /** Cumulative flow by status. Absent when the loaded history doesn't reach back far enough. */
  stock?: SeriesBlock;
  stockUnavailable?: string;
  age: SeriesBlock;
  openedByKind: BarRow[];
  openedByTeam: BarRow[];
  openByAssignee: BarRow[];
}

// ───────────────────────────── axis ─────────────────────────────

interface Axis {
  n: number;
  step: number;
  from: number;
  to: number;
  starts: number[];
  ends: number[];
  /** Where stock-type series are sampled: end of each bucket, never past now. */
  sample: number[];
  labels: string[];
  titles: string[];
}

function buildAxis(period: Period, tl: Timeline): Axis {
  const endDay = addDays(startOfDay(new Date(tl.now)), 1);
  let step = 1;
  let n = 7;
  if (period === '30d') n = 30;
  else if (period === '90d') {
    step = 7;
    n = 13;
  } else if (period === 'all') {
    const created = tl.issues.map((i) => i.created);
    const earliest = created.length ? Math.min(...created) : tl.now - 28 * DAY;
    const span = Math.max(2, Math.ceil((endDay.getTime() - earliest) / DAY));
    step = span <= 31 ? 1 : span <= 400 ? 7 : 30;
    n = Math.max(2, Math.ceil(span / step));
    if (n > 60) {
      step = Math.ceil(span / 60);
      n = Math.ceil(span / step);
    }
  }
  const starts = Array.from({ length: n }, (_, i) => addDays(endDay, -(n - i) * step).getTime());
  const ends = Array.from({ length: n }, (_, i) => addDays(endDay, -(n - i - 1) * step).getTime());
  return {
    n,
    step,
    from: starts[0],
    to: ends[n - 1],
    starts,
    ends,
    sample: ends.map((e) => Math.min(e - 1, tl.now)),
    labels: starts.map((s) => format(s, step >= 28 ? "MMM ''yy" : 'MMM d')),
    titles: starts.map((s, i) => (step === 1 ? format(s, 'EEE, MMM d') : `${format(s, 'MMM d')} – ${format(ends[i] - 1, 'MMM d')}`)),
  };
}

// ───────────────────────────── helpers ─────────────────────────────

const inRange = (t: number, from: number, to: number): boolean => t >= from && t < to;
const countIn = (times: readonly number[], from: number, to: number): number => times.filter((t) => inRange(t, from, to)).length;
const perBucket = (times: readonly number[], ax: Axis): number[] => ax.starts.map((s, i) => countIn(times, s, ax.ends[i]));

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

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

function statusAt(rec: { created: number; status: string; changes: readonly Change[] }, t: number): string | undefined {
  if (rec.created > t) return undefined;
  const idx = rec.changes.findIndex((c) => c.at > t);
  if (idx === -1) return rec.status;
  return rec.changes[idx].from ?? rec.changes[idx - 1]?.to ?? rec.status;
}

/** Top rows by count plus "Other"; one hue, because the label already names the category. */
function tally(labels: readonly string[], hints: Map<string, string> = new Map(), limit = 7): BarRow[] {
  const counts = new Map<string, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const total = labels.length;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = sorted.slice(0, limit).map(([label, value]) => ({ label, value, hint: hints.get(label) }));
  const rest = sorted.slice(limit).reduce((n, [, v]) => n + v, 0);
  if (rest) top.push({ label: 'Other', value: rest, hint: undefined });
  return top.map((r) => ({ ...r, key: r.label, detail: `${r.label}: ${r.value} (${total ? Math.round((r.value / total) * 100) : 0}%)` }));
}

/** Count records per status at each sample time, for the first `limit` buckets that history covers. */
function stackFrom(
  recs: readonly { created: number; status: string; changes: readonly Change[] }[],
  ax: Axis,
  cov: number,
  groups: readonly { key: string; label: string; color: string }[],
): { block?: SeriesBlock; unavailable?: string } {
  const valid = ax.sample.map((t, i) => (t >= cov ? i : -1)).filter((i) => i >= 0);
  if (valid.length < 2) {
    return {
      unavailable: Number.isFinite(cov)
        ? `Status history is only loaded from ${format(cov, 'MMM d')}; there is not enough of it to draw this range.`
        : 'No activity is loaded to rebuild status history from.',
    };
  }
  const counts = new Map(groups.map((g) => [g.key, valid.map(() => 0)] as const));
  valid.forEach((bucket, col) => {
    for (const rec of recs) {
      const st = statusAt(rec, ax.sample[bucket]);
      const row = st ? counts.get(st) : undefined;
      if (row) row[col] += 1;
    }
  });
  const series = groups
    .map((g) => ({ key: g.key, label: g.label, color: g.color, values: counts.get(g.key) ?? [] }))
    .filter((s) => s.values.some((v) => v > 0));
  if (!series.length) return { unavailable: 'Nothing to chart in this range.' };
  return {
    block: {
      labels: valid.map((i) => ax.labels[i]),
      titles: valid.map((i) => ax.titles[i]),
      series,
      note: valid.length < ax.n ? `Status history is available from ${format(cov, 'MMM d')}; earlier buckets are left out.` : undefined,
    },
  };
}

// ───────────────────────────── issues: demand ─────────────────────────────

const OPEN_ISSUE = (s: string): boolean => s !== 'done' && s !== 'canceled';

export function issueInsights(tl: Timeline, period: Period): IssueInsights {
  const ax = buildAxis(period, tl);
  const meta = PERIODS.find((p) => p.id === period)!;
  const hasPrev = period !== 'all';
  const len = ax.to - ax.from;
  const prevFrom = ax.from - len;
  const cov = tl.coverageStart;
  const covCur = ax.from >= cov;
  const covPrev = prevFrom >= cov;
  const against = `vs ${meta.prev}`;

  const created = tl.issues.map((i) => i.created);
  const closings = tl.issues.flatMap((i) => i.changes.filter((c) => c.to === 'done').map((c) => ({ at: c.at, created: i.created })));
  const closeTimes = closings.map((c) => c.at);

  // opened — exact
  const opened = countIn(created, ax.from, ax.to);
  const openedPrev = hasPrev ? countIn(created, prevFrom, ax.from) : undefined;
  const openedSeries = perBucket(created, ax);

  // closed — from loaded status changes only
  const closedStart = Math.max(ax.from, cov);
  const hasHistory = cov !== Infinity;
  const closed = hasHistory ? countIn(closeTimes, closedStart, ax.to) : 0;
  const closedSeries = ax.starts.map((s, i) => (s >= cov ? countIn(closeTimes, s, ax.ends[i]) : null));
  const closedPartial = !covCur;

  // backlog stock
  const openNow = tl.issues.filter((i) => OPEN_ISSUE(i.status));
  const openAt = (t: number): number => tl.issues.filter((i) => { const s = statusAt(i, t); return s !== undefined && OPEN_ISSUE(s); }).length;
  const openSpark = ax.sample.filter((t) => t >= cov).map(openAt);
  const ages = openNow.map((i) => (tl.now - i.created) / DAY);
  const medAge = median(ages);

  // time to close
  const ttc = (from: number, to: number): number | undefined =>
    median(closings.filter((c) => inRange(c.at, Math.max(from, cov), to)).map((c) => (c.at - c.created) / DAY));
  const ttcCur = hasHistory ? ttc(ax.from, ax.to) : undefined;
  const ttcPrev = hasPrev && covCur && covPrev ? ttc(prevFrom, ax.from) : undefined;

  const kpis: Kpi[] = [
    {
      label: 'Opened',
      value: String(opened),
      delta: hasPrev ? pctDelta(opened, openedPrev, null, against) : undefined,
      hint: meta.long.toLowerCase(),
      spark: openedSeries,
      sparkColor: 'var(--chart-1)',
    },
    {
      label: 'Closed',
      value: hasHistory ? String(closed) : '—',
      delta:
        hasPrev && covCur && covPrev && hasHistory
          ? pctDelta(closed, countIn(closeTimes, prevFrom, ax.from), 'up', against)
          : undefined,
      hint: closedPartial && Number.isFinite(cov) ? `since ${format(cov, 'MMM d')} (history loaded)` : meta.long.toLowerCase(),
      spark: closedSeries.filter((v): v is number => v !== null),
      sparkColor: 'var(--chart-2)',
    },
    {
      label: 'Open backlog',
      value: String(openNow.length),
      delta: hasPrev && covCur ? absDelta(openNow.length - openAt(ax.from), 'down', `vs ${openAt(ax.from)} at the start of the period`) : undefined,
      hint: medAge === undefined ? undefined : `median age ${formatDuration(medAge)}`,
      spark: openSpark,
      sparkColor: 'var(--chart-1)',
    },
    {
      label: 'Median time to close',
      value: ttcCur === undefined ? '—' : formatDuration(ttcCur),
      delta: ttcCur !== undefined && ttcPrev !== undefined ? pctDelta(ttcCur, ttcPrev, 'down', against) : undefined,
      hint: ttcCur === undefined ? 'no closed issues in range' : 'created to done',
      spark: [],
      sparkColor: 'var(--chart-2)',
    },
  ];

  const flow: SeriesBlock = {
    labels: ax.labels,
    titles: ax.titles,
    series: [
      { key: 'opened', label: 'Opened', color: 'var(--chart-1)', values: openedSeries },
      { key: 'closed', label: 'Closed', color: 'var(--chart-2)', values: closedSeries },
    ],
    note: closedSeries.some((v) => v === null)
      ? Number.isFinite(cov)
        ? `Closed counts come from status changes in the loaded activity (from ${format(cov, 'MMM d')}); earlier buckets show no data.`
        : 'Closed counts need status changes from the activity log, and none are loaded.'
      : 'Closed counts issues moved to Done.',
  };

  const stack = stackFrom(
    tl.issues,
    ax,
    cov,
    (['done', 'in_review', 'in_progress', 'todo', 'backlog'] as IssueStatus[]).map((s) => ({ key: s, label: ISSUE_STATUS_META[s].label, color: ISSUE_COLOR[s] })),
  );

  const ageEdges = [7, 14, 30, 60, 90];
  const ageLabels = ['< 1w', '1–2w', '2–4w', '1–2mo', '2–3mo', '3mo+'];
  const ageCounts = ageLabels.map(() => 0);
  for (const a of ages) ageCounts[ageEdges.findIndex((e) => a < e) === -1 ? ageEdges.length : ageEdges.findIndex((e) => a < e)] += 1;

  const openedIssues = tl.issues.filter((i) => inRange(i.created, ax.from, ax.to));
  return {
    kpis,
    flow,
    stock: stack.block,
    stockUnavailable: stack.unavailable,
    age: {
      labels: ageLabels,
      titles: ageLabels.map((l) => `Open for ${l}`),
      series: [{ key: 'age', label: 'Open issues', color: 'var(--chart-1)', values: ageCounts }],
    },
    openedByKind: tally(openedIssues.map((i) => ISSUE_KIND_META[i.kind].label)),
    openedByTeam: tally(openedIssues.map((i) => i.team)),
    openByAssignee: tally(openNow.map((i) => i.assignee)),
  };
}
