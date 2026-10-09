import { describe, expect, it } from 'vitest';
import { INSIGHT_SIGNAL_IDS } from '../contracts/domain.js';
import { NOW, ago, decision, demand, emptyData, issue, milestone, pr, question, ws } from './insights-fixtures-spec.js';
import { buildSignals, computeBottlenecks, computeSignalItems, severityOf, type WorkstreamFacts } from './insights-signals.js';

const facts = (entries: [string, WorkstreamFacts][]) => new Map(entries);

describe('computeSignalItems on an empty workspace', () => {
  it('returns every signal, all empty, and "ok" severity', () => {
    const items = computeSignalItems(emptyData());
    expect(Object.keys(items).sort()).toEqual([...INSIGHT_SIGNAL_IDS].sort());
    const signals = buildSignals(items, 7, 25);
    expect(signals.every((s) => s.count === 0 && s.severity === 'ok' && s.items.length === 0 && !s.truncated)).toBe(true);
    expect(signals.every((s) => s.oldestDays === undefined)).toBe(true);
  });
});

describe('blocked_workstreams', () => {
  it('measures time since the workstream entered Blocked and explains why', () => {
    const w = ws({ status: 'blocked' });
    const upstream = ws({ status: 'working', key: 'WEB-9' });
    const items = computeSignalItems(
      emptyData({
        workstreams: [w, upstream],
        facts: facts([[w.id, { enteredStatusAt: ago(4) }]]),
        artifacts: [pr({ workstreamId: w.id, ci: 'failing' }), pr({ workstreamId: w.id, hasConflicts: true })],
        dependencies: [{ fromId: upstream.id, toId: w.id }],
      }),
    );
    expect(items.blocked_workstreams).toHaveLength(1);
    const [i] = items.blocked_workstreams;
    expect(i.ageDays).toBe(4);
    expect(i.detail).toContain('CI failing on 1 pull request');
    expect(i.detail).toContain('merge conflicts on 1 pull request');
    expect(i.detail).toContain('waiting on WEB-9');
    expect(i.waitingOn).toMatchObject({ id: 'u_ada' });
  });

  it('falls back to updatedAt, and says so when blocked by a pin with no reason', () => {
    const w = ws({ status: 'blocked', updatedAt: ago(2) });
    const [i] = computeSignalItems(emptyData({ workstreams: [w] })).blocked_workstreams;
    expect(i.ageDays).toBe(2);
    expect(i.detail).toContain('pinned as blocked');
  });

  it('ignores a shipped upstream dependency', () => {
    const w = ws({ status: 'blocked' });
    const up = ws({ status: 'shipped' });
    const [i] = computeSignalItems(emptyData({ workstreams: [w, up], dependencies: [{ fromId: up.id, toId: w.id }] })).blocked_workstreams;
    expect(i.detail).not.toContain('waiting on');
  });

  it('sorts the longest-blocked first and is critical after three days', () => {
    const a = ws({ status: 'blocked' });
    const b = ws({ status: 'blocked' });
    const items = computeSignalItems(emptyData({ workstreams: [a, b], facts: facts([[a.id, { enteredStatusAt: ago(1) }], [b.id, { enteredStatusAt: ago(5) }]]) }));
    expect(items.blocked_workstreams.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(buildSignals(items, 7, 25).find((s) => s.id === 'blocked_workstreams')).toMatchObject({ count: 2, oldestDays: 5, severity: 'critical' });
  });
});

describe('needs_input and the bottleneck', () => {
  it('waits on the assignee, else the accountable person, else nobody', () => {
    const w = ws({ accountableUserId: 'u_ada' });
    const orphan = ws({ accountableUserId: null });
    const items = computeSignalItems(
      emptyData({
        workstreams: [w, orphan],
        inputRequests: [
          question({ workstreamId: w.id, assigneeUserId: 'u_bob', createdAt: ago(1) }),
          question({ workstreamId: w.id, createdAt: ago(6) }),
          question({ workstreamId: orphan.id, createdAt: ago(3) }),
        ],
      }),
    );
    expect(items.needs_input.map((i) => i.waitingOn?.name)).toEqual(['Ada', 'Nobody assigned', 'Bob']);
    expect(items.needs_input[0].detail).toContain('asked by Bot (agent)');
    const rows = computeBottlenecks(items);
    expect(rows[0]).toMatchObject({ actor: { id: 'u_ada' }, inputRequests: 1, oldestDays: 6, totalWaitDays: 6 });
    expect(rows.map((r) => r.actor.type)).toEqual(['user', 'unassigned', 'user']);
  });

  it('skips questions on shipped, canceled or unknown workstreams', () => {
    const shipped = ws({ status: 'shipped' });
    const canceled = ws({ status: 'canceled' });
    const items = computeSignalItems(
      emptyData({
        workstreams: [shipped, canceled],
        inputRequests: [question({ workstreamId: shipped.id }), question({ workstreamId: canceled.id }), question({ workstreamId: 'wk_gone' })],
      }),
    );
    expect(items.needs_input).toHaveLength(0);
  });

  it('adds decisions and reviews to the same person and sums the wait', () => {
    const w = ws({ accountableUserId: 'u_ada' });
    const items = computeSignalItems(
      emptyData({
        workstreams: [w],
        inputRequests: [question({ workstreamId: w.id, createdAt: ago(2) })],
        decisions: [decision({ originWorkstreamId: w.id, createdAt: ago(10) })],
        artifacts: [pr({ workstreamId: w.id, updatedAt: ago(4) })],
      }),
    );
    expect(computeBottlenecks(items)).toEqual([
      { actor: { type: 'user', id: 'u_ada', name: 'Ada' }, inputRequests: 1, decisions: 1, reviews: 1, oldestDays: 10, totalWaitDays: 16 },
    ]);
  });

  it('counts every item in bottlenecks even when the signal list is cut', () => {
    const w = ws();
    const qs = Array.from({ length: 5 }, (_, i) => question({ workstreamId: w.id, createdAt: ago(i + 1) }));
    const items = computeSignalItems(emptyData({ workstreams: [w], inputRequests: qs }));
    const signal = buildSignals(items, 7, 2).find((s) => s.id === 'needs_input')!;
    expect(signal).toMatchObject({ count: 5, truncated: true });
    expect(signal.items).toHaveLength(2);
    expect(computeBottlenecks(items)[0].inputRequests).toBe(5);
  });
});

describe('stale work', () => {
  it('flags in-flight workstreams without activity, by last activity not by updatedAt', () => {
    const quiet = ws({ status: 'working', updatedAt: ago(0.5) });
    const busy = ws({ status: 'working' });
    const planned = ws({ status: 'planned', updatedAt: ago(60) });
    const shipped = ws({ status: 'shipped', updatedAt: ago(60) });
    const noEvents = ws({ status: 'in_review', updatedAt: ago(20) });
    const items = computeSignalItems(
      emptyData({
        workstreams: [quiet, busy, planned, shipped, noEvents],
        facts: facts([[quiet.id, { lastActivityAt: ago(9) }], [busy.id, { lastActivityAt: ago(1) }]]),
      }),
    );
    expect(items.stale_workstreams.map((i) => i.id)).toEqual([noEvents.id, quiet.id]);
    expect(items.stale_workstreams[1].ageDays).toBe(9);
  });

  it('respects the threshold exactly and the severity scales with it', () => {
    const w = ws({ status: 'working' });
    const at = (staleDays: number) => computeSignalItems(emptyData({ staleDays, workstreams: [w], facts: facts([[w.id, { lastActivityAt: ago(7) }]]) }));
    expect(at(7).stale_workstreams).toHaveLength(1);
    expect(at(8).stale_workstreams).toHaveLength(0);
    expect(buildSignals(at(7), 7, 5).find((s) => s.id === 'stale_workstreams')!.severity).toBe('warning');
    expect(buildSignals(at(2), 2, 5).find((s) => s.id === 'stale_workstreams')!.severity).toBe('critical');
  });

  it('ignores activity dated in the future', () => {
    const w = ws({ status: 'working' });
    const items = computeSignalItems(emptyData({ workstreams: [w], facts: facts([[w.id, { lastActivityAt: new Date(NOW.getTime() + 86_400_000) }]]) }));
    expect(items.stale_workstreams).toHaveLength(0);
  });

  it('flags only in-progress and in-review issues', () => {
    const items = computeSignalItems(
      emptyData({
        issues: [
          issue({ status: 'in_progress', updatedAt: ago(9) }),
          issue({ status: 'in_review', updatedAt: ago(8) }),
          issue({ status: 'todo', updatedAt: ago(30) }),
          issue({ status: 'done', updatedAt: ago(30) }),
          issue({ status: 'in_progress', updatedAt: ago(1) }),
        ],
      }),
    );
    expect(items.stale_issues.map((i) => i.ageDays)).toEqual([9, 8]);
    expect(items.stale_issues[0].waitingOn).toMatchObject({ name: 'Ada' });
  });
});

describe('delivered_outcome_open', () => {
  it('lists delivered workstreams that are not shipped and says what is still open', () => {
    const w = ws({ status: 'working', delivery: 'merged', acceptanceCriteria: [{ state: 'met' }, { state: 'pending' }] });
    const done = ws({ status: 'shipped', delivery: 'deployed' });
    const notDelivered = ws({ status: 'working', delivery: 'in_review' });
    const items = computeSignalItems(
      emptyData({
        workstreams: [w, done, notDelivered],
        artifacts: [pr({ workstreamId: w.id, state: 'merged', updatedAt: ago(6) })],
        issues: [issue({ workstreamIds: [w.id], status: 'in_progress' }), issue({ workstreamIds: [w.id], status: 'canceled' }), issue({ workstreamIds: [w.id], status: 'done' })],
        inputRequests: [question({ workstreamId: w.id })],
        decisions: [decision({ originWorkstreamId: w.id })],
      }),
    );
    expect(items.delivered_outcome_open).toHaveLength(1);
    const [i] = items.delivered_outcome_open;
    expect(i.ageDays).toBe(6);
    expect(i.detail).toContain('1 criterion not met');
    expect(i.detail).toContain('1 open issue');
    expect(i.detail).toContain('1 open question');
    expect(i.detail).toContain('1 undecided decision');
  });

  it('admits when it cannot name what is open', () => {
    const w = ws({ status: 'working', delivery: 'deployed', updatedAt: ago(3) });
    const [i] = computeSignalItems(emptyData({ workstreams: [w] })).delivered_outcome_open;
    expect(i.ageDays).toBe(3);
    expect(i.detail).toContain('outcome not confirmed');
  });
});

describe('overdue', () => {
  it('treats a date-only milestone target as the end of that day', () => {
    const today = new Date('2026-10-09T00:00:00.000Z');
    const yesterday = new Date('2026-10-08T00:00:00.000Z');
    const items = computeSignalItems(emptyData({ milestones: [milestone({ targetDate: today }), milestone({ targetDate: yesterday })] }));
    expect(items.overdue_milestones).toHaveLength(1);
    expect(items.overdue_milestones[0].detail).toContain('past 2026-10-08');
    expect(items.overdue_milestones[0].projectId).toBe('pj_1');
  });

  it('skips finished milestones, completed projects and milestones without a date', () => {
    const items = computeSignalItems(
      emptyData({
        milestones: [
          milestone({ openIssues: 0 }),
          milestone({ projectStatus: 'completed' }),
          milestone({ projectStatus: 'canceled' }),
          milestone({ targetDate: null }),
          milestone({ targetDate: ago(1), openIssues: 1, doneIssues: 0 }),
        ],
      }),
    );
    expect(items.overdue_milestones).toHaveLength(1);
    expect(items.overdue_milestones[0].detail).toContain('1 of 1 issues still open');
  });

  it('flags open workstreams past their target, not shipped ones and not future ones', () => {
    const late = ws({ status: 'working', targetDate: ago(3) });
    const items = computeSignalItems(
      emptyData({ workstreams: [late, ws({ status: 'shipped', targetDate: ago(30) }), ws({ status: 'working', targetDate: new Date(NOW.getTime() + 86_400_000) }), ws({ status: 'canceled', targetDate: ago(9) })] }),
    );
    expect(items.overdue_workstreams.map((i) => i.id)).toEqual([late.id]);
  });
});

describe('scope_creep', () => {
  const started = ago(20);
  it('counts issues first linked after the work started, inside the range', () => {
    const w = ws({ status: 'working' });
    const [a, b, c, d] = [issue(), issue(), issue(), issue({ status: 'canceled' })];
    const items = computeSignalItems(
      emptyData({
        workstreams: [w],
        facts: facts([[w.id, { startedAt: started }]]),
        issues: [a, b, c, d],
        issueLinks: [
          { issueId: a.id, workstreamId: w.id, at: ago(25) }, // before the start: initial scope
          { issueId: b.id, workstreamId: w.id, at: ago(10) },
          { issueId: c.id, workstreamId: w.id, at: ago(2) },
          { issueId: d.id, workstreamId: w.id, at: ago(1) }, // canceled: not scope
        ],
      }),
    );
    expect(items.scope_creep).toHaveLength(1);
    expect(items.scope_creep[0]).toMatchObject({ value: 2, ageDays: 10 });
  });

  it('needs two added issues, a start and an open workstream', () => {
    const w = ws({ status: 'working' });
    const noStart = ws({ status: 'working' });
    const shipped = ws({ status: 'shipped' });
    const one = issue();
    const links = (wsId: string, n: number) => Array.from({ length: n }, () => ({ issueId: issue().id, workstreamId: wsId, at: ago(1) }));
    const items = computeSignalItems(
      emptyData({
        workstreams: [w, noStart, shipped],
        facts: facts([[w.id, { startedAt: started }], [shipped.id, { startedAt: started }]]),
        issues: [one],
        issueLinks: [{ issueId: one.id, workstreamId: w.id, at: ago(1) }, ...links(noStart.id, 3), ...links(shipped.id, 3)],
      }),
    );
    expect(items.scope_creep).toHaveLength(0);
  });

  it('uses startDate when the event log has no start, but not a future one', () => {
    const w = ws({ status: 'working', startDate: ago(15) });
    const future = ws({ status: 'working', startDate: new Date(NOW.getTime() + 5 * 86_400_000) });
    const links = (wsId: string) => [1, 2].map((d) => ({ issueId: issue().id, workstreamId: wsId, at: ago(d) }));
    const items = computeSignalItems(emptyData({ workstreams: [w, future], issueLinks: [...links(w.id), ...links(future.id)] }));
    expect(items.scope_creep.map((i) => i.id)).toEqual([w.id]);
  });

  it('ignores links older than the range', () => {
    const w = ws({ status: 'working' });
    const items = computeSignalItems(
      emptyData({
        rangeFrom: ago(7),
        workstreams: [w],
        facts: facts([[w.id, { startedAt: ago(60) }]]),
        issueLinks: [30, 20, 10].map((d) => ({ issueId: issue().id, workstreamId: w.id, at: ago(d) })),
      }),
    );
    expect(items.scope_creep).toHaveLength(0);
  });
});

describe('pull requests', () => {
  it('flags unapproved open PRs after three days without an update', () => {
    const w = ws();
    const items = computeSignalItems(
      emptyData({
        workstreams: [w],
        artifacts: [
          pr({ workstreamId: w.id, updatedAt: ago(5), review: 'requested' }),
          pr({ workstreamId: w.id, updatedAt: ago(3), review: 'none' }),
          pr({ workstreamId: w.id, updatedAt: ago(2.9) }), // too fresh
          pr({ workstreamId: w.id, updatedAt: ago(9), review: 'approved' }),
          pr({ workstreamId: w.id, updatedAt: ago(9), state: 'draft' }),
          pr({ workstreamId: w.id, updatedAt: ago(9), state: 'merged' }),
          pr({ workstreamId: w.id, updatedAt: ago(9), kind: 'deployment' }),
        ],
      }),
    );
    expect(items.prs_stuck_in_review.map((i) => i.ageDays)).toEqual([5, 3]);
    expect(items.prs_stuck_in_review[0].detail).toContain('Review requested');
    expect(items.prs_stuck_in_review[1].detail).toContain('No review yet');
  });

  it('reports PRs of no workstream with an unassigned owner', () => {
    const [i] = computeSignalItems(emptyData({ artifacts: [pr({ updatedAt: ago(4) })] })).prs_stuck_in_review;
    expect(i.waitingOn?.type).toBe('unassigned');
    expect(i.workstreamKey).toBeUndefined();
  });

  it('dates failing CI from the event log, else from the last update, and names an agent author', () => {
    const items = computeSignalItems(
      emptyData({
        artifacts: [
          pr({ ci: 'failing', ciFailedAt: ago(3), updatedAt: ago(0.1), authorRef: { type: 'agent', id: 'ag_bot' } }),
          pr({ ci: 'failing', updatedAt: ago(1) }),
          pr({ ci: 'passing' }),
          pr({ ci: 'failing', state: 'closed' }),
        ],
      }),
    );
    expect(items.ci_failing.map((i) => i.ageDays)).toEqual([3, 1]);
    expect(items.ci_failing[0].detail).toContain('Bot (agent)');
    expect(buildSignals(items, 7, 5).find((s) => s.id === 'ci_failing')!.severity).toBe('critical');
  });
});

describe('undecided_decisions', () => {
  it('lists only proposed decisions, oldest first, with their age', () => {
    const w = ws({ accountableUserId: 'u_bob' });
    const items = computeSignalItems(
      emptyData({
        workstreams: [w],
        decisions: [decision({ createdAt: ago(1) }), decision({ createdAt: ago(20), originWorkstreamId: w.id }), decision({ status: 'accepted', createdAt: ago(90) }), decision({ status: 'draft' })],
      }),
    );
    expect(items.undecided_decisions.map((i) => i.ageDays)).toEqual([20, 1]);
    expect(items.undecided_decisions[0].waitingOn).toMatchObject({ name: 'Bob' });
    expect(buildSignals(items, 7, 5).find((s) => s.id === 'undecided_decisions')!.severity).toBe('critical');
  });
});

describe('customer_demand_waiting', () => {
  it('groups requests per target, counts distinct customers and dates by the oldest request', () => {
    const items = computeSignalItems(
      emptyData({
        customerRequests: [
          demand({ customerName: 'Acme', createdAt: ago(40) }),
          demand({ customerName: 'Acme', createdAt: ago(10) }),
          demand({ customerName: 'Globex', createdAt: ago(5), important: true }),
          demand({ targetId: 'pj_9', targetType: 'project', targetKey: undefined, targetTitle: 'Platform', createdAt: ago(100) }),
        ],
      }),
    );
    expect(items.customer_demand_waiting).toHaveLength(2);
    expect(items.customer_demand_waiting[0]).toMatchObject({ type: 'project', title: 'Platform', ageDays: 100, value: 1, projectId: 'pj_9' });
    expect(items.customer_demand_waiting[1]).toMatchObject({ type: 'issue', ageDays: 40, value: 2 });
    expect(items.customer_demand_waiting[1].detail).toContain('2 customers waiting');
    expect(items.customer_demand_waiting[1].detail).toContain('1 marked important');
    expect(buildSignals(items, 7, 5).find((s) => s.id === 'customer_demand_waiting')!.severity).toBe('critical');
  });
});

describe('severityOf', () => {
  it('is ok without items and never lower than the base', () => {
    expect(severityOf({ base: 'warning' }, 0, undefined)).toBe('ok');
    expect(severityOf({ base: 'warning', critAt: 3 }, 1, 0)).toBe('warning');
    expect(severityOf({ base: 'info', warnAt: 1, critAt: 3 }, 1, 0.5)).toBe('info');
    expect(severityOf({ base: 'info', warnAt: 1, critAt: 3 }, 1, 1)).toBe('warning');
    expect(severityOf({ base: 'info', warnAt: 1, critAt: 3 }, 1, 3)).toBe('critical');
  });
});
