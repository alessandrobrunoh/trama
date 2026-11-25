import { addDays, differenceInCalendarDays, format } from 'date-fns';
import {
  approxDuration,
  axisBands,
  buildScale,
  compareSpans,
  dateEndX,
  dateX,
  forecastProject,
  frameBands,
  projectSpan,
  taskSpan,
  type ForecastInput,
  type ForecastTask,
} from './timeline-model';

// Thursday 19 November 2026, local time.
const NOW = new Date(2026, 10, 19, 12);
const day = (offset: number): string => format(addDays(NOW, offset), 'yyyy-MM-dd');

/** `closedDaysAgo` tasks finished on the given days before now, plus `open` open ones. */
function tasks(closedDaysAgo: number[], open: number, canceled = 0): ForecastTask[] {
  return [
    ...closedDaysAgo.map((d): ForecastTask => ({ state: 'done', completedAt: day(-d) })),
    ...Array.from({ length: open }, (): ForecastTask => ({ state: 'open' })),
    ...Array.from({ length: canceled }, (): ForecastTask => ({ state: 'canceled' })),
  ];
}

/** Twelve tasks closed in the last six weeks: two a week. */
const TWO_PER_WEEK = [1, 4, 8, 11, 15, 18, 22, 25, 29, 32, 36, 39];

function input(patch: Partial<ForecastInput>): ForecastInput {
  return { now: NOW, startDate: day(-70), targetDate: day(30), tasks: [], ...patch };
}

describe('forecastProject', () => {
  it('is on track when the projected end is before the target', () => {
    // 6 open at 2 per week: 21 days, a week and a half before a target 30 days out.
    const f = forecastProject(input({ tasks: tasks(TWO_PER_WEEK, 6) }));
    expect(f.signal).toBe('on_track');
    expect(f.perWeek).toBeCloseTo(2);
    expect(f.daysToFinish).toBe(21);
    expect(f.daysVsTarget).toBe(-9);
    expect(f.projectedEnd && format(f.projectedEnd, 'yyyy-MM-dd')).toBe(day(21));
    expect(f.done).toBe(12);
    expect(f.total).toBe(18);
  });

  it('is on track when it finishes exactly on the target date', () => {
    const f = forecastProject(input({ targetDate: day(21), tasks: tasks(TWO_PER_WEEK, 6) }));
    expect(f.signal).toBe('on_track');
    expect(f.daysVsTarget).toBe(0);
  });

  it('is at risk when the projection is within a week of the target', () => {
    // 8 open: 28 days, 2 days after a target 26 days out.
    const f = forecastProject(input({ targetDate: day(26), tasks: tasks(TWO_PER_WEEK, 8) }));
    expect(f.signal).toBe('at_risk');
    expect(f.daysVsTarget).toBe(2);
    expect(f.label).toContain('2 days late');
  });

  it('is at risk up to 10% of the planned duration over, when that is more than a week', () => {
    // Planned 70 + 100 = 170 days, so 17 days of slack. 8 open = 28 days, target 12 days out: 16 over.
    const slack = forecastProject(
      input({ startDate: day(-170), targetDate: day(12), tasks: tasks(TWO_PER_WEEK, 8) }),
    );
    expect(slack.daysVsTarget).toBe(16);
    expect(slack.signal).toBe('at_risk');
    // 10 days later it would be 26 over: off track.
    const over = forecastProject(
      input({ startDate: day(-170), targetDate: day(2), tasks: tasks(TWO_PER_WEEK, 8) }),
    );
    expect(over.daysVsTarget).toBe(26);
    expect(over.signal).toBe('off_track');
  });

  it('is off track when the projection is far past the target', () => {
    // 20 open: 70 days, 40 after the target.
    const f = forecastProject(input({ tasks: tasks(TWO_PER_WEEK, 20) }));
    expect(f.signal).toBe('off_track');
    expect(f.daysVsTarget).toBe(40);
    expect(f.explanation).toContain('At this pace');
    expect(f.explanation).toContain('40 days after target');
  });

  it('is off track when the target passed with open work, even without a pace', () => {
    const f = forecastProject(input({ targetDate: day(-5), tasks: tasks([2], 3) }));
    expect(f.signal).toBe('off_track');
    expect(f.projectedEnd).toBeUndefined();
    expect(f.label).toBe('5 days past target');
    expect(f.explanation).toContain('3 tasks are still open');
  });

  it('does not flag a passed target once every task is closed', () => {
    const f = forecastProject(input({ targetDate: day(-5), tasks: tasks(TWO_PER_WEEK, 0) }));
    expect(f.signal).toBe('on_track');
    expect(f.label).toBe('All tasks done');
    expect(f.explanation).toContain('5 days after the target');
  });

  it('says there is not enough data when too few tasks were closed', () => {
    const f = forecastProject(input({ tasks: tasks([3], 10) }));
    expect(f.signal).toBe('not_enough_data');
    expect(f.projectedEnd).toBeUndefined();
    expect(f.explanation).toContain('Only 1 task closed in the last 6 weeks');
  });

  it('ignores tasks closed before the measuring window', () => {
    const f = forecastProject(input({ tasks: tasks([50, 60, 70], 4) }));
    expect(f.closedInWindow).toBe(0);
    expect(f.signal).toBe('not_enough_data');
  });

  it('has not enough data without any task', () => {
    const f = forecastProject(input({ tasks: [] }));
    expect(f.signal).toBe('not_enough_data');
    expect(f.explanation).toContain('No tasks yet');
  });

  it('measures a young project over its own age, not six weeks', () => {
    // Started two weeks ago and closed 4 tasks: 2 per week, not 0.67.
    const f = forecastProject(input({ startDate: day(-14), tasks: tasks([1, 3, 6, 10], 4) }));
    expect(f.windowWeeks).toBe(2);
    expect(f.perWeek).toBe(2);
    expect(f.daysToFinish).toBe(14);
  });

  it('keeps the window at one week for a project that just started', () => {
    const f = forecastProject(input({ startDate: day(0), tasks: tasks([0, 0, 0], 3) }));
    expect(f.windowWeeks).toBe(1);
    expect(f.perWeek).toBe(3);
  });

  it('leaves canceled tasks out of the counts', () => {
    const f = forecastProject(input({ tasks: tasks(TWO_PER_WEEK, 6, 5) }));
    expect(f.total).toBe(18);
    expect(f.open).toBe(6);
  });

  it('projects without a target but gives no verdict', () => {
    const f = forecastProject(input({ targetDate: undefined, tasks: tasks(TWO_PER_WEEK, 6) }));
    expect(f.signal).toBe('no_target');
    expect(f.projectedEnd).toBeDefined();
    expect(f.daysVsTarget).toBeUndefined();
  });

  it('gives closed projects no signal', () => {
    const f = forecastProject(input({ closed: true, tasks: tasks(TWO_PER_WEEK, 6) }));
    expect(f.signal).toBe('closed');
  });

  it('describes the pace in plain words', () => {
    const f = forecastProject(input({ targetDate: day(12), tasks: tasks(TWO_PER_WEEK, 6) }));
    expect(f.explanation).toMatch(/^At this pace \(2 per week\): ~3 weeks for 6 open tasks, ends \d+ \w+/);
    expect(f.explanation).toContain('9 days after target');
  });
});

describe('approxDuration', () => {
  it('uses days, weeks and months', () => {
    expect(approxDuration(1)).toBe('~1 day');
    expect(approxDuration(5)).toBe('~5 days');
    expect(approxDuration(21)).toBe('~3 weeks');
    expect(approxDuration(120)).toBe('~4 months');
  });
});

describe('projectSpan', () => {
  it('uses the start and target dates', () => {
    const s = projectSpan({ startDate: '2026-11-02', targetDate: '2026-12-11' }, NOW);
    expect(s && format(s.start, 'yyyy-MM-dd')).toBe('2026-11-02');
    expect(s && format(s.end, 'yyyy-MM-dd')).toBe('2026-12-11');
  });

  it('starts at creation when only a target is set', () => {
    const s = projectSpan({ targetDate: '2026-12-11', createdAt: '2026-10-01T09:00:00Z' }, NOW);
    expect(s && differenceInCalendarDays(s.end, s.start)).toBeGreaterThan(60);
  });

  it('runs a start-only project up to today', () => {
    const s = projectSpan({ startDate: '2026-11-02' }, NOW);
    expect(s && format(s.end, 'yyyy-MM-dd')).toBe('2026-11-19');
  });

  it('has no span without dates, and sorts those last', () => {
    expect(projectSpan({}, NOW)).toBeUndefined();
    const early = projectSpan({ startDate: '2026-01-01', targetDate: '2026-02-01' }, NOW);
    const late = projectSpan({ startDate: '2026-05-01', targetDate: '2026-06-01' }, NOW);
    expect([undefined, late, early].sort(compareSpans)).toEqual([early, late, undefined]);
  });

  it('swaps a start that is after the target', () => {
    const s = projectSpan({ startDate: '2026-12-11', targetDate: '2026-11-02' }, NOW);
    expect(s && s.start <= s.end).toBe(true);
  });
});

describe('time scale', () => {
  const target = new Date(2026, 11, 31);

  it('covers the data and today, with whole weeks or months at the edges', () => {
    const week = buildScale('week', [target], NOW, 1);
    expect(week.origin.getDay()).toBe(1);
    expect(week.origin <= NOW).toBe(true);
    expect(week.end >= target).toBe(true);
    expect(week.width).toBeCloseTo(week.days * week.pxPerDay);

    const quarter = buildScale('quarter', [target], NOW, 1);
    expect(quarter.origin.getDate()).toBe(1);
    expect([0, 3, 6, 9]).toContain(quarter.origin.getMonth());
    expect(quarter.end.getMonth() % 3).toBe(2);
  });

  it('maps a date to the left edge of its day and its end to the next day', () => {
    const scale = buildScale('month', [], NOW, 1);
    expect(dateX(scale, scale.origin)).toBe(0);
    expect(dateX(scale, addDays(scale.origin, 10))).toBeCloseTo(10 * scale.pxPerDay);
    expect(dateEndX(scale, scale.origin)).toBeCloseTo(scale.pxPerDay);
  });

  it('makes zoomed-out scales narrower per day', () => {
    const w = buildScale('week', [target], NOW).pxPerDay;
    const m = buildScale('month', [target], NOW).pxPerDay;
    const q = buildScale('quarter', [target], NOW).pxPerDay;
    expect(w).toBeGreaterThan(m);
    expect(m).toBeGreaterThan(q);
  });

  it('tiles each axis row without gaps or overlap', () => {
    for (const zoom of ['week', 'month', 'quarter'] as const) {
      const scale = buildScale(zoom, [target], NOW, 1);
      const { upper, lower } = axisBands(scale, 1);
      for (const row of [upper, lower]) {
        expect(row[0].x).toBe(0);
        for (let i = 1; i < row.length; i++) {
          expect(row[i].x).toBeCloseTo(row[i - 1].x + row[i - 1].width);
        }
        const last = row[row.length - 1];
        expect(last.x + last.width).toBeCloseTo(scale.width);
      }
    }
  });

  it('labels months over days in week zoom and quarters over months in quarter zoom', () => {
    const week = axisBands(buildScale('week', [target], NOW, 1), 1);
    expect(week.upper.some((b) => b.label === 'November 2026')).toBe(true);
    expect(week.lower.find((b) => b.start.getDate() === 19)?.label).toBe('T 19');
    const quarter = axisBands(buildScale('quarter', [target], NOW, 1), 1);
    expect(quarter.upper.some((b) => b.label === 'Q4 2026')).toBe(true);
    expect(quarter.lower.some((b) => b.label === 'Nov')).toBe(true);
  });
});

describe('v3 axis header', () => {
  const target = new Date(2026, 11, 31);

  it('draws week bands over days in week and month zoom', () => {
    for (const zoom of ['week', 'month'] as const) {
      const { upper, lower } = frameBands(buildScale(zoom, [target], NOW, 1), 1);
      expect(upper.find((b) => b.start.getDate() === 23 && b.start.getMonth() === 10)).toMatchObject({
        label: 'W48',
        sub: 'Nov 23 – 29',
      });
      expect(upper.find((b) => b.start.getDate() === 30)?.sub).toBe('Nov 30 – Dec 6');
      expect(lower.find((b) => b.start.getDate() === 21 && b.start.getMonth() === 10)).toMatchObject({
        label: '21',
        sub: 'S',
        quiet: true,
      });
      expect(lower.find((b) => b.start.getDate() === 19 && b.start.getMonth() === 10)).toMatchObject({
        label: '19',
        sub: 'T',
        quiet: false,
      });
    }
  });

  it('draws months over week starts in quarter zoom and tiles both rows', () => {
    const scale = buildScale('quarter', [target], NOW, 1);
    const { upper, lower } = frameBands(scale, 1);
    expect(upper.find((b) => b.start.getMonth() === 10)).toMatchObject({ label: 'November', sub: '2026' });
    for (const row of [upper, lower]) {
      for (let i = 1; i < row.length; i++) {
        expect(row[i].x).toBeCloseTo(row[i - 1].x + row[i - 1].width);
      }
      const last = row[row.length - 1];
      expect(last.x + last.width).toBeCloseTo(scale.width);
    }
  });

  it('snaps week and month scales to whole weeks', () => {
    for (const zoom of ['week', 'month'] as const) {
      const scale = buildScale(zoom, [target], NOW, 1);
      expect(scale.origin.getDay()).toBe(1);
      expect(scale.days % 7).toBe(0);
    }
  });
});

describe('task span', () => {
  const at = (offset: number): string => day(offset);

  it('runs from the start of work to the due date', () => {
    const span = taskSpan({ startedAt: at(-3), dueDate: at(4), open: true }, NOW);
    expect(differenceInCalendarDays(span!.end, span!.start)).toBe(7);
  });

  it('runs an open task without a due date up to today', () => {
    const span = taskSpan({ startedAt: at(-3), open: true }, NOW);
    expect(differenceInCalendarDays(span!.end, span!.start)).toBe(3);
  });

  it('ends a closed task when it was closed', () => {
    const span = taskSpan({ startedAt: at(-10), dueDate: at(5), completedAt: at(-2), open: false }, NOW);
    expect(differenceInCalendarDays(span!.end, span!.start)).toBe(8);
  });

  it('marks a task that only has a due date as a single day', () => {
    const span = taskSpan({ dueDate: at(6), open: true }, NOW);
    expect(span!.start.getTime()).toBe(span!.end.getTime());
  });

  it('puts no bar on a task without dates and never draws a negative bar', () => {
    expect(taskSpan({ open: true }, NOW)).toBeUndefined();
    const span = taskSpan({ startedAt: at(5), dueDate: at(1), open: true }, NOW);
    expect(span!.start <= span!.end).toBe(true);
  });
});
