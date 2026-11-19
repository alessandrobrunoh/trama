import type { TimeEntry } from '../../core/api/api.types';
import { atTime, clock, entriesOf, entryProblem, runningEntry, timeOf, trackedOn } from './task-time-model';

const NOW = new Date(2026, 10, 19, 15, 0, 0).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).toISOString();

function entry(id: string, issueId: string, startedAt: string, endedAt: string | null): TimeEntry {
  return {
    id,
    workspaceId: 'w',
    userId: 'u',
    projectId: null,
    issueId,
    description: '',
    startedAt,
    endedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
}

describe('trackedOn', () => {
  it('splits today from the total and ignores other tasks', () => {
    const list = [
      entry('a', 't1', at(18, 9), at(18, 11)), // 2h yesterday
      entry('b', 't1', at(19, 9), at(19, 9, 30)), // 30m today
      entry('c', 't2', at(19, 9), at(19, 12)),
    ];
    const t = trackedOn(list, 't1', NOW);
    expect(t.totalMs).toBe(2.5 * 3_600_000);
    expect(t.todayMs).toBe(30 * 60_000);
    expect(t.runningMs).toBe(0);
  });

  it('counts a running timer up to now', () => {
    const t = trackedOn([entry('r', 't1', at(19, 14), null)], 't1', NOW);
    expect(t.runningMs).toBe(3_600_000);
    expect(t.todayMs).toBe(3_600_000);
  });

  it('cuts an entry that crossed midnight at the start of today', () => {
    const t = trackedOn([entry('n', 't1', at(18, 23), at(19, 1))], 't1', NOW);
    expect(t.totalMs).toBe(2 * 3_600_000);
    expect(t.todayMs).toBe(3_600_000);
  });

  it('skips broken entries', () => {
    expect(trackedOn([entry('x', 't1', at(19, 10), at(19, 9))], 't1', NOW).totalMs).toBe(0);
  });
});

describe('entries', () => {
  const list = [entry('a', 't1', at(18, 9), at(18, 10)), entry('b', 't1', at(19, 9), null), entry('c', 't2', at(19, 8), at(19, 9))];

  it('lists a task newest first', () => {
    expect(entriesOf(list, 't1').map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('finds the running timer anywhere', () => {
    expect(runningEntry(list)?.id).toBe('b');
    expect(runningEntry([list[0]])).toBeNull();
  });
});

describe('clock and times', () => {
  it('formats the clock', () => {
    expect(clock(3_723_000)).toBe('01:02:03');
    expect(clock(-5)).toBe('00:00:00');
  });

  it('round-trips a time of day', () => {
    expect(timeOf(atTime(new Date(NOW), '09:05').toISOString())).toBe('09:05');
  });

  it('rejects entries that cannot be saved', () => {
    const day = new Date(NOW);
    expect(entryProblem(day, '', '10:00', NOW)).toBeTruthy();
    expect(entryProblem(day, '10:00', '09:00', NOW)).toMatch(/after/);
    expect(entryProblem(day, '16:00', '17:00', NOW)).toMatch(/future/);
    expect(entryProblem(day, '09:00', '10:00', NOW)).toBeNull();
  });
});
