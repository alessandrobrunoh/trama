import { accuracyPerBucket, biggestOverruns, daySummary, mySpans, msByKey, msPerBucket, pacedTasks, totalMs, weekdayHour } from './stats-time';
import { trackedByIssue } from './flow-stats';
import { HOUR, NOW, entry, finished } from './stats-fixtures';
import { buckets, resolveRange } from './stats-range';

const DAYS = 2 * 86_400_000;

describe('tracked time', () => {
  const range = resolveRange('7d', NOW);

  it('uses only finished entries of the signed-in person and never a running timer', () => {
    const spans = mySpans([entry('a', 5, 2), entry('a', 3, null), entry('b', 6, 1, 'someone-else')], 'u1');
    expect(spans).toHaveLength(1);
    expect(totalMs(spans, range)).toBe(2 * HOUR);
  });

  it('cuts an entry at the edge of the range', () => {
    const spans = mySpans([entry(null, 7 * 24 + 1, 3)], null);
    expect(Math.abs(totalMs(spans, range) - 2 * HOUR)).toBeLessThanOrEqual(1);
  });

  it('splits an entry that crosses two buckets', () => {
    const { items } = buckets(range);
    const day = items[6];
    const started = day.from - HOUR;
    const spans = [{ start: started, end: started + 3 * HOUR, issueId: null, projectId: null }];
    const per = msPerBucket(spans, items);
    expect(per[5]).toBe(HOUR);
    expect(per[6]).toBe(2 * HOUR);
  });

  it('groups by key, biggest first, and counts a span under every key', () => {
    const spans = [
      { start: NOW - 3 * HOUR, end: NOW - 2 * HOUR, issueId: 'a', projectId: 'p1' },
      { start: NOW - 2 * HOUR, end: NOW, issueId: 'b', projectId: 'p2' },
    ];
    expect(msByKey(spans, range, (s) => [s.projectId!])).toEqual([
      { key: 'p2', ms: 2 * HOUR },
      { key: 'p1', ms: HOUR },
    ]);
    expect(msByKey(spans, range, () => ['x', 'y']).map((r) => r.ms)).toEqual([3 * HOUR, 3 * HOUR]);
  });

  it('summarises days with time and the longest day', () => {
    const spans = [
      { start: NOW - 30 * HOUR, end: NOW - 28 * HOUR, issueId: null, projectId: null },
      { start: NOW - 3 * HOUR, end: NOW - HOUR, issueId: null, projectId: null },
    ];
    const s = daySummary(spans, range);
    expect(s.activeDays).toBe(2);
    expect(s.longestMs).toBe(2 * HOUR);
  });

  it('spreads an entry over the weekday and hour cells it covers', () => {
    const start = new Date(2026, 2, 16, 9, 30).getTime(); // Monday 16 March, local
    const grid = weekdayHour([{ start, end: start + 90 * 60_000, issueId: null, projectId: null }], { from: start - DAYS, to: start + DAYS }, 1);
    expect(grid[0][9]).toBe(30 * 60_000);
    expect(grid[0][10]).toBe(60 * 60_000);
    expect(grid.flat().reduce((a, b) => a + b, 0)).toBe(90 * 60_000);
  });
});

describe('estimate against tracked time', () => {
  // 1 point = 1 hour for the first three, then one task that took 4x and one that took a quarter
  const issues = [
    finished('a', 30, 20, 9, { estimate: 2 }),
    finished('b', 30, 20, 8, { estimate: 2 }),
    finished('c', 30, 20, 7, { estimate: 2 }),
    finished('d', 30, 20, 2, { estimate: 1 }),
    finished('e', 30, 20, 1, { estimate: 4 }),
    finished('f', 30, 20, 1, {}),
  ];
  const tracked = trackedByIssue([
    entry('a', 300, 2),
    entry('b', 290, 2),
    entry('c', 280, 2),
    entry('d', 100, 4),
    entry('e', 80, 1),
    entry('f', 70, 3),
  ]);

  it('needs REF_MIN tasks before it states a usual pace', () => {
    expect(pacedTasks(issues.slice(0, 2), tracked)).toEqual({ sample: 2, tasks: [] });
  });

  it('compares each finished task with the median time per point, and skips tasks without an estimate', () => {
    const p = pacedTasks(issues, tracked);
    expect(p.sample).toBe(5);
    expect(p.paceMsPerPoint).toBe(HOUR);
    const byId = Object.fromEntries(p.tasks.map((t) => [t.issue.id, t.factor]));
    expect(byId['a']).toBeCloseTo(1);
    expect(byId['d']).toBeCloseTo(4);
    expect(byId['e']).toBeCloseTo(0.25);
    expect(byId['f']).toBeUndefined();
  });

  it('lists the biggest overruns first and never an early finish', () => {
    const over = biggestOverruns(pacedTasks(issues, tracked).tasks);
    expect(over.map((t) => t.issue.id)).toEqual(['d']);
  });

  it('gives the share within the usual range per bucket and null where nothing finished', () => {
    const { items } = buckets(resolveRange('30d', NOW));
    // a, b and c (done 9, 8 and 7 days ago) are right on the usual pace; d (4x) and e (a quarter) are outside it
    expect(accuracyPerBucket(pacedTasks(issues, tracked).tasks, items)).toEqual([null, null, null, 100, 0]);
  });
});
