// Estimates, cycle time and delivery speed, computed only from what issues really carry:
// `estimate`, `startedAt`, `completedAt`, `createdAt`. Nothing is imputed; every function reports how
// many issues it had to leave out.
//
// Definitions (kept in one place, repeated in the UI copy):
//  - cycle time   = startedAt → completedAt, in days, for issues with status Done (canceled are ignored)
//  - waiting time = createdAt → startedAt;  lead time = waiting + cycle
//  - bucket       = the issues sharing one estimate value
//  - reference    = per-bucket distribution over ALL completed issues in the filtered set, so "typical for a 5"
//                   does not shift with the selected period. Needs REF_MIN issues, otherwise the bucket is "not enough data".
//  - slow         = cycle time > 2× the bucket median (no estimate: slowest decile of all cycle times)
//  - accuracy     = share of estimated, completed issues whose cycle time is within 0.5×–2× of their bucket median
//  - dragging     = still open and already running longer than the bucket p75
import { format } from 'date-fns';
import { formatEstimate, type EstimateScale, type IssueKind, type Priority } from '../../core';
import type { BarRow } from './charts/bar-list';
import type { BoxStat } from './charts/box-plot';
import type { ChartSeries } from './charts/chart-utils';
import type { ScatterColumn, ScatterPoint } from './charts/scatter-chart';
import { absDelta, formatDuration, pctDelta, type Kpi, type Period } from './insights';
import type { MilestoneRec, WorkData, WorkRec } from './work';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const REF_MIN = 3;
export const SLOW_FACTOR = 2;

export interface WorkFilter {
  /** Resolved user id; null = everyone. */
  person: string | null;
  team: string | null;
}

export interface Lookup {
  user(id: string | undefined): string;
  team(id: string | undefined): string;
}

// ───────────────────────────── basics ─────────────────────────────

export function filterWork(recs: readonly WorkRec[], f: WorkFilter): WorkRec[] {
  return recs.filter((r) => (!f.person || r.assigneeId === f.person) && (!f.team || r.teamId === f.team));
}

export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Dist {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
}

export function dist(values: readonly number[]): Dist | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, min: s[0], p25: quantile(s, 0.25), median: quantile(s, 0.5), p75: quantile(s, 0.75), max: s[s.length - 1] };
}

const median = (values: readonly number[]): number | undefined => dist(values)?.median;

export const isDone = (r: WorkRec): boolean => r.status === 'done' && r.completed !== undefined;
export const isRunning = (r: WorkRec): boolean => r.status === 'in_progress' || r.status === 'in_review';

/** Days from start to completion; undefined when either end is missing or they are out of order. */
export function cycleDays(r: WorkRec): number | undefined {
  if (r.started === undefined || r.completed === undefined || r.completed < r.started) return undefined;
  return (r.completed - r.started) / DAY;
}

export interface Range {
  from: number;
  to: number;
}

export function periodRanges(period: Period, now: number, recs: readonly WorkRec[]): { cur: Range; prev?: Range } {
  const to = now + 1;
  if (period === 'all') {
    const first = recs.length ? Math.min(...recs.map((r) => r.created)) : now - WEEK;
    return { cur: { from: Math.min(first, now - WEEK), to } };
  }
  const len = ({ '7d': 7, '30d': 30, '90d': 90 } as const)[period] * DAY;
  return { cur: { from: to - len, to }, prev: { from: to - 2 * len, to: to - len } };
}

const within = (t: number | undefined, r: Range): boolean => t !== undefined && t >= r.from && t < r.to;

// ───────────────────────────── reference ─────────────────────────────

export interface Reference {
  buckets: Map<number, Dist>;
  /** Every completed cycle time, for issues without an estimate. */
  overall?: Dist;
  decile?: number;
}

export function buildReference(recs: readonly WorkRec[]): Reference {
  const byEst = new Map<number, number[]>();
  const all: number[] = [];
  for (const r of recs) {
    if (!isDone(r)) continue;
    const c = cycleDays(r);
    if (c === undefined) continue;
    all.push(c);
    if (r.estimate !== undefined) byEst.set(r.estimate, [...(byEst.get(r.estimate) ?? []), c]);
  }
  const buckets = new Map<number, Dist>();
  for (const [e, v] of byEst) {
    const d = dist(v);
    if (d) buckets.set(e, d);
  }
  const sorted = [...all].sort((a, b) => a - b);
  return { buckets, overall: dist(all), decile: sorted.length >= 10 ? quantile(sorted, 0.9) : undefined };
}

const usable = (d: Dist | undefined): Dist | undefined => (d && d.n >= REF_MIN ? d : undefined);

// ───────────────────────────── weeks ─────────────────────────────

export interface WeekAxis {
  starts: number[];
  ends: number[];
  labels: string[];
  titles: string[];
}

export function weeksFor(period: Period, recs: readonly WorkRec[], now: number): number {
  if (period === '7d') return 4;
  if (period === '30d') return 5;
  if (period === '90d') return 13;
  const first = recs.length ? Math.min(...recs.map((r) => r.created)) : now;
  return Math.min(52, Math.max(4, Math.ceil((now - first) / WEEK)));
}

/** Trailing 7-day buckets ending now, so the newest bar is never a half-empty calendar week. */
export function weekAxis(now: number, count: number): WeekAxis {
  const top = now + 1;
  const starts = Array.from({ length: count }, (_, i) => top - (count - i) * WEEK);
  const ends = starts.map((s) => s + WEEK);
  return {
    starts,
    ends,
    labels: starts.map((s) => format(s, 'MMM d')),
    titles: starts.map((s, i) => `${format(s, 'MMM d')} – ${format(ends[i] - 1, 'MMM d')}`),
  };
}

const bucketOf = (t: number, ax: WeekAxis): number => {
  const i = Math.floor((t - ax.starts[0]) / WEEK);
  return i >= 0 && i < ax.starts.length ? i : -1;
};

// ───────────────────────────── estimates & time ─────────────────────────────

export interface SlowRow {
  id: string;
  key: string;
  title: string;
  estimate?: number;
  estimateLabel: string;
  actual: number;
  expected: number;
  ratio: number;
  basis: 'estimate' | 'decile';
  assignee: string;
  completed: number;
}

export interface DragRow {
  id: string;
  key: string;
  title: string;
  estimate?: number;
  estimateLabel: string;
  age: number;
  p75: number;
  median: number;
  ratio: number;
  assignee: string;
}

export interface Exclusions {
  /** Done in the period. */
  done: number;
  noStart: number;
  noEstimate: number;
  /** Cycle time exists but a bucket has fewer than REF_MIN issues in history. */
  thinBuckets: number;
}

export interface EstimateInsights {
  kpis: Kpi[];
  scatter: { points: ScatterPoint[]; columns: ScatterColumn[] };
  box: { boxes: BoxStat[]; overlaps: string[]; rho?: number; rhoN: number };
  slow: SlowRow[];
  dragging: DragRow[];
  draggingSkipped: number;
  unestimated: { share?: number; missing: number; total: number; byTeam: BarRow[]; byPerson: BarRow[]; nudge?: string };
  velocity: {
    labels: string[];
    titles: string[];
    points: number[];
    count: number[];
    avgPoints: (number | null)[];
    avgCount: (number | null)[];
    notes: string[];
    unestimated: number;
  };
  lead: {
    labels: string[];
    titles: string[];
    wait: (number | null)[];
    work: (number | null)[];
    notes: string[];
    medWait?: number;
    medWork?: number;
    medLead?: number;
    n: number;
  };
  excluded: Exclusions;
}

export function estimateInsights(
  recs: readonly WorkRec[],
  period: Period,
  now: number,
  scale: EstimateScale,
  look: Lookup,
): EstimateInsights {
  const ref = buildReference(recs);
  const { cur, prev } = periodRanges(period, now, recs);
  const done = recs.filter(isDone);
  const doneCur = done.filter((r) => within(r.completed, cur));
  const label = (e: number | undefined): string => (e === undefined ? 'None' : formatEstimate(e, scale) || String(e));
  const against = period === 'all' ? '' : `vs previous ${period.replace('d', ' days')}`;

  // ── exclusions
  const withCycle = doneCur.filter((r) => cycleDays(r) !== undefined);
  const scattered = withCycle.filter((r) => r.estimate !== undefined);
  const excluded: Exclusions = {
    done: doneCur.length,
    noStart: doneCur.length - withCycle.length,
    noEstimate: withCycle.length - scattered.length,
    thinBuckets: scattered.filter((r) => !usable(ref.buckets.get(r.estimate!))).length,
  };

  // ── scatter + box (period)
  const estimates = [...new Set(scattered.map((r) => r.estimate!))].sort((a, b) => a - b);
  const colOf = new Map(estimates.map((e, i) => [e, i] as const));
  const points: ScatterPoint[] = scattered.map((r) => {
    const y = cycleDays(r)!;
    const bucket = usable(ref.buckets.get(r.estimate!));
    const ratio = bucket ? y / bucket.median : undefined;
    return {
      id: r.id,
      key: r.key,
      title: r.title,
      col: colOf.get(r.estimate!)!,
      y,
      flagged: ratio !== undefined && ratio > SLOW_FACTOR,
      detail: `${label(r.estimate)} pts · ${formatDuration(y)}${ratio !== undefined ? ` · ${ratio.toFixed(1)}× typical` : ''}`,
    };
  });
  const perCol = estimates.map((e) => scattered.filter((r) => r.estimate === e).map((r) => cycleDays(r)!));
  const columns: ScatterColumn[] = estimates.map((e, i) => ({
    label: label(e),
    n: perCol[i].length,
    median: perCol[i].length >= 2 ? median(perCol[i]) : undefined,
  }));

  const boxes: BoxStat[] = estimates.map((e, i) => {
    const d = dist(perCol[i])!;
    return { label: label(e), n: d.n, min: d.min, p25: d.p25, median: d.median, p75: d.p75, max: d.max, values: perCol[i], overlaps: false };
  });
  const overlaps: string[] = [];
  for (let i = 1; i < boxes.length; i++) {
    const a = boxes[i - 1];
    const b = boxes[i];
    if (a.n < REF_MIN || b.n < REF_MIN) continue;
    const lo = Math.max(a.p25, b.p25);
    const hi = Math.min(a.p75, b.p75);
    const smaller = Math.min(a.p75 - a.p25, b.p75 - b.p25);
    const share = hi > lo ? (smaller > 0 ? (hi - lo) / smaller : 1) : 0;
    const inverted = b.median <= a.median;
    if (share >= 0.5 || inverted) {
      a.overlaps = true;
      b.overlaps = true;
      overlaps.push(
        inverted && share < 0.5
          ? `${a.label} and ${b.label}: the bigger estimate was not slower (median ${formatDuration(b.median)} vs ${formatDuration(a.median)})`
          : `${a.label} and ${b.label}: middle halves overlap ${Math.round(Math.min(1, share) * 100)}%`,
      );
    }
  }
  const rhoN = scattered.length;
  const rho = rhoN >= 6 && estimates.length >= 2 ? spearman(scattered.map((r) => r.estimate!), scattered.map((r) => cycleDays(r)!)) : undefined;

  // ── slow list
  const slow: SlowRow[] = [];
  for (const r of withCycle) {
    const actual = cycleDays(r)!;
    if (r.estimate !== undefined) {
      const b = usable(ref.buckets.get(r.estimate));
      if (b && b.median > 0 && actual > SLOW_FACTOR * b.median)
        slow.push(slowRow(r, actual, b.median, 'estimate', label(r.estimate), look));
    } else if (ref.decile !== undefined && ref.overall && actual >= ref.decile && ref.overall.median > 0) {
      slow.push(slowRow(r, actual, ref.overall.median, 'decile', label(undefined), look));
    }
  }
  slow.sort((a, b) => b.ratio - a.ratio);

  // ── dragging
  const { rows: dragging, skipped: draggingSkipped } = draggingRows(recs, ref, now, scale, look);

  // ── unestimated
  const missingRecs = doneCur.filter((r) => r.estimate === undefined);
  const share = doneCur.length ? missingRecs.length / doneCur.length : undefined;
  const group = (idOf: (r: WorkRec) => string | undefined, name: (id: string | undefined) => string): BarRow[] => {
    const map = new Map<string, { total: number; missing: number }>();
    for (const r of doneCur) {
      const k = idOf(r) ?? '';
      const g = map.get(k) ?? { total: 0, missing: 0 };
      g.total += 1;
      if (r.estimate === undefined) g.missing += 1;
      map.set(k, g);
    }
    return [...map.entries()]
      .map(([k, g]) => ({ k, ...g, pct: Math.round((g.missing / g.total) * 100) }))
      .sort((a, b) => b.pct - a.pct || b.total - a.total)
      .slice(0, 8)
      .map((g) => ({
        key: g.k || 'none',
        label: name(g.k || undefined),
        hint: `${g.missing}/${g.total}`,
        value: g.pct,
        valueLabel: `${g.pct}%`,
        detail: `${name(g.k || undefined)}: ${g.missing} of ${g.total} completed issues had no estimate`,
        color: g.pct >= 50 ? 'var(--chart-3)' : 'var(--chart-1)',
      }));
  };
  const worstPerson = group((r) => r.assigneeId, (id) => look.user(id))[0];
  const nudge =
    share !== undefined && share >= 0.25
      ? `${missingRecs.length} of ${doneCur.length} completed issues had no estimate, so they cannot be checked for accuracy.${
          worstPerson && worstPerson.value >= 50 ? ` Most gaps: ${worstPerson.label} (${worstPerson.valueLabel}).` : ''
        } Estimate issues before moving them to In progress.`
      : undefined;

  // ── weekly series
  const weeks = weeksFor(period, recs, now);
  const ext = weekAxis(now, weeks + 3);
  const extPoints = ext.starts.map(() => 0);
  const extCount = ext.starts.map(() => 0);
  const extWait: number[][] = ext.starts.map(() => []);
  const extWork: number[][] = ext.starts.map(() => []);
  let unestimatedInWeeks = 0;
  for (const r of done) {
    const i = bucketOf(r.completed!, ext);
    if (i < 0) continue;
    extCount[i] += 1;
    if (r.estimate === undefined) unestimatedInWeeks += i >= 3 ? 1 : 0;
    else extPoints[i] += r.estimate;
    const c = cycleDays(r);
    if (c !== undefined && r.started! >= r.created) {
      extWait[i].push((r.started! - r.created) / DAY);
      extWork[i].push(c);
    }
  }
  const avg = (series: readonly number[], i: number): number | null => {
    if (i < 3) return null;
    return (series[i] + series[i - 1] + series[i - 2] + series[i - 3]) / 4;
  };
  const sl = (arr: readonly number[]): number[] => arr.slice(3);
  const axis: WeekAxis = {
    starts: ext.starts.slice(3),
    ends: ext.ends.slice(3),
    labels: ext.labels.slice(3),
    titles: ext.titles.slice(3),
  };
  const idx = axis.starts.map((_, k) => k + 3);
  const velocity = {
    labels: axis.labels,
    titles: axis.titles,
    points: sl(extPoints),
    count: sl(extCount),
    avgPoints: idx.map((i) => avg(extPoints, i)),
    avgCount: idx.map((i) => avg(extCount, i)),
    notes: idx.map((i) => `${extCount[i]} issue${extCount[i] === 1 ? '' : 's'} completed`),
    unestimated: unestimatedInWeeks,
  };
  const lead = {
    labels: axis.labels,
    titles: axis.titles,
    wait: idx.map((i) => median(extWait[i]) ?? null),
    work: idx.map((i) => median(extWork[i]) ?? null),
    notes: idx.map((i) => (extWork[i].length ? `${extWork[i].length} issue${extWork[i].length === 1 ? '' : 's'} with start and finish dates` : 'no completed issues with both dates')),
    medWait: undefined as number | undefined,
    medWork: undefined as number | undefined,
    medLead: undefined as number | undefined,
    n: 0,
  };
  const leadPairs = doneCur.filter((r) => cycleDays(r) !== undefined && r.started! >= r.created);
  lead.medWait = median(leadPairs.map((r) => (r.started! - r.created) / DAY));
  lead.medWork = median(leadPairs.map((r) => cycleDays(r)!));
  lead.medLead = median(leadPairs.map((r) => (r.completed! - r.created) / DAY));
  lead.n = leadPairs.length;

  // ── KPIs
  const weeksIn = (r: Range): number => Math.max(1, (r.to - r.from) / WEEK);
  const pointsIn = (r: Range): number => done.filter((x) => within(x.completed, r)).reduce((n, x) => n + (x.estimate ?? 0), 0);
  const cycleMed = (r: Range): number | undefined => median(done.filter((x) => within(x.completed, r)).flatMap((x) => cycleDays(x) ?? []));
  const accuracy = (r: Range): { pct: number; n: number } | undefined => {
    let n = 0;
    let ok = 0;
    for (const x of done.filter((d) => within(d.completed, r))) {
      const c = cycleDays(x);
      const b = x.estimate === undefined ? undefined : usable(ref.buckets.get(x.estimate));
      if (c === undefined || !b || b.median <= 0) continue;
      n += 1;
      if (c >= b.median / SLOW_FACTOR && c <= b.median * SLOW_FACTOR) ok += 1;
    }
    return n >= REF_MIN ? { pct: Math.round((ok / n) * 100), n } : undefined;
  };
  const wipAt = (t: number): number =>
    recs.filter((r) => (t >= now ? isRunning(r) : r.started !== undefined && r.started <= t && (r.completed === undefined || r.completed > t))).length;

  const cycNow = cycleMed(cur);
  const cycPrev = prev ? cycleMed(prev) : undefined;
  const ptsNow = pointsIn(cur) / weeksIn(cur);
  const ptsPrev = prev ? pointsIn(prev) / weeksIn(prev) : undefined;
  const accNow = accuracy(cur);
  const accPrev = prev ? accuracy(prev) : undefined;
  const wipNow = wipAt(now);
  const wipStart = period === 'all' ? undefined : wipAt(cur.from);
  const wipSpark = Array.from({ length: 8 }, (_, k) => wipAt(k === 7 ? now : cur.from + ((cur.to - cur.from) * k) / 7));
  const spark = (vals: (number | null)[]): number[] => vals.filter((v): v is number => v !== null);
  const share100 = share === undefined ? undefined : Math.round(share * 100);

  const kpis: Kpi[] = [
    {
      label: 'Median cycle time',
      value: cycNow === undefined ? '—' : formatDuration(cycNow),
      delta: cycNow !== undefined && cycPrev !== undefined ? pctDelta(cycNow, cycPrev, 'down', against) : undefined,
      hint: cycNow === undefined ? 'no completed issues with a start date' : `${withCycle.length} issue${withCycle.length === 1 ? '' : 's'}, started to done`,
      spark: spark(lead.work),
      sparkColor: 'var(--chart-1)',
    },
    {
      label: 'Estimate accuracy',
      value: accNow ? `${accNow.pct}%` : '—',
      delta: accNow && accPrev ? absDelta(accNow.pct - accPrev.pct, 'up', `${against}: ${accPrev.pct}%`) : undefined,
      hint: accNow ? `${accNow.n} issues within ½×–2× of typical` : 'needs estimated issues with 3+ finished per size',
      spark: [],
      sparkColor: 'var(--chart-2)',
    },
    {
      label: 'Throughput (pts/week)',
      value: String(+ptsNow.toFixed(1)),
      delta: ptsPrev !== undefined ? pctDelta(ptsNow, ptsPrev, 'up', against) : undefined,
      hint: `${doneCur.length} issue${doneCur.length === 1 ? '' : 's'} done${missingRecs.length ? `, ${missingRecs.length} unestimated` : ''}`,
      spark: velocity.points,
      sparkColor: 'var(--chart-2)',
    },
    {
      label: 'In progress now',
      value: String(wipNow),
      delta: wipStart !== undefined ? absDelta(wipNow - wipStart, 'down', `vs ${wipStart} at the start of the period (estimated from start and finish dates)`) : undefined,
      hint: 'work in progress',
      spark: wipSpark,
      sparkColor: 'var(--chart-1)',
    },
    {
      label: 'Without estimate',
      value: share100 === undefined ? '—' : `${share100}%`,
      hint: share100 === undefined ? 'nothing completed in range' : `${missingRecs.length} of ${doneCur.length} completed`,
      spark: [],
      sparkColor: 'var(--chart-3)',
    },
  ];

  return {
    kpis,
    scatter: { points, columns },
    box: { boxes, overlaps, rho, rhoN },
    slow,
    dragging,
    draggingSkipped,
    unestimated: {
      share,
      missing: missingRecs.length,
      total: doneCur.length,
      byTeam: group((r) => r.teamId, (id) => look.team(id)),
      byPerson: group((r) => r.assigneeId, (id) => look.user(id)),
      nudge,
    },
    velocity,
    lead,
    excluded,
  };
}

/** Running issues that already exceed the p75 of finished issues with the same estimate. */
export function draggingRows(recs: readonly WorkRec[], ref: Reference, now: number, scale: EstimateScale, look: Lookup): { rows: DragRow[]; skipped: number } {
  const rows: DragRow[] = [];
  let skipped = 0;
  for (const r of recs.filter(isRunning)) {
    const b = r.started === undefined || r.estimate === undefined ? undefined : usable(ref.buckets.get(r.estimate));
    if (!b) {
      skipped += 1;
      continue;
    }
    const age = Math.max(0, (now - r.started!) / DAY);
    if (age > b.p75 && b.p75 > 0)
      rows.push({
        id: r.id,
        key: r.key,
        title: r.title,
        estimate: r.estimate,
        estimateLabel: formatEstimate(r.estimate, scale) || String(r.estimate),
        age,
        p75: b.p75,
        median: b.median,
        ratio: age / b.median,
        assignee: look.user(r.assigneeId),
      });
  }
  return { rows: rows.sort((a, b) => b.age / b.p75 - a.age / a.p75), skipped };
}

export interface WeekSummary {
  doneThis: number;
  doneLast: number;
  pointsThis: number;
  pointsLast: number;
  medianCycle?: number;
  dragging: DragRow[];
}

/** One person's last 7 days against the 7 before, judged against the whole workspace's history. */
export function weekSummary(all: readonly WorkRec[], personId: string, now: number, scale: EstimateScale, look: Lookup): WeekSummary {
  const mine = all.filter((r) => r.assigneeId === personId);
  const ref = buildReference(all);
  const thisWeek: Range = { from: now + 1 - WEEK, to: now + 1 };
  const lastWeek: Range = { from: now + 1 - 2 * WEEK, to: now + 1 - WEEK };
  const doneIn = (r: Range): WorkRec[] => mine.filter((x) => isDone(x) && within(x.completed, r));
  const sum = (list: readonly WorkRec[]): number => list.reduce((n, x) => n + (x.estimate ?? 0), 0);
  const dThis = doneIn(thisWeek);
  const dLast = doneIn(lastWeek);
  return {
    doneThis: dThis.length,
    doneLast: dLast.length,
    pointsThis: sum(dThis),
    pointsLast: sum(dLast),
    medianCycle: median(dThis.flatMap((x) => cycleDays(x) ?? [])),
    dragging: draggingRows(mine, ref, now, scale, look).rows,
  };
}

function slowRow(r: WorkRec, actual: number, expected: number, basis: SlowRow['basis'], estimateLabel: string, look: Lookup): SlowRow {
  return {
    id: r.id,
    key: r.key,
    title: r.title,
    estimate: r.estimate,
    estimateLabel,
    actual,
    expected,
    ratio: actual / expected,
    basis,
    assignee: look.user(r.assigneeId),
    completed: r.completed!,
  };
}

/** Spearman rank correlation (average ranks for ties). */
function spearman(xs: readonly number[], ys: readonly number[]): number | undefined {
  const rank = (v: readonly number[]): number[] => {
    const order = v.map((value, i) => ({ value, i })).sort((a, b) => a.value - b.value);
    const out = new Array<number>(v.length);
    for (let a = 0; a < order.length; ) {
      let b = a;
      while (b + 1 < order.length && order[b + 1].value === order[a].value) b += 1;
      const r = (a + b) / 2 + 1;
      for (let k = a; k <= b; k++) out[order[k].i] = r;
      a = b + 1;
    }
    return out;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((s, v) => s + v, 0) / rx.length;
  const my = ry.reduce((s, v) => s + v, 0) / ry.length;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : undefined;
}

// ───────────────────────────── issues scope: aging + throughput ─────────────────────────────

export interface AgingRow {
  id: string;
  key: string;
  title: string;
  age: number;
  priority: Priority;
  status: string;
  assignee: string;
  estimateLabel: string;
}

export function agingWip(recs: readonly WorkRec[], now: number, scale: EstimateScale, look: Lookup): { rows: AgingRow[]; noStart: number } {
  const running = recs.filter(isRunning);
  const rows = running
    .filter((r) => r.started !== undefined)
    .map((r) => ({
      id: r.id,
      key: r.key,
      title: r.title,
      age: Math.max(0, (now - r.started!) / DAY),
      priority: r.priority,
      status: r.status,
      assignee: look.user(r.assigneeId),
      estimateLabel: r.estimate === undefined ? 'no estimate' : `${formatEstimate(r.estimate, scale)} pts`,
    }))
    .sort((a, b) => b.age - a.age);
  return { rows, noStart: running.length - rows.length };
}

export interface ThroughputBlock {
  labels: string[];
  titles: string[];
  series: ChartSeries[];
  total: number;
  note?: string;
}

export function throughput(
  recs: readonly WorkRec[],
  period: Period,
  now: number,
  by: 'kind' | 'team',
  groupLabel: (key: string) => string,
  palette: readonly string[],
  otherColor: string,
): ThroughputBlock {
  const ax = weekAxis(now, weeksFor(period, recs, now));
  const done = recs.filter(isDone);
  const keyOf = (r: WorkRec): string => (by === 'kind' ? (r.kind as IssueKind) : (r.teamId ?? 'none'));
  const inRange = done.filter((r) => bucketOf(r.completed!, ax) >= 0);
  const totals = new Map<string, number>();
  for (const r of inRange) totals.set(keyOf(r), (totals.get(keyOf(r)) ?? 0) + 1);
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked.slice(0, palette.length).map(([k]) => k);
  const groups = top.map((k, i) => ({ key: k, label: groupLabel(k), color: palette[i], values: ax.starts.map(() => 0) }));
  const other = { key: '__other', label: 'Other', color: otherColor, values: ax.starts.map(() => 0) };
  for (const r of inRange) {
    const i = bucketOf(r.completed!, ax);
    const g = groups.find((x) => x.key === keyOf(r)) ?? other;
    g.values[i] += 1;
  }
  const series: ChartSeries[] = [...groups, ...(ranked.length > palette.length ? [other] : [])];
  return { labels: ax.labels, titles: ax.titles, series, total: inRange.length };
}

// ───────────────────────────── workstreams: milestones ─────────────────────────────

export type MilestoneState = 'done' | 'overdue' | 'at_risk' | 'on_track' | 'no_date' | 'empty';

export interface MilestoneRow {
  id: string;
  name: string;
  workstreamId: string;
  workstreamKey: string;
  workstreamTitle: string;
  target?: number;
  total: number;
  done: number;
  pct: number;
  basis: 'points' | 'issues';
  state: MilestoneState;
  projected?: number;
  detail: string;
}

/** Completion rate of a workstream over the last 28 days (issues per day). */
export function wsRate(issues: readonly WorkRec[], now: number): number {
  const windowStart = now - 28 * DAY;
  const first = issues.length ? Math.min(...issues.map((i) => i.created)) : now;
  const days = Math.max(7, Math.min(28, (now - first) / DAY));
  const finished = issues.filter((i) => i.status === 'done' && i.completed !== undefined && i.completed >= windowStart && i.completed <= now + 1).length;
  return finished / days;
}

export function milestoneRows(data: WorkData, now: number): MilestoneRow[] {
  const byId = new Map(data.issues.map((i) => [i.id, i] as const));
  const byWs = new Map<string, WorkRec[]>();
  for (const i of data.issues) for (const w of i.workstreamIds) byWs.set(w, [...(byWs.get(w) ?? []), i]);
  return data.milestones.map((m) => milestoneRow(m, m.issueIds.flatMap((id) => byId.get(id) ?? []), wsRate(byWs.get(m.workstreamId) ?? [], now), now));
}

function milestoneRow(m: MilestoneRec, issues: readonly WorkRec[], rate: number, now: number): MilestoneRow {
  const live = issues.filter((i) => i.status !== 'canceled');
  const done = live.filter((i) => i.status === 'done');
  const basis: MilestoneRow['basis'] = live.length > 0 && live.every((i) => (i.estimate ?? 0) > 0) ? 'points' : 'issues';
  const size = (i: WorkRec): number => (basis === 'points' ? i.estimate! : 1);
  const total = live.reduce((n, i) => n + size(i), 0);
  const doneSize = done.reduce((n, i) => n + size(i), 0);
  const pct = total ? Math.round((doneSize / total) * 100) : 0;
  const remaining = live.length - done.length;
  const projected = remaining > 0 && rate > 0 ? now + (remaining / rate) * DAY : undefined;
  const base = { id: m.id, name: m.name, workstreamId: m.workstreamId, workstreamKey: m.workstreamKey, workstreamTitle: m.workstreamTitle, target: m.target, total, done: doneSize, pct, basis, projected };
  if (!live.length) return { ...base, state: 'empty', detail: 'No issues in this milestone yet.' };
  if (remaining === 0) return { ...base, state: 'done', detail: 'All issues are done.' };
  const rateText = rate > 0 ? `${+(rate * 7).toFixed(1)} issues/week lately` : 'nothing completed in the workstream recently';
  if (m.target !== undefined && now > m.target) return { ...base, state: 'overdue', detail: `Target date passed with ${remaining} issue${remaining === 1 ? '' : 's'} open.` };
  if (m.target === undefined)
    return { ...base, state: 'no_date', detail: projected ? `At ${rateText}, ${remaining} open issue${remaining === 1 ? '' : 's'} take until ${format(projected, 'MMM d')}.` : `No target date; ${rateText}.` };
  if (projected === undefined) return { ...base, state: 'at_risk', detail: `${remaining} open and ${rateText}.` };
  if (projected > m.target) return { ...base, state: 'at_risk', detail: `At ${rateText}, projected ${format(projected, 'MMM d')}, after the ${format(m.target, 'MMM d')} target.` };
  return { ...base, state: 'on_track', detail: `At ${rateText}, projected ${format(projected, 'MMM d')}, before the ${format(m.target, 'MMM d')} target.` };
}
