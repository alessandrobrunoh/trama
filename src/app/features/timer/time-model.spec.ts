import { describe, expect, it } from 'vitest';
import type { Issue } from '../../core/contracts/domain';
import type { TimeEntry } from '../../core/api/api.types';
import {
  HOUR,
  buildGrid,
  doneSamples,
  entriesOnDay,
  hm,
  hoursMinutes,
  hoursShort,
  mondayOf,
  reportDays,
  segments,
  summarize,
  trackedByTask,
  valueRows,
  weekDays,
  weekTitle,
} from './time-model';

// Wednesday 25 Nov 2026, local noon, so day buckets do not depend on the time zone of the test run.
const NOW = new Date(2026, 10, 25, 12, 0, 0).getTime();
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 10, day, hour, minute).getTime();

const entry = (id: string, issueId: string | null, from: number, to: number | null): TimeEntry =>
  ({
    id,
    workspaceId: 'w',
    userId: 'u',
    projectId: null,
    issueId,
    description: '',
    startedAt: new Date(from).toISOString(),
    endedAt: to === null ? null : new Date(to).toISOString(),
    createdAt: '',
    updatedAt: '',
  }) as TimeEntry;

const issue = (id: string, patch: Partial<Issue> = {}): Issue =>
  ({
    id,
    key: `T-${id}`,
    title: `Task ${id}`,
    status: 'todo',
    milestoneIds: [],
    labels: [],
    aliases: [],
    ...patch,
  }) as Issue;

describe('formatting', () => {
  it('writes hours and minutes', () => {
    expect(hm(3 * HOUR + 10 * 60_000)).toBe('3:10');
    expect(hoursMinutes(12 * HOUR + 22 * 60_000)).toBe('12h 22m');
    expect(hoursMinutes(5 * HOUR)).toBe('5h');
    expect(hoursMinutes(42 * 60_000)).toBe('42m');
    expect(hoursShort(6.3 * HOUR)).toBe('6.3h');
    expect(hoursShort(13.4 * HOUR)).toBe('13h');
  });
});

describe('weeks', () => {
  it('starts on the chosen day', () => {
    expect(new Date(mondayOf(NOW)).getDate()).toBe(23);
    expect(new Date(mondayOf(NOW, 0)).getDate()).toBe(22);
  });

  it('lists seven days and marks today and the future', () => {
    const days = weekDays(mondayOf(NOW), NOW);
    expect(days.map((d) => d.label)).toEqual(['MON 23', 'TUE 24', 'WED 25', 'THU 26', 'FRI 27', 'SAT 28', 'SUN 29']);
    expect(days.filter((d) => d.today).map((d) => d.label)).toEqual(['WED 25']);
    expect(days.filter((d) => d.future)).toHaveLength(4);
    expect(weekTitle(mondayOf(NOW))).toBe('Week 48 · Nov 23 – 29');
  });
});

describe('timesheet grid', () => {
  const days = weekDays(mondayOf(NOW), NOW);
  const issues = new Map([
    ['a', issue('a')],
    ['b', issue('b', { parentId: 'a' })],
    ['c', issue('c')],
  ]);

  it('sums a task per day and puts subtasks under their parent, other time last', () => {
    const segs = segments(
      [
        entry('1', 'c', at(23, 9), at(23, 10)),
        entry('2', 'a', at(23, 9), at(23, 12)),
        entry('3', 'b', at(24, 9), at(24, 10)),
        entry('4', null, at(24, 14), at(24, 14, 20)),
        entry('5', 'a', at(24, 9), at(24, 9, 30)),
      ],
      NOW,
    );
    const grid = buildGrid(segs, days, issues);
    expect(grid.rows.map((r) => `${r.id}${r.depth ? '*' : ''}`)).toEqual(['a', 'b*', 'c', 'other']);
    expect(grid.rows[0].cells.slice(0, 2)).toEqual([3 * HOUR, 0.5 * HOUR]);
    expect(grid.dayTotals[0]).toBe(4 * HOUR);
    expect(grid.total).toBe(3 * HOUR + 0.5 * HOUR + HOUR + HOUR + 20 * 60_000);
  });

  it('splits an entry that crosses midnight and counts a running timer up to now', () => {
    const segs = segments([entry('1', 'a', at(23, 23), at(24, 1)), entry('2', 'a', at(25, 11), null)], NOW);
    const grid = buildGrid(segs, days, issues);
    expect(grid.rows[0].cells.slice(0, 3)).toEqual([HOUR, HOUR, HOUR]);
    expect(grid.rows[0].running).toBe(true);
    expect(entriesOnDay(segs, days[1])).toHaveLength(1);
    expect(entriesOnDay(segs, days[1])[0].ms).toBe(HOUR);
  });
});

describe('report days', () => {
  it('leaves weekends out unless time was tracked on one', () => {
    const quiet = reportDays(segments([entry('1', 'a', at(23, 9), at(23, 10))], NOW), 2, NOW, () => 'p');
    expect(quiet).toHaveLength(10);
    expect(quiet[0].weekLabel).toBe('W47');
    expect(quiet[5].weekLabel).toBe('W48 · this week');
    const busy = reportDays(segments([entry('1', 'a', at(21, 9), at(21, 10))], NOW), 2, NOW, () => 'p');
    expect(busy).toHaveLength(14);
  });
});

describe('estimates against hours', () => {
  const done = (id: string, points: number, hours: number) => ({
    issue: issue(id, { status: 'done', estimate: points, completedAt: new Date(NOW).toISOString() }),
    ms: hours * HOUR,
  });

  it('learns a range per estimate value and judges tasks against it', () => {
    const rows = valueRows([done('1', 3, 8), done('2', 3, 10), done('3', 3, 11), done('4', 3, 12), done('5', 3, 40), done('6', 1, 2)]);
    expect(rows.map((r) => r.points)).toEqual([1, 3]);
    expect(rows[0].band).toBeNull();
    expect(rows[1].median).toBe(11 * HOUR);
    const summary = summarize(rows);
    expect(summary.tasks).toBe(6);
    expect(summary.points).toBe(16);
    // 3-point row: [8, 10, 11, 12, 40] with the middle 80% at 8.8h–28.8h, so 8h and 40h are outside; the 1-point row has no range.
    expect(summary.within).toBe(60);
  });

  it('only counts done tasks with an estimate and finished time', () => {
    const issues = [
      issue('a', { status: 'done', estimate: 2, completedAt: new Date(NOW).toISOString() }),
      issue('b', { status: 'in_progress', estimate: 2 }),
      issue('c', { status: 'done', completedAt: new Date(NOW).toISOString() }),
    ];
    const tracked = trackedByTask(
      segments([entry('1', 'a', at(23, 9), at(23, 11)), entry('2', 'b', at(23, 9), at(23, 11)), entry('3', 'a', at(25, 11), null)], NOW),
    );
    expect(tracked.get('a')).toBe(2 * HOUR);
    expect(doneSamples(issues, tracked).map((s) => s.issue.id)).toEqual(['a']);
    expect(doneSamples(issues, tracked, { from: at(24, 0), to: at(26, 0) }).map((s) => s.issue.id)).toEqual(['a']);
    expect(doneSamples(issues, tracked, { from: at(1, 0), to: at(2, 0) })).toEqual([]);
  });
});
