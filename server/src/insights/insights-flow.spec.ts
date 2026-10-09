import { describe, expect, it } from 'vitest';
import { NAMES, NOW, ago, issue, ws } from './insights-fixtures-spec.js';
import {
  computeAging,
  computeCumulativeFlow,
  computeDurations,
  computeThroughput,
  computeWip,
  statusAt,
  type IssueChange,
} from './insights-flow.js';

const window30 = { from: ago(30), to: NOW };
const done = (cycleDays: number, completedAgo: number, over = {}) =>
  issue({ status: 'done', createdAt: ago(completedAgo + cycleDays + 2), startedAt: ago(completedAgo + cycleDays), completedAt: ago(completedAgo), ...over });

describe('computeDurations', () => {
  it('reports empty stats when nothing finished', () => {
    const d = computeDurations([issue()], [], window30);
    expect(d.issueCycle.stats).toEqual({ count: 0 });
    expect(d.issueCycle.slowest).toEqual([]);
    expect(d.issueCycle.histogram.every((b) => b.count === 0)).toBe(true);
    expect(d.workstreamLead.stats.count).toBe(0);
  });

  it('computes p50/p85 for cycle (started to done) and lead (created to done)', () => {
    const issues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c, i) => done(c, i + 1));
    const d = computeDurations(issues, [], window30);
    expect(d.issueCycle.stats).toMatchObject({ count: 10, p50: 5, p85: 9, max: 10 });
    expect(d.issueLead.stats).toMatchObject({ count: 10, p50: 7, p85: 11 });
    expect(d.issueCycle.slowest.map((i) => i.value)).toEqual([10, 9, 8, 7, 6]);
  });

  it('excludes unstarted issues from cycle time but keeps them in lead time', () => {
    const skipped = issue({ status: 'done', createdAt: ago(10), startedAt: null, completedAt: ago(2) });
    const d = computeDurations([skipped], [], window30);
    expect(d.issueCycle.stats.count).toBe(0);
    expect(d.issueLead.stats).toMatchObject({ count: 1, p50: 8 });
  });

  it('drops inconsistent data (started after completion) and issues outside the range', () => {
    const bad = issue({ status: 'done', createdAt: ago(10), startedAt: ago(1), completedAt: ago(5) });
    const old = done(3, 45);
    const notDone = issue({ status: 'canceled', completedAt: ago(2) });
    const d = computeDurations([bad, old, notDone], [], window30);
    expect(d.issueCycle.stats.count).toBe(0);
    expect(d.issueLead.stats.count).toBe(1); // bad: created -> completed is still valid lead time
  });

  it('compares with the previous period', () => {
    const d = computeDurations([done(2, 5), done(8, 40)], [], window30);
    expect(d.issueCycle.stats.p50).toBe(2);
    expect(d.issueCycle.previous).toMatchObject({ count: 1, p50: 8 });
  });

  it('measures workstream lead time from creation to shipping', () => {
    const shipped = ws({ status: 'shipped', createdAt: ago(20), shippedAt: ago(5) });
    const reopened = ws({ status: 'working', createdAt: ago(20), shippedAt: ago(5) });
    const d = computeDurations([], [shipped, reopened], window30);
    expect(d.workstreamLead.stats).toMatchObject({ count: 1, p50: 15 });
    expect(d.workstreamLead.slowest[0]).toMatchObject({ type: 'workstream', id: shipped.id });
  });
});

describe('computeThroughput', () => {
  it('uses daily buckets for 7 and 30 days and counts per bucket', () => {
    const t = computeThroughput([done(1, 0.5), done(1, 0.6), done(1, 3)], [ws({ status: 'shipped', shippedAt: ago(0.2) })], { from: ago(7), to: NOW });
    expect(t.buckets).toHaveLength(7);
    expect(t.buckets.at(-1)).toMatchObject({ issuesDone: 2, workstreamsShipped: 1 });
    expect(t.buckets.reduce((n, b) => n + b.issuesDone, 0)).toBe(3);
  });

  it('uses weekly buckets beyond 30 days and clips the first to the range', () => {
    const t = computeThroughput([done(1, 80)], [], { from: ago(90), to: NOW });
    expect(t.buckets).toHaveLength(13);
    expect(t.buckets[0].start).toBe(ago(90).toISOString());
    expect(t.buckets.reduce((n, b) => n + b.issuesDone, 0)).toBe(1);
  });

  it('counts the previous period and ignores the open and the undated', () => {
    const t = computeThroughput([done(1, 40), issue(), issue({ status: 'done', completedAt: null })], [], window30);
    expect(t.previous).toEqual({ issuesDone: 1, workstreamsShipped: 0 });
    expect(t.buckets.reduce((n, b) => n + b.issuesDone, 0)).toBe(0);
  });
});

describe('computeWip', () => {
  it('counts in-progress and in-review issues per assignee and flags overload', () => {
    const many = Array.from({ length: 6 }, () => issue({ assigneeId: 'u_bob', status: 'in_progress' }));
    const w = ws({ accountableUserId: 'u_ada', status: 'working' });
    const wip = computeWip(
      [...many, issue({ assigneeId: 'u_ada', status: 'in_review' }), issue({ assigneeId: 'u_ada', status: 'todo' }), issue({ assigneeId: null, status: 'in_progress' })],
      [w, ws({ accountableUserId: 'u_ada', status: 'planned' }), ws({ accountableUserId: 'u_ada', status: 'shipped' })],
      [],
      NAMES,
      NOW,
    );
    expect(wip.people.map((r) => [r.actor.name, r.issues, r.workstreams, r.overloaded])).toEqual([
      ['Bob', 6, 0, true],
      ['Ada', 1, 1, false],
    ]);
    expect(wip.limits).toEqual({ issues: 5, workstreams: 4 });
    expect(wip.people[0].items.length).toBeLessThanOrEqual(8);
  });

  it('flags a person accountable for too many workstreams', () => {
    const wss = Array.from({ length: 5 }, () => ws({ accountableUserId: 'u_ada', status: 'blocked' }));
    expect(computeWip([], wss, [], NAMES, NOW).people[0]).toMatchObject({ workstreams: 5, overloaded: true });
  });

  it('measures agents by the in-flight workstreams they touched, never by assignment', () => {
    const a = ws({ status: 'working' });
    const b = ws({ status: 'shipped' });
    const wip = computeWip(
      [issue({ assigneeId: 'ag_bot', status: 'in_progress' })],
      [a, b],
      [
        { agentId: 'ag_bot', workstreamId: a.id },
        { agentId: 'ag_bot', workstreamId: a.id },
        { agentId: 'ag_bot', workstreamId: b.id },
        { agentId: 'ag_bot', workstreamId: 'wk_unknown' },
      ],
      NAMES,
      NOW,
    );
    expect(wip.agents).toHaveLength(1);
    expect(wip.agents[0]).toMatchObject({ issues: 0, workstreams: 1, actor: { type: 'agent', name: 'Bot' } });
  });

  it('is empty for an empty workspace', () => {
    expect(computeWip([], [], [], NAMES, NOW)).toMatchObject({ people: [], agents: [] });
  });
});

describe('computeAging', () => {
  const recent = [2, 3, 4, 5, 6, 7].map((c, i) => done(c, i + 1));

  it('has no baseline below five finished issues and flags nothing', () => {
    const aging = computeAging([...recent.slice(0, 4), issue({ startedAt: ago(60) })], NOW, NAMES);
    expect(aging.baselineDays).toBeUndefined();
    expect(aging.baselineSamples).toBe(4);
    expect(aging.items[0].overBaseline).toBe(false);
  });

  it('flags in-flight issues older than the p85 cycle time, oldest first', () => {
    const slow = issue({ startedAt: ago(30), status: 'in_progress' });
    const fine = issue({ startedAt: ago(3), status: 'in_review' });
    const aging = computeAging([...recent, fine, slow, issue({ status: 'todo' })], NOW, NAMES);
    expect(aging.baselineDays).toBe(7);
    expect(aging.items.map((i) => [i.id, i.overBaseline])).toEqual([[slow.id, true], [fine.id, false]]);
    expect(aging.items[0].detail).toContain('slower than 85%');
    expect(aging.items[0].waitingOn?.name).toBe('Ada');
  });

  it('falls back to creation for legacy issues with no start time and caps the list', () => {
    const legacy = issue({ startedAt: null, createdAt: ago(12) });
    expect(computeAging([legacy], NOW, NAMES).items[0].inProgressDays).toBe(12);
    const many = Array.from({ length: 30 }, () => issue());
    expect(computeAging(many, NOW, NAMES).items).toHaveLength(15);
  });

  it('never reports a negative age', () => {
    const future = issue({ startedAt: new Date(NOW.getTime() + 86_400_000) });
    expect(computeAging([future], NOW, NAMES).items[0].inProgressDays).toBe(0);
  });
});

describe('statusAt', () => {
  const created = ago(10);
  const i = { createdAt: created, status: 'done' as const };
  const ch = (daysAgo: number, from: IssueChange['from'], to: IssueChange['to']): IssueChange => ({ issueId: 'x', at: ago(daysAgo), from, to });

  it('does not exist before creation', () => {
    expect(statusAt(i, [], ago(11).getTime())).toBeUndefined();
  });
  it('is the current status without history', () => {
    expect(statusAt(i, [], ago(5).getTime())).toBe('done');
  });
  it('replays changes in order', () => {
    const changes = [ch(8, 'backlog', 'in_progress'), ch(4, 'in_progress', 'done')];
    expect(statusAt(i, changes, ago(9).getTime())).toBe('backlog');
    expect(statusAt(i, changes, ago(6).getTime())).toBe('in_progress');
    expect(statusAt(i, changes, ago(1).getTime())).toBe('done');
  });
});

describe('computeCumulativeFlow', () => {
  it('returns one column per day with every status and adds finished-before work to Done', () => {
    const a = issue({ createdAt: ago(5), status: 'done', completedAt: ago(1) });
    const b = issue({ createdAt: ago(5), status: 'backlog' });
    const changes: IssueChange[] = [
      { issueId: a.id, at: ago(4), from: 'backlog', to: 'in_progress' },
      { issueId: a.id, at: ago(1), from: 'in_progress', to: 'done' },
    ];
    const cfd = computeCumulativeFlow([a, b], changes, 3, { from: ago(7), to: NOW });
    expect(cfd.days).toHaveLength(7);
    expect(cfd.series.map((s) => s.status)).toEqual(['backlog', 'todo', 'in_progress', 'in_review', 'done']);
    const col = (status: string, i: number) => cfd.series.find((s) => s.status === status)!.values[i];
    // day 0 is 6 days ago: neither issue exists yet, only the 3 done before
    expect([col('backlog', 0), col('in_progress', 0), col('done', 0)]).toEqual([0, 0, 3]);
    // last column: a is done, b is still in the backlog
    expect([col('backlog', 6), col('in_progress', 6), col('done', 6)]).toEqual([1, 0, 4]);
    // in between a was in progress
    expect(cfd.series.find((s) => s.status === 'in_progress')!.values.some((v) => v === 1)).toBe(true);
  });

  it('leaves drafts and canceled issues out and handles no issues', () => {
    const cfd = computeCumulativeFlow([issue({ status: 'draft', createdAt: ago(3) }), issue({ status: 'canceled', createdAt: ago(3) })], [], 0, { from: ago(7), to: NOW });
    expect(cfd.series.every((s) => s.values.every((v) => v === 0))).toBe(true);
    expect(computeCumulativeFlow([], [], 0, { from: ago(30), to: NOW }).days).toHaveLength(30);
  });

  it('never samples past now', () => {
    const cfd = computeCumulativeFlow([], [], 0, { from: ago(7), to: NOW });
    expect(new Date(cfd.days.at(-1)!).getTime()).toBeLessThanOrEqual(NOW.getTime());
  });
});
