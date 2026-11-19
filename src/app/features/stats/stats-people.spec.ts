import type { DomainEvent } from '../../core';
import { activityRows, closedByPersonPerBucket, personRows } from './stats-people';
import { NOW, finished, iso, issue } from './stats-fixtures';
import { buckets, resolveRange } from './stats-range';

const name = (id: string | undefined) => (id ? id.toUpperCase() : 'Unassigned');
const range = resolveRange('30d', NOW);

describe('personRows', () => {
  const issues = [
    issue('a', { status: 'todo', assigneeId: 'ann', estimate: 2 }),
    issue('b', { status: 'in_progress', assigneeId: 'ann' }),
    issue('c', { status: 'in_review', assigneeId: 'bob' }),
    issue('d', { status: 'backlog', assigneeId: 'bob' }),
    issue('e', { status: 'todo' }),
    finished('f', 20, 14, 3, { assigneeId: 'bob' }),
    finished('g', 20, 16, 5, { assigneeId: 'bob' }),
    finished('h', 90, 80, 70, { assigneeId: 'bob' }),
  ];

  it('counts todo, in progress and in review as load, never the backlog', () => {
    const rows = personRows(issues, range, name, (i) => i.id === 'b');
    const ann = rows.find((r) => r.key === 'ann')!;
    expect(ann).toMatchObject({ load: 2, todo: 1, inProgress: 1, points: 2, stale: 1 });
    expect(rows.find((r) => r.key === 'bob')).toMatchObject({ load: 1, inReview: 1, stale: 0 });
  });

  it('counts what was closed in the range and its median cycle time, and lists "unassigned" last', () => {
    const rows = personRows(issues, range, name, () => false);
    const bob = rows.find((r) => r.key === 'bob')!;
    expect(bob.closed).toBe(2);
    expect(bob.medianCycle).toBeCloseTo(11);
    expect(rows[rows.length - 1].key).toBe('unassigned');
  });
});

describe('closedByPersonPerBucket', () => {
  const { items } = buckets(range);
  const issues = [
    finished('1', 20, 10, 1, { assigneeId: 'ann' }),
    finished('2', 20, 10, 2, { assigneeId: 'ann' }),
    finished('3', 20, 10, 9, { assigneeId: 'bob' }),
    finished('4', 20, 10, 8, { assigneeId: 'cy' }),
    finished('5', 20, 10, 8, { assigneeId: 'di' }),
  ];

  it('shows the people who closed most and folds the rest into Others', () => {
    const series = closedByPersonPerBucket(issues, items, range, name, 2);
    expect(series.map((s) => s.label)).toEqual(['ANN', 'BOB', 'Others']);
    expect(series[0].values).toEqual([0, 0, 0, 0, 2]);
    expect(series[2].values.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('has no Others series when nobody is left out', () => {
    expect(closedByPersonPerBucket(issues, items, range, name, 9).map((s) => s.label)).not.toContain('Others');
  });
});

describe('activityRows', () => {
  const ev = (type: string, id: string | undefined, days: number): DomainEvent =>
    ({ id: `${type}${days}${id}`, at: iso(days), type, actor: { type: id ? 'user' : 'system', id }, subject: { type: 'issue', id: 'x' }, data: {} }) as DomainEvent;

  it('counts the kinds of event that show work, inside the range only, and sorts by total', () => {
    const rows = activityRows(
      [ev('comment.created', 'ann', -1), ev('comment.created', 'ann', -2), ev('issue.status_changed', 'bob', -3), ev('comment.created', 'bob', -200), ev('artifact.updated', 'bob', -1)],
      range,
      (e) => e.actor.id ?? 'System',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: 'ann', comments: 2, total: 2 });
    expect(rows[1]).toMatchObject({ label: 'bob', statusChanges: 1, total: 1 });
  });
});
