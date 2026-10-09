import type {
  AgingItem,
  CumulativeFlow,
  FlowDuration,
  InsightItem,
  InsightWipRow,
  IssueStatus,
  ThroughputBucket,
  WorkstreamStatus,
} from '../contracts/domain.js';
import type { IIssue, IWorkstream } from './insights-signals.js';
import { STALE_STATUSES } from './insights-signals.js';
import { DAY, actorOf, daysBetween, durationStats, histogram, round1, span, type NameIndex } from './insights-util.js';

export const WIP_LIMITS = { issues: 5, workstreams: 4 } as const;
/** Minimum finished issues before the p85 cycle time is used as the aging baseline. */
export const BASELINE_MIN_SAMPLES = 5;
export const BASELINE_DAYS = 90;
export const AGENT_TOUCH_DAYS = 7;
const SLOWEST = 5;
const AGING_LIMIT = 15;
const WIP_ITEM_LIMIT = 8;

const inWindow = (d: Date | null | undefined, from: number, to: number): d is Date =>
  !!d && d.getTime() >= from && d.getTime() < to;

// ───── cycle time, lead time

interface Sample {
  days: number;
  item: InsightItem;
}

function issueSamples(issues: readonly IIssue[], from: number, to: number, measure: 'cycle' | 'lead'): Sample[] {
  const out: Sample[] = [];
  for (const i of issues) {
    if (i.status !== 'done' || !inWindow(i.completedAt, from, to)) continue;
    const start = measure === 'cycle' ? i.startedAt : i.createdAt;
    // An issue moved straight to Done never started; one with a start after its end is bad data. Neither is a sample.
    if (!start || start.getTime() > i.completedAt.getTime()) continue;
    const days = round1(daysBetween(start, i.completedAt));
    out.push({
      days,
      item: {
        type: 'issue',
        id: i.id,
        key: i.key,
        title: i.title,
        since: start.toISOString(),
        ageDays: days,
        value: days,
        detail: `${measure === 'cycle' ? 'Started to done' : 'Created to done'} in ${span(days)}`,
      },
    });
  }
  return out;
}

function workstreamLeadSamples(workstreams: readonly IWorkstream[], from: number, to: number): Sample[] {
  const out: Sample[] = [];
  for (const w of workstreams) {
    if (w.status !== 'shipped' || !inWindow(w.shippedAt, from, to) || w.shippedAt.getTime() < w.createdAt.getTime()) continue;
    const days = round1(daysBetween(w.createdAt, w.shippedAt));
    out.push({
      days,
      item: {
        type: 'workstream',
        id: w.id,
        key: w.key,
        workstreamKey: w.key,
        title: w.title,
        since: w.createdAt.toISOString(),
        ageDays: days,
        value: days,
        detail: `Created to shipped in ${span(days)}`,
      },
    });
  }
  return out;
}

function toDuration(current: Sample[], previous: Sample[]): FlowDuration {
  const values = current.map((s) => s.days);
  return {
    stats: durationStats(values),
    previous: durationStats(previous.map((s) => s.days)),
    histogram: histogram(values),
    slowest: [...current].sort((a, b) => b.days - a.days).slice(0, SLOWEST).map((s) => s.item),
  };
}

export interface FlowWindow {
  from: Date;
  to: Date;
}

export function computeDurations(
  issues: readonly IIssue[],
  workstreams: readonly IWorkstream[],
  w: FlowWindow,
): { issueCycle: FlowDuration; issueLead: FlowDuration; workstreamLead: FlowDuration } {
  const from = w.from.getTime();
  const to = w.to.getTime();
  const prevFrom = from - (to - from);
  return {
    issueCycle: toDuration(issueSamples(issues, from, to, 'cycle'), issueSamples(issues, prevFrom, from, 'cycle')),
    issueLead: toDuration(issueSamples(issues, from, to, 'lead'), issueSamples(issues, prevFrom, from, 'lead')),
    workstreamLead: toDuration(workstreamLeadSamples(workstreams, from, to), workstreamLeadSamples(workstreams, prevFrom, from)),
  };
}

// ───── throughput

/** Daily buckets up to 30 days, weekly beyond; the first bucket is clipped to the range start. */
export function computeThroughput(
  issues: readonly IIssue[],
  workstreams: readonly IWorkstream[],
  w: FlowWindow,
): { buckets: ThroughputBucket[]; previous: { issuesDone: number; workstreamsShipped: number } } {
  const from = w.from.getTime();
  const to = w.to.getTime();
  const days = Math.round((to - from) / DAY);
  const step = (days > 30 ? 7 : 1) * DAY;
  const n = Math.max(1, Math.ceil((to - from) / step));
  const done = issues.filter((i) => i.status === 'done' && i.completedAt).map((i) => i.completedAt!.getTime());
  const shipped = workstreams.filter((x) => x.status === 'shipped' && x.shippedAt).map((x) => x.shippedAt!.getTime());
  const count = (times: number[], a: number, b: number) => times.filter((t) => t >= a && t < b).length;
  const buckets = Array.from({ length: n }, (_, i): ThroughputBucket => {
    const end = to - (n - i - 1) * step;
    const start = Math.max(from, end - step);
    return {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      issuesDone: count(done, start, end),
      workstreamsShipped: count(shipped, start, end),
    };
  });
  const prevFrom = from - (to - from);
  return { buckets, previous: { issuesDone: count(done, prevFrom, from), workstreamsShipped: count(shipped, prevFrom, from) } };
}

// ───── WIP per person and per agent

export interface AgentTouch {
  agentId: string;
  workstreamId: string;
}

export function computeWip(
  issues: readonly IIssue[],
  workstreams: readonly IWorkstream[],
  touches: readonly AgentTouch[],
  names: NameIndex,
  now: Date,
): { people: InsightWipRow[]; agents: InsightWipRow[]; limits: { issues: number; workstreams: number } } {
  const inFlight = (s: WorkstreamStatus) => STALE_STATUSES.includes(s);
  const people = new Map<string, { issues: IIssue[]; workstreams: IWorkstream[] }>();
  const bucket = (id: string) => people.get(id) ?? people.set(id, { issues: [], workstreams: [] }).get(id)!;
  for (const i of issues) if ((i.status === 'in_progress' || i.status === 'in_review') && i.assigneeId) bucket(i.assigneeId).issues.push(i);
  for (const w of workstreams) if (inFlight(w.status) && w.accountableUserId) bucket(w.accountableUserId).workstreams.push(w);

  const issueItem = (i: IIssue): InsightItem => {
    const days = round1(daysBetween(i.startedAt ?? i.createdAt, now));
    return { type: 'issue', id: i.id, key: i.key, title: i.title, ageDays: days, detail: `${i.status.replace(/_/g, ' ')} for ${span(days)}` };
  };
  const wsItem = (w: IWorkstream): InsightItem => ({
    type: 'workstream',
    id: w.id,
    key: w.key,
    workstreamKey: w.key,
    title: w.title,
    detail: w.status.replace(/_/g, ' '),
  });
  const row = (id: string, e: { issues: IIssue[]; workstreams: IWorkstream[] }): InsightWipRow => ({
    actor: actorOf(id, names),
    issues: e.issues.length,
    workstreams: e.workstreams.length,
    overloaded: e.issues.length > WIP_LIMITS.issues || e.workstreams.length > WIP_LIMITS.workstreams,
    items: [...e.issues.map(issueItem).sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0)), ...e.workstreams.map(wsItem)].slice(0, WIP_ITEM_LIMIT),
  });
  const order = (a: InsightWipRow, b: InsightWipRow) =>
    Number(b.overloaded) - Number(a.overloaded) || b.issues + b.workstreams - (a.issues + a.workstreams) || a.actor.name.localeCompare(b.actor.name);

  // Agents are actors, not assignees: their load is the open workstreams they touched recently.
  const wsById = new Map(workstreams.map((w) => [w.id, w]));
  const byAgent = new Map<string, Set<string>>();
  for (const t of touches) {
    const w = wsById.get(t.workstreamId);
    if (!w || !inFlight(w.status)) continue;
    (byAgent.get(t.agentId) ?? byAgent.set(t.agentId, new Set()).get(t.agentId)!).add(w.id);
  }
  const agents = [...byAgent.entries()].map(([id, set]) => row(id, { issues: [], workstreams: [...set].map((x) => wsById.get(x)!) }));

  return {
    people: [...people.entries()].map(([id, e]) => row(id, e)).sort(order),
    agents: agents.sort(order),
    limits: { ...WIP_LIMITS },
  };
}

// ───── aging WIP

export function computeAging(
  issues: readonly IIssue[],
  now: Date,
  names: NameIndex,
): { baselineDays?: number; baselineSamples: number; items: AgingItem[] } {
  const baselineFrom = now.getTime() - BASELINE_DAYS * DAY;
  const cycle = issueSamples(issues, baselineFrom, now.getTime() + 1, 'cycle');
  const baselineSamples = cycle.length;
  const baselineDays = baselineSamples >= BASELINE_MIN_SAMPLES ? durationStats(cycle.map((s) => s.days)).p85 : undefined;
  const items: AgingItem[] = [];
  for (const i of issues) {
    if (i.status !== 'in_progress' && i.status !== 'in_review') continue;
    // Legacy issues have no start time: their creation is the upper bound.
    const start = i.startedAt ?? i.createdAt;
    const days = Math.max(0, round1(daysBetween(start, now)));
    const over = baselineDays !== undefined && days > baselineDays;
    items.push({
      type: 'issue',
      id: i.id,
      key: i.key,
      title: i.title,
      since: start.toISOString(),
      ageDays: days,
      waitingOn: actorOf(i.assigneeId, names),
      status: i.status,
      inProgressDays: days,
      overBaseline: over,
      detail: over ? `In ${i.status.replace(/_/g, ' ')} for ${span(days)}, slower than 85% of recent work (${span(baselineDays!)})` : `In ${i.status.replace(/_/g, ' ')} for ${span(days)}`,
    });
  }
  items.sort((a, b) => b.inProgressDays - a.inProgressDays || (a.key ?? '').localeCompare(b.key ?? ''));
  return { ...(baselineDays !== undefined ? { baselineDays } : {}), baselineSamples, items: items.slice(0, AGING_LIMIT) };
}

// ───── cumulative flow

export interface IssueChange {
  issueId: string;
  at: Date;
  from: IssueStatus | null;
  to: IssueStatus;
}

export const CFD_STATUSES: readonly IssueStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];

/** Status of an issue at time `t`, rebuilt from its status changes. `undefined` = did not exist yet. */
export function statusAt(
  issue: Pick<IIssue, 'createdAt' | 'status'>,
  changes: readonly IssueChange[],
  t: number,
): IssueStatus | undefined {
  if (issue.createdAt.getTime() > t) return undefined;
  if (!changes.length) return issue.status;
  let last: IssueChange | undefined;
  for (const c of changes) if (c.at.getTime() <= t) last = c;
  return last ? last.to : (changes[0].from ?? issue.status);
}

/**
 * Issues per status at the end of each day. `doneBefore` counts issues finished before the loaded
 * history; they sit in Done the whole time. Drafts and canceled issues are not flow.
 */
export function computeCumulativeFlow(
  issues: readonly IIssue[],
  changes: readonly IssueChange[],
  doneBefore: number,
  w: FlowWindow,
): CumulativeFlow {
  const byIssue = new Map<string, IssueChange[]>();
  for (const c of [...changes].sort((a, b) => a.at.getTime() - b.at.getTime()))
    (byIssue.get(c.issueId) ?? byIssue.set(c.issueId, []).get(c.issueId)!).push(c);
  const n = Math.max(1, Math.round((w.to.getTime() - w.from.getTime()) / DAY));
  const ends = Array.from({ length: n }, (_, i) => {
    const end = new Date(Math.floor((w.to.getTime() - (n - i - 1) * DAY) / DAY) * DAY + DAY);
    return Math.min(end.getTime() - 1, w.to.getTime());
  });
  const series = CFD_STATUSES.map((status) => ({ status, values: ends.map(() => 0) }));
  const index = new Map(series.map((s) => [s.status, s.values]));
  ends.forEach((t, col) => {
    for (const issue of issues) {
      const s = statusAt(issue, byIssue.get(issue.id) ?? [], t);
      const row = s ? index.get(s) : undefined;
      if (row) row[col] += 1;
    }
    index.get('done')![col] += doneBefore;
  });
  return { days: ends.map((t) => new Date(t).toISOString()), series };
}
