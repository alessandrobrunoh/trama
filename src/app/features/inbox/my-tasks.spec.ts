import type { Issue } from '../../core';
import { DAY } from '../stats/flow-stats';
import { countOpen, groupMyTasks, groupOf } from './my-tasks';

const NOW = Date.parse('2026-03-20T12:00:00Z');
const iso = (offsetDays: number): string => new Date(NOW + offsetDays * DAY).toISOString();

function task(id: string, patch: Partial<Issue> = {}): Issue {
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
    updatedAt: iso(-1),
    ...patch,
  } as Issue;
}

/** Activity is the task's own update time here; the real lookup also reads events, pull requests and time. */
const opts = (patch: Partial<Parameters<typeof groupMyTasks>[1]> = {}) => ({
  showClosed: false,
  now: NOW,
  idleDays: 7,
  activityAt: (i: Issue) => Date.parse(i.updatedAt),
  ...patch,
});

const ids = (groups: ReturnType<typeof groupMyTasks>, id: string): string[] =>
  groups.find((g) => g.id === id)?.items.map((i) => i.id) ?? [];

describe('groupMyTasks', () => {
  it('splits running tasks into in progress and idle by their last activity', () => {
    const groups = groupMyTasks(
      [
        task('fresh', { status: 'in_progress', updatedAt: iso(-1) }),
        task('review', { status: 'in_review', updatedAt: iso(-2) }),
        task('stale', { status: 'in_progress', updatedAt: iso(-10) }),
      ],
      opts(),
    );
    expect(ids(groups, 'in-progress').sort()).toEqual(['fresh', 'review']);
    expect(ids(groups, 'idle')).toEqual(['stale']);
  });

  it('puts todo under up next and backlog and drafts under backlog', () => {
    const groups = groupMyTasks(
      [task('a', { status: 'todo' }), task('b', { status: 'backlog' }), task('c', { status: 'draft' })],
      opts(),
    );
    expect(ids(groups, 'up-next')).toEqual(['a']);
    expect(ids(groups, 'backlog').sort()).toEqual(['b', 'c']);
  });

  it('keeps the fixed order: in progress, idle, up next, backlog', () => {
    const groups = groupMyTasks(
      [
        task('b', { status: 'backlog' }),
        task('t', { status: 'todo' }),
        task('s', { status: 'in_progress', updatedAt: iso(-30) }),
        task('p', { status: 'in_progress' }),
      ],
      opts(),
    );
    expect(groups.map((g) => g.id)).toEqual(['in-progress', 'idle', 'up-next', 'backlog']);
  });

  it('hides done and canceled tasks unless closed tasks are shown', () => {
    const list = [task('d', { status: 'done' }), task('c', { status: 'canceled' }), task('t', { status: 'todo' })];
    expect(groupMyTasks(list, opts()).map((g) => g.id)).toEqual(['up-next']);
    expect(groupMyTasks(list, opts({ showClosed: true })).map((g) => g.id)).toEqual(['up-next', 'done', 'canceled']);
  });

  it('omits empty groups', () => {
    expect(groupMyTasks([], opts())).toEqual([]);
  });

  it('sorts by priority, then by most recent update', () => {
    const groups = groupMyTasks(
      [
        task('low', { status: 'todo', priority: 'low', updatedAt: iso(-1) }),
        task('urgent', { status: 'todo', priority: 'urgent', updatedAt: iso(-5) }),
        task('lowNew', { status: 'todo', priority: 'low', updatedAt: iso(-0.5) }),
      ],
      opts(),
    );
    expect(ids(groups, 'up-next')).toEqual(['urgent', 'lowNew', 'low']);
  });

  it('lists the longest-quiet idle task first', () => {
    const groups = groupMyTasks(
      [
        task('ten', { status: 'in_progress', updatedAt: iso(-10) }),
        task('forty', { status: 'in_progress', updatedAt: iso(-40) }),
      ],
      opts(),
    );
    expect(ids(groups, 'idle')).toEqual(['forty', 'ten']);
  });

  it('uses real activity, not the update time, to decide idleness', () => {
    const t = task('worked', { status: 'in_progress', updatedAt: iso(-20) });
    expect(groupOf(t, opts({ activityAt: () => NOW - DAY }))).toBe('in-progress');
    expect(groupOf(t, opts({ idleDays: 30 }))).toBe('in-progress');
    expect(groupOf(t, opts())).toBe('idle');
  });
});

describe('countOpen', () => {
  it('does not count done or canceled tasks', () => {
    expect(countOpen([task('a', { status: 'todo' }), task('b', { status: 'done' }), task('c', { status: 'canceled' })])).toBe(1);
  });
});
