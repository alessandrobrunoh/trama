import {
  MIN_FOR_TAIL,
  closedPerBucket,
  createdPerBucket,
  cumulativeFlow,
  cycleDays,
  durations,
  histogram,
  leadDays,
  medianPerBucket,
  percentiles,
  rollingMean,
  stateAt,
  wipOverTime,
  completedInRange,
} from './stats-flow';
import { NOW, finished, iso, issue } from './stats-fixtures';
import { DAY, buckets, resolveRange } from './stats-range';

describe('percentiles', () => {
  it('has a median from one value on, tail percentiles only from MIN_FOR_TAIL', () => {
    expect(percentiles([])).toEqual({ n: 0 });
    const few = percentiles([1, 9]);
    expect(few.median).toBe(5);
    expect(few.p75).toBeUndefined();
    expect(few.p90).toBeUndefined();
    const many = percentiles(Array.from({ length: MIN_FOR_TAIL }, (_, i) => i + 1));
    expect(many.median).toBe(3);
    expect(many.p75).toBe(4);
    expect(many.p90).toBeCloseTo(4.6);
  });

  it('is not moved by one forgotten outlier the way a mean is', () => {
    const p = percentiles([1, 2, 2, 3, 400]);
    expect(p.median).toBe(2);
  });

  it('ignores values that are not numbers and does not sort the caller array', () => {
    const input = [3, NaN, 1, 2];
    expect(percentiles(input).median).toBe(2);
    expect(input[0]).toBe(3);
  });
});

describe('cycle and lead time', () => {
  it('measures start to completion and creation to completion in days', () => {
    const t = finished('a', 10, 6, 2);
    expect(cycleDays(t)).toBeCloseTo(4);
    expect(leadDays(t)).toBeCloseTo(8);
  });

  it('has no cycle time for a task that never started or whose dates are backwards', () => {
    expect(cycleDays(finished('a', 10, undefined, 2))).toBeUndefined();
    expect(cycleDays(finished('b', 10, 1, 5))).toBeUndefined();
    expect(leadDays(finished('c', 1, 1, 5))).toBeUndefined();
  });

  it('counts only done tasks completed in the range, so canceled and open tasks cannot reach an average', () => {
    const range = resolveRange('30d', NOW);
    const issues = [
      finished('done', 20, 10, 3),
      finished('old', 90, 80, 60),
      issue('canceled', { status: 'canceled', startedAt: iso(-9), completedAt: iso(-1), createdAt: iso(-12) }),
      issue('open', { status: 'in_progress', startedAt: iso(-200), createdAt: iso(-250) }),
    ];
    const done = completedInRange(issues, range);
    expect(done.map((i) => i.id)).toEqual(['done']);
    expect(durations(done, cycleDays)).toEqual([7]);
  });
});

describe('histogram', () => {
  it('puts each value in the first class that is above it, the last class takes the rest', () => {
    const bins = histogram([0.5, 1, 1.5, 3, 6, 10, 20, 100, 400]);
    expect(bins).toEqual([1, 2, 1, 1, 1, 1, 2]);
    expect(bins.reduce((a, b) => a + b, 0)).toBe(9);
  });
});

describe('per bucket series', () => {
  const { items } = buckets(resolveRange('30d', NOW));

  it('counts created and closed per week, ignoring canceled tasks as closed', () => {
    const issues = [
      finished('a', 3, 2, 1),
      finished('b', 20, 15, 9),
      issue('c', { status: 'canceled', createdAt: iso(-2), completedAt: iso(-1) }),
    ];
    expect(closedPerBucket(issues, items)).toEqual([0, 0, 0, 1, 1]);
    expect(createdPerBucket(issues, items)).toEqual([0, 0, 1, 0, 2]);
  });

  it('rolls a mean over a full window only', () => {
    expect(rollingMean([1, 2, 3, 4], 2)).toEqual([null, 1.5, 2.5, 3.5]);
    expect(rollingMean([5], 4)).toEqual([null]);
  });

  it('takes the median per bucket and leaves null where nothing finished', () => {
    const issues = [finished('a', 20, 10, 1), finished('b', 20, 16, 2), finished('c', 30, 28, 9)];
    const series = medianPerBucket(issues, items, cycleDays);
    expect(series[4]).toBeCloseTo(11.5);
    expect(series[3]).toBeCloseTo(19);
    expect(series[2]).toBeNull();
  });
});

describe('state over time', () => {
  const t = finished('a', 20, 10, 3);

  it('is waiting, then active, then done, and nothing before it was created', () => {
    expect(stateAt(t, NOW - 25 * DAY, NOW)).toBe('none');
    expect(stateAt(t, NOW - 15 * DAY, NOW)).toBe('waiting');
    expect(stateAt(t, NOW - 5 * DAY, NOW)).toBe('active');
    expect(stateAt(t, NOW - 2 * DAY, NOW)).toBe('done');
    expect(stateAt(t, NOW, NOW)).toBe('done');
  });

  it('leaves canceled tasks out and uses the real status for the present', () => {
    expect(stateAt(issue('c', { status: 'canceled' }), NOW, NOW)).toBe('none');
    const movedBack = issue('m', { status: 'todo', createdAt: iso(-30), startedAt: iso(-10) });
    expect(stateAt(movedBack, NOW - 5 * DAY, NOW)).toBe('active');
    expect(stateAt(movedBack, NOW, NOW)).toBe('waiting');
  });

  it('adds up to the tasks that exist at every moment', () => {
    const issues = [t, issue('b', { createdAt: iso(-5) }), issue('c', { status: 'in_progress', createdAt: iso(-8), startedAt: iso(-4) })];
    const times = [NOW - 12 * DAY, NOW - 4.5 * DAY, NOW];
    const flow = cumulativeFlow(issues, times, NOW);
    const totals = times.map((_, i) => flow.waiting[i] + flow.active[i] + flow.done[i]);
    expect(totals).toEqual([1, 3, 3]);
    expect(flow.done).toEqual([0, 0, 1]);
  });

  it('counts work in progress but not the tasks that went stale', () => {
    const a = issue('a', { status: 'in_progress', createdAt: iso(-20), startedAt: iso(-18) });
    const b = issue('b', { status: 'in_progress', createdAt: iso(-20), startedAt: iso(-1) });
    expect(wipOverTime([a, b], [NOW - 5 * DAY, NOW], NOW)).toEqual([1, 2]);
    expect(wipOverTime([a, b], [NOW - 5 * DAY, NOW], NOW, new Set(['a']))).toEqual([0, 1]);
  });
});
