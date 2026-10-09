import type { WorkstreamStatus } from '../contracts/domain.js';
import type { IWorkstream, WorkstreamFacts } from './insights-signals.js';

/** `workstream.status_changed` events grouped by workstream and target status. */
export interface StatusEventRow {
  id: string;
  to: string;
  firstAt: Date;
  lastAt: Date;
}

export interface ActivityRow {
  id: string;
  lastAt: Date;
}

/** Statuses that mean the work has not started (or never will). */
const NOT_STARTED: readonly string[] = ['draft', 'planned', 'canceled'];

/**
 * Per-workstream facts from the event log:
 * - `enteredStatusAt`: the last time it entered its current status;
 * - `startedAt`: the first move to any status other than Draft, Planned or Canceled;
 * - `lastActivityAt`: the last event by a person or an agent.
 * Anything missing stays `undefined`: callers fall back to entity timestamps.
 */
export function buildFacts(
  workstreams: readonly Pick<IWorkstream, 'id' | 'status'>[],
  statusEvents: readonly StatusEventRow[],
  activity: readonly ActivityRow[],
): Map<string, WorkstreamFacts> {
  const facts = new Map<string, WorkstreamFacts>(workstreams.map((w) => [w.id, {}]));
  const status = new Map<string, WorkstreamStatus>(workstreams.map((w) => [w.id, w.status]));
  for (const e of statusEvents) {
    const f = facts.get(e.id);
    if (!f) continue;
    if (e.to === status.get(e.id) && (!f.enteredStatusAt || e.lastAt > f.enteredStatusAt)) f.enteredStatusAt = e.lastAt;
    if (!NOT_STARTED.includes(e.to) && (!f.startedAt || e.firstAt < f.startedAt)) f.startedAt = e.firstAt;
  }
  for (const a of activity) {
    const f = facts.get(a.id);
    if (f && (!f.lastActivityAt || a.lastAt > f.lastActivityAt)) f.lastActivityAt = a.lastAt;
  }
  return facts;
}
