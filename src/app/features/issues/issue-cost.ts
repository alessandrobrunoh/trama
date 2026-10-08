// "What does this issue really cost?": cycle time (startedAt → completedAt, or running so far) set against
// the median of finished issues with the same estimate. Pure, so it is cheap to reason about and test.
import type { Issue } from '../../core';
import { REF_MIN, dist } from '../stats/perf';

const DAY = 86_400_000;

export type CostVerdict = 'faster' | 'on_track' | 'longer';

export interface IssueCost {
  state: 'not_started' | 'running' | 'done' | 'canceled';
  /** Start → completion (done / canceled) or start → now (running); undefined before it starts. */
  cycleMs?: number;
  /** The cycle time is still counting. */
  running: boolean;
  /** Present when the issue has an estimate. */
  compare?: {
    estimate: number;
    /** Finished issues with this estimate (not counting this one). */
    n: number;
    /** Median cycle time of those; undefined below REF_MIN. */
    typicalMs?: number;
    ratio?: number;
    verdict?: CostVerdict;
  };
}

const ms = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};

/** Cycle times (days) of finished issues sharing `estimate`, excluding `exceptId`. */
export function finishedCycles(all: readonly Issue[], estimate: number, exceptId?: string): number[] {
  const out: number[] = [];
  for (const i of all) {
    if (i.id === exceptId || i.status !== 'done' || i.estimate !== estimate) continue;
    const a = ms(i.startedAt);
    const b = ms(i.completedAt);
    if (a !== undefined && b !== undefined && b >= a) out.push((b - a) / DAY);
  }
  return out;
}

export function verdictFor(ratio: number, finished: boolean): CostVerdict {
  if (ratio > 1.25) return 'longer';
  if (finished && ratio <= 0.75) return 'faster';
  return 'on_track';
}

export function issueCost(issue: Issue, all: readonly Issue[], now: number): IssueCost {
  const started = ms(issue.startedAt);
  const completed = ms(issue.completedAt);
  const closed = issue.status === 'done' || issue.status === 'canceled';
  const state: IssueCost['state'] = issue.status === 'done' ? 'done' : issue.status === 'canceled' ? 'canceled' : started !== undefined ? 'running' : 'not_started';

  let cycleMs: number | undefined;
  let running = false;
  if (started !== undefined) {
    if (closed && completed !== undefined) cycleMs = Math.max(0, completed - started);
    else if (!closed) {
      cycleMs = Math.max(0, now - started);
      running = true;
    }
  }

  const cost: IssueCost = { state, cycleMs, running };
  if (issue.estimate !== undefined && issue.estimate !== null) {
    const days = finishedCycles(all, issue.estimate, issue.id);
    const d = dist(days);
    const typicalMs = d && d.n >= REF_MIN ? d.median * DAY : undefined;
    let ratio: number | undefined;
    let verdict: CostVerdict | undefined;
    // canceled work says nothing about the estimate
    if (typicalMs && typicalMs > 0 && cycleMs !== undefined && state !== 'canceled') {
      ratio = cycleMs / typicalMs;
      verdict = verdictFor(ratio, state === 'done');
    }
    cost.compare = { estimate: issue.estimate, n: days.length, typicalMs, ratio, verdict };
  }
  return cost;
}
