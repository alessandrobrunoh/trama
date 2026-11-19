import type { Milestone, Project } from '../../core';
import { burnup, milestoneRow, milestoneTotals, projectRows, scopeVsClosed } from './stats-projects';
import { NOW, finished, iso, issue } from './stats-fixtures';
import { DAY, buckets, resolveRange } from './stats-range';

const milestone = (id: string, targetDays?: number): Milestone =>
  ({ id, projectId: 'p', name: id, sortOrder: 0, targetDate: targetDays === undefined ? undefined : iso(targetDays) }) as Milestone;

describe('milestoneRow', () => {
  it('is hit when every task is done on time, late when the last one finished after the target', () => {
    const onTime = milestoneRow(milestone('m', -2), [finished('a', 20, 10, 5), finished('b', 20, 10, 4)], NOW);
    expect(onTime).toMatchObject({ state: 'hit', total: 2, done: 2 });
    const late = milestoneRow(milestone('m', -10), [finished('a', 20, 15, 5)], NOW);
    expect(late.state).toBe('hit_late');
    expect(late.daysAfterTarget).toBeGreaterThan(0);
  });

  it('is missed once the target day passed with work still open, upcoming before', () => {
    const open = [finished('a', 20, 10, 5), issue('b', { status: 'todo' })];
    expect(milestoneRow(milestone('m', -3), open, NOW)).toMatchObject({ state: 'missed', done: 1, total: 2 });
    expect(milestoneRow(milestone('m', 10), open, NOW).state).toBe('upcoming');
    expect(milestoneRow(milestone('m'), open, NOW).state).toBe('no_date');
  });

  it('leaves canceled tasks out and calls a milestone without tasks empty', () => {
    const tasks = [finished('a', 20, 10, 5), issue('x', { status: 'canceled' })];
    expect(milestoneRow(milestone('m', 5), tasks, NOW)).toMatchObject({ state: 'hit', total: 1 });
    expect(milestoneRow(milestone('m', 5), [], NOW).state).toBe('empty');
  });

  it('adds up the milestones that can be hit or missed', () => {
    const rows = [
      milestoneRow(milestone('a', 5), [finished('t', 20, 10, 5)], NOW),
      milestoneRow(milestone('b', -3), [issue('o', { status: 'todo' })], NOW),
      milestoneRow(milestone('c', 5), [], NOW),
    ];
    expect(milestoneTotals(rows)).toEqual({ hit: 1, hitLate: 0, missed: 1, upcoming: 0, dated: 2 });
  });
});

describe('projectRows', () => {
  const project = (id: string, status: Project['status'], patch: Partial<Project> = {}): Project =>
    ({ id, name: id, status, createdAt: iso(-90), ...patch }) as Project;
  const range = resolveRange('30d', NOW);

  it('forecasts from the same throughput as the Timeline and puts running projects first', () => {
    const tasks = [
      finished('a', 40, 30, 20),
      finished('b', 40, 30, 15),
      finished('c', 40, 30, 10),
      finished('d', 40, 30, 5),
      issue('e', { status: 'todo', createdAt: iso(-40) }),
    ];
    const rows = projectRows(
      [project('done-one', 'completed'), project('run', 'in_progress', { targetDate: iso(60), startDate: iso(-90) })],
      (id) => (id === 'run' ? tasks : []),
      () => [],
      NOW,
      range,
    );
    expect(rows.map((r) => r.project.id)).toEqual(['run', 'done-one']);
    expect(rows[0]).toMatchObject({ total: 5, done: 4, open: 1, closed: 4 });
    expect(rows[0].forecast.signal).toBe('on_track');
    expect(rows[0].forecast.projectedEnd).toBeDefined();
  });
});

describe('scope and burn-up', () => {
  const { items } = buckets(resolveRange('30d', NOW));
  const issues = [finished('a', 20, 10, 3), issue('b', { createdAt: iso(-2) }), issue('c', { status: 'canceled', createdAt: iso(-2) })];

  it('counts scope added and closed per bucket, canceled tasks out of both', () => {
    const { added, closed } = scopeVsClosed(issues, items);
    expect(added.reduce((a, b) => a + b, 0)).toBe(2);
    expect(closed.reduce((a, b) => a + b, 0)).toBe(1);
    expect(added[4]).toBe(1);
  });

  it('draws scope and done as running totals that never lose done work', () => {
    const times = [NOW - 15 * DAY, NOW - 2.5 * DAY, NOW];
    const { scope, done } = burnup(issues, times, NOW);
    expect(scope).toEqual([1, 1, 2]);
    expect(done).toEqual([0, 1, 1]);
  });
});
