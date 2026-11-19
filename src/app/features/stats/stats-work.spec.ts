import type { Issue } from '../../core';
import { agingBuckets, medianOpenAge, openBreakdown, staleTasks, subtaskProgress, subtaskDonePct } from './stats-work';
import { NOW, iso, issue } from './stats-fixtures';

const name = (k: string) => k.toUpperCase();

describe('openBreakdown', () => {
  it('counts only open tasks, lists "none" last and counts a task under every key it has', () => {
    const issues = [
      issue('a', { status: 'todo', labels: ['x', 'y'], estimate: 3 }),
      issue('b', { status: 'in_progress', labels: ['x'] }),
      issue('c', { status: 'backlog', labels: [] }),
      issue('d', { status: 'done', labels: ['x'] }),
      issue('e', { status: 'canceled', labels: ['y'] }),
    ];
    const rows = openBreakdown(issues, (i) => i.labels, name, 'No label');
    expect(rows.map((r) => [r.label, r.count])).toEqual([['X', 2], ['Y', 1], ['No label', 1]]);
    expect(rows[0].points).toBe(3);
  });
});

describe('stale tasks', () => {
  const at = (days: number) => () => NOW - days * 86_400_000;

  it('are running tasks with no activity for the chosen number of days, longest idle first', () => {
    const a = issue('a', { status: 'in_progress' });
    const b = issue('b', { status: 'in_review' });
    const lookup = (i: Issue) => NOW - (i.id === 'a' ? 10 : 20) * 86_400_000;
    const rows = staleTasks([a, b], NOW, 7, lookup);
    expect(rows.map((r) => r.issue.id)).toEqual(['b', 'a']);
    expect(staleTasks([a, b], NOW, 14, lookup).map((r) => r.issue.id)).toEqual(['b']);
  });

  it('never include waiting or finished tasks, however old', () => {
    const issues = [issue('t', { status: 'todo' }), issue('g', { status: 'backlog' }), issue('d', { status: 'done' })];
    expect(staleTasks(issues, NOW, 3, at(400))).toEqual([]);
  });
});

describe('aging', () => {
  const open = [
    issue('a', { status: 'todo', createdAt: iso(-3) }),
    issue('b', { status: 'in_progress', createdAt: iso(-3) }),
    issue('c', { status: 'backlog', createdAt: iso(-20) }),
    issue('d', { status: 'backlog', createdAt: iso(-200) }),
  ];

  it('sorts open tasks into age classes and counts stale ones apart', () => {
    const rows = agingBuckets(open, NOW, new Set(['b']));
    expect(rows[0]).toMatchObject({ label: '<1w', fresh: 1, stale: 1 });
    expect(rows[2].fresh).toBe(1);
    expect(rows[5].fresh).toBe(1);
  });

  it('takes the median age without the stale tasks', () => {
    expect(medianOpenAge(open, NOW, new Set())).toBeCloseTo(11.5);
    expect(medianOpenAge(open, NOW, new Set(['d']))).toBeCloseTo(3);
    expect(medianOpenAge([], NOW, new Set())).toBeUndefined();
  });
});

describe('subtasks', () => {
  const issues = [
    issue('p', { status: 'in_progress' }),
    issue('c1', { status: 'done', parentId: 'p' }),
    issue('c2', { status: 'todo', parentId: 'p' }),
    issue('c3', { status: 'canceled', parentId: 'p' }),
    issue('g1', { status: 'done', parentId: 'c2' }),
    issue('lone', { status: 'todo' }),
  ];

  it('counts subtasks at every depth and leaves canceled ones out', () => {
    const rows = subtaskProgress(issues);
    const p = rows.find((r) => r.parent.id === 'p')!;
    expect(p).toMatchObject({ total: 3, done: 2 });
    expect(rows.find((r) => r.parent.id === 'c2')).toMatchObject({ total: 1, done: 1 });
    expect(rows.find((r) => r.parent.id === 'lone')).toBeUndefined();
  });

  it('gives the share of all subtasks that are done', () => {
    expect(subtaskDonePct(issues)).toEqual({ pct: 67, done: 2, total: 3 });
    expect(subtaskDonePct([issue('x')])).toBeUndefined();
  });

  it('does not loop on a parent cycle', () => {
    const loop = [issue('a', { parentId: 'b' }), issue('b', { parentId: 'a' })];
    expect(() => subtaskProgress(loop)).not.toThrow();
  });
});
