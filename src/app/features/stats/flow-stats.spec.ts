import type { Issue } from '../../core';
import type { TimeEntry } from '../../core/api/api.types';
import {
  DAY,
  activityLookup,
  completedSummary,
  createdIn,
  estimateAccuracy,
  estimateCoverage,
  openByProject,
  openByStatus,
  runningRows,
  trackedByIssue,
  trackedIn,
  typicalTracked,
  weeklyThroughput,
  workload,
} from './flow-stats';

const NOW = Date.parse('2026-03-20T12:00:00Z');
const iso = (offsetDays: number): string => new Date(NOW + offsetDays * DAY).toISOString();
const HOUR = 3_600_000;

function issue(id: string, patch: Partial<Issue> = {}): Issue {
  return {
    id,
    workspaceId: 'w',
    key: `T-${id}`,
    number: 1,
    kind: 'feature',
    title: `Task ${id}`,
    source: 'manual',
    priority: 'none',
    status: 'backlog',
    milestoneIds: [],
    labels: [],
    aliases: [],
    createdAt: iso(-60),
    updatedAt: iso(-60),
    ...patch,
  } as Issue;
}

function entry(issueId: string | null, startH: number, hours: number | null, userId = 'u1'): TimeEntry {
  const start = NOW - startH * HOUR;
  return {
    id: `e${Math.random()}`,
    workspaceId: 'w',
    userId,
    projectId: null,
    issueId,
    description: '',
    startedAt: new Date(start).toISOString(),
    endedAt: hours === null ? null : new Date(start + hours * HOUR).toISOString(),
    createdAt: iso(-1),
    updatedAt: iso(-1),
  };
}

const done = (id: string, estimate: number | undefined, completedDaysAgo = 2): Issue =>
  issue(id, { status: 'done', estimate, startedAt: iso(-completedDaysAgo - 1), completedAt: iso(-completedDaysAgo) });

describe('tracked time', () => {
  it('sums finished entries per task and leaves running timers out', () => {
    const map = trackedByIssue([entry('a', 10, 2), entry('a', 5, 1), entry('b', 4, null), entry(null, 3, 1)]);
    expect(map.get('a')).toBe(3 * HOUR);
    expect(map.has('b')).toBe(false);
    expect(map.size).toBe(1);
  });

  it('does not count suggested entries', () => {
    const suggested: TimeEntry = { ...entry('a', 3, 1), source: 'suggested' };
    expect(trackedByIssue([suggested, entry('a', 5, 1)]).get('a')).toBe(HOUR);
    expect(trackedIn([suggested], { from: NOW - 10 * HOUR, to: NOW })).toBe(0);
  });

  it('cuts entries at the range edges and can filter by person', () => {
    const entries = [entry('a', 30, 4), entry('a', 2, 1, 'u2')];
    const range = { from: NOW - 28 * HOUR, to: NOW };
    expect(trackedIn(entries, range)).toBe(2 * HOUR + HOUR);
    expect(trackedIn(entries, range, 'u2')).toBe(HOUR);
  });
});

describe('estimate accuracy', () => {
  it('compares only completed tasks that have both an estimate and tracked time', () => {
    const issues = [done('a', 3), done('b', 3), done('c', 3), done('d', 3), done('e', undefined), done('f', 5), issue('g', { status: 'in_progress', estimate: 5 })];
    const tracked = new Map<string, number>([
      ['a', 3 * HOUR],
      ['b', 3 * HOUR],
      ['c', 3 * HOUR],
      ['d', 3 * HOUR],
      ['e', 2 * HOUR],
      ['g', 90 * HOUR],
    ]);
    const acc = estimateAccuracy(issues, tracked);
    expect(acc.sample).toBe(4);
    expect(acc.excluded).toEqual({ noTime: 1, noEstimate: 1 });
    expect(acc.open).toEqual({ count: 1, ms: 90 * HOUR });
    expect(acc.rows).toHaveLength(1);
    expect(acc.rows[0]).toMatchObject({ estimate: 3, n: 4, medianMs: 3 * HOUR, thin: false });
    expect(acc.paceMsPerPoint).toBe(HOUR);
    expect(acc.consistentPct).toBe(100);
  });

  it('is not moved by a task left in progress for weeks', () => {
    const stale = issue('s', { status: 'in_progress', estimate: 3, startedAt: iso(-40) });
    const base = [done('a', 3), done('b', 3), done('c', 3)];
    const tracked = new Map<string, number>([['a', 3 * HOUR], ['b', 3 * HOUR], ['c', 3 * HOUR]]);
    expect(estimateAccuracy([...base, stale], tracked)).toEqual(estimateAccuracy(base, tracked));
  });

  it('flags a finished task that took far longer than the pace and keeps the pace a median', () => {
    const issues = [done('a', 2), done('b', 2), done('c', 2), done('d', 2), done('x', 2)];
    const tracked = new Map<string, number>([['a', 2 * HOUR], ['b', 2 * HOUR], ['c', 2 * HOUR], ['d', 2 * HOUR], ['x', 80 * HOUR]]);
    const acc = estimateAccuracy(issues, tracked);
    expect(acc.paceMsPerPoint).toBe(HOUR);
    expect(acc.consistentPct).toBe(80);
    expect(acc.outliers).toHaveLength(1);
    expect(acc.outliers[0].issue.id).toBe('x');
    expect(acc.outliers[0].factor).toBe(40);
  });

  it('shows no pace below three tasks', () => {
    const acc = estimateAccuracy([done('a', 2), done('b', 2)], new Map([['a', HOUR], ['b', HOUR]]));
    expect(acc.paceMsPerPoint).toBeUndefined();
    expect(acc.consistentPct).toBeUndefined();
    expect(acc.rows[0].thin).toBe(true);
  });

  it('gives a typical time for one estimate, without the task itself', () => {
    const issues = [done('a', 3), done('b', 3), done('c', 3), done('d', 3)];
    const tracked = new Map<string, number>([['a', HOUR], ['b', 2 * HOUR], ['c', 3 * HOUR], ['d', 50 * HOUR]]);
    expect(typicalTracked(issues, tracked, 3, 'd')).toEqual({ n: 3, medianMs: 2 * HOUR });
    expect(typicalTracked(issues, tracked, 3, 'a').n).toBe(3);
    expect(typicalTracked(issues, tracked, 5).medianMs).toBeUndefined();
  });
});

describe('time to finish', () => {
  it('uses completed tasks only and the median', () => {
    const issues = [
      done('a', 1, 1),
      done('b', 1, 1),
      issue('c', { status: 'done', startedAt: iso(-90), completedAt: iso(-1) }),
      issue('stale', { status: 'in_progress', startedAt: iso(-400) }),
    ];
    const s = completedSummary(issues, { from: NOW - 7 * DAY, to: NOW + 1 });
    expect(s.count).toBe(3);
    expect(s.finishSample).toBe(3);
    expect(s.medianDaysToFinish).toBe(1);
  });

  it('counts completions per week', () => {
    const issues = [done('a', 2, 1), done('b', 3, 2), done('c', 5, 9), issue('d', { status: 'canceled', completedAt: iso(-1) })];
    const weeks = weeklyThroughput(issues, NOW, '30d');
    expect(weeks).toHaveLength(5);
    expect(weeks[4]).toMatchObject({ done: 2, points: 5 });
    expect(weeks[3]).toMatchObject({ done: 1, points: 5 });
    expect(weeks.reduce((n, w) => n + w.done, 0)).toBe(3);
  });
});

describe('idle work', () => {
  it('marks a task idle only without any recent activity, and counts tracked time and pull requests as activity', () => {
    const quiet = issue('q', { status: 'in_progress', startedAt: iso(-20), updatedAt: iso(-20) });
    const timed = issue('t', { status: 'in_progress', startedAt: iso(-20), updatedAt: iso(-20) });
    const pr = issue('p', { status: 'in_review', startedAt: iso(-20), updatedAt: iso(-20) });
    const fresh = issue('f', { status: 'in_progress', startedAt: iso(-1), updatedAt: iso(-1) });
    const activity = activityLookup({
      events: new Map(),
      artifacts: new Map([['p', [{ updatedAt: iso(-1) }]]]),
      entries: [entry('t', 24, 1)],
      now: NOW,
    });
    const tracked = trackedByIssue([entry('t', 24, 1)]);
    const rows = runningRows([quiet, timed, pr, fresh, issue('b')], NOW, 7, activity, tracked);
    expect(rows.map((r) => [r.issue.id, r.idle])).toEqual([
      ['q', true],
      ['p', false],
      ['f', false],
      ['t', false],
    ]);
    expect(rows.find((r) => r.issue.id === 't')?.trackedMs).toBe(HOUR);
  });
});

describe('created vs completed', () => {
  it('counts what was created and what was completed in each week', () => {
    const issues = [
      issue('a', { createdAt: iso(-2) }),
      issue('b', { createdAt: iso(-3) }),
      issue('c', { createdAt: iso(-9) }),
      done('d', undefined, 1),
      done('e', undefined, 10),
    ];
    const weeks = weeklyThroughput(issues, NOW, '7d');
    const last = weeks[weeks.length - 1];
    const before = weeks[weeks.length - 2];
    // `done()` helpers are created 60 days ago: outside the four-week window, but still completed in it.
    expect(last).toMatchObject({ created: 2, done: 1 });
    expect(before).toMatchObject({ created: 1, done: 1 });
  });

  it('counts created tasks inside a range', () => {
    const issues = [issue('a', { createdAt: iso(-1) }), issue('b', { createdAt: iso(-20) })];
    expect(createdIn(issues, { from: NOW - 7 * DAY, to: NOW + 1 })).toBe(1);
  });
});

describe('open work', () => {
  const label = (s: string) => s.toUpperCase();

  it('lists every open status, with zero, and leaves finished work out', () => {
    const issues = [
      issue('a', { status: 'todo', estimate: 2 }),
      issue('b', { status: 'todo', estimate: 3 }),
      issue('c', { status: 'in_progress' }),
      done('d', 1),
      issue('e', { status: 'canceled' }),
    ];
    expect(openByStatus(issues, label).map((r) => [r.key, r.count, r.points])).toEqual([
      ['backlog', 0, 0],
      ['todo', 2, 5],
      ['in_progress', 1, 0],
      ['in_review', 0, 0],
    ]);
  });

  it('groups open work by project, biggest first, with tasks without a project last', () => {
    const issues = [
      issue('a', { status: 'todo', projectId: 'p1' }),
      issue('b', { status: 'todo' }),
      issue('c', { status: 'backlog', projectId: 'p2' }),
      issue('d', { status: 'in_progress', projectId: 'p2' }),
      done('e', undefined),
    ];
    const rows = openByProject(issues, (id) => `Project ${id}`);
    expect(rows.map((r) => [r.label, r.count])).toEqual([
      ['Project p2', 2],
      ['Project p1', 1],
      ['No project', 1],
    ]);
  });
});

describe('estimate coverage', () => {
  it('says how many finished tasks have an estimate, tracked time, and both', () => {
    const issues = [done('a', 2), done('b', 3), done('c', undefined), issue('d', { status: 'todo', estimate: 1 })];
    const tracked = trackedByIssue([entry('a', 10, 2), entry('c', 8, 1)]);
    expect(estimateCoverage(issues, tracked)).toEqual({ finished: 3, withEstimate: 2, withTime: 2, both: 1 });
  });
});

describe('workload', () => {
  it('counts todo, in progress and review per person and ignores the backlog', () => {
    const issues = [
      issue('a', { status: 'todo', assigneeId: 'u1', estimate: 2 }),
      issue('b', { status: 'in_progress', assigneeId: 'u1', estimate: 3 }),
      issue('c', { status: 'in_review', assigneeId: 'u2' }),
      issue('d', { status: 'backlog', assigneeId: 'u2' }),
      issue('e', { status: 'todo' }),
    ];
    const rows = workload(issues, (id) => id ?? 'Unassigned', (i) => i.id === 'b');
    expect(rows.map((r) => [r.label, r.total, r.points, r.idle])).toEqual([
      ['u1', 2, 5, 1],
      ['u2', 1, 0, 0],
      ['Unassigned', 1, 0, 0],
    ]);
  });
});
