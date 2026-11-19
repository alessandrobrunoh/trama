// "What does this task really cost?": the time tracked with the timer on the task, set against the median
// tracked time of finished tasks with the same estimate. Wall-clock time spent in a status is never used.
// Pure, so it is cheap to reason about and test.
import type { Issue } from '../../core';
import { REF_MIN, typicalTracked } from '../stats/flow-stats';

export type CostVerdict = 'faster' | 'on_track' | 'longer';

export interface IssueCost {
  state: 'not_started' | 'running' | 'done' | 'canceled';
  /** Finished tracked time on this task; undefined when nothing was tracked. */
  trackedMs?: number;
  /** The task is still open, so the tracked time can still grow. */
  open: boolean;
  /** Present when the task has an estimate. */
  compare?: {
    estimate: number;
    /** Finished tasks at this estimate with tracked time (not counting this one). */
    n: number;
    /** Median tracked time of those; undefined below REF_MIN. */
    typicalMs?: number;
    ratio?: number;
    verdict?: CostVerdict;
  };
}

export function verdictFor(ratio: number, finished: boolean): CostVerdict {
  if (ratio > 1.25) return 'longer';
  if (finished && ratio <= 0.75) return 'faster';
  return 'on_track';
}

export function issueCost(
  issue: Issue,
  all: readonly Issue[],
  tracked: ReadonlyMap<string, number>,
): IssueCost {
  const closed = issue.status === 'done' || issue.status === 'canceled';
  const state: IssueCost['state'] =
    issue.status === 'done'
      ? 'done'
      : issue.status === 'canceled'
        ? 'canceled'
        : issue.startedAt
          ? 'running'
          : 'not_started';
  const trackedMs = tracked.get(issue.id);
  const cost: IssueCost = { state, trackedMs, open: !closed };

  if (issue.estimate !== undefined && issue.estimate !== null) {
    const { n, medianMs } = typicalTracked(all, tracked, issue.estimate, issue.id);
    let ratio: number | undefined;
    let verdict: CostVerdict | undefined;
    // canceled work says nothing about the estimate
    if (medianMs && medianMs > 0 && trackedMs !== undefined && state !== 'canceled') {
      ratio = trackedMs / medianMs;
      verdict = verdictFor(ratio, state === 'done');
    }
    cost.compare = { estimate: issue.estimate, n, typicalMs: medianMs, ratio, verdict };
  }
  return cost;
}

export { REF_MIN };
