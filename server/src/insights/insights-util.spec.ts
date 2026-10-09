import { describe, expect, it } from 'vitest';
import { actorOf, durationStats, histogram, percentile, round1, span } from './insights-util.js';

describe('percentile (nearest rank)', () => {
  it('is undefined without samples', () => {
    expect(percentile([], 50)).toBeUndefined();
  });

  it('returns the only sample for every percentile', () => {
    expect(percentile([4], 50)).toBe(4);
    expect(percentile([4], 85)).toBe(4);
    expect(percentile([4], 99)).toBe(4);
  });

  it('picks observed values', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(xs, 50)).toBe(5);
    expect(percentile(xs, 85)).toBe(9);
    expect(percentile(xs, 95)).toBe(10);
    expect(percentile(xs, 100)).toBe(10);
    expect(percentile(xs, 0)).toBe(1);
  });
});

describe('durationStats', () => {
  it('reports only the count when nothing was measured', () => {
    expect(durationStats([])).toEqual({ count: 0 });
  });

  it('ignores negative and non-finite samples and sorts its input', () => {
    const s = durationStats([5, 1, -2, Number.NaN, 3, Infinity]);
    expect(s.count).toBe(3);
    expect(s.p50).toBe(3);
    expect(s.max).toBe(5);
    expect(s.mean).toBe(3);
  });

  it('keeps zero-length durations', () => {
    expect(durationStats([0, 0])).toMatchObject({ count: 2, p50: 0, p85: 0, mean: 0 });
  });

  it('does not mutate the input', () => {
    const xs = [3, 1, 2];
    durationStats(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('histogram', () => {
  it('always returns the six buckets', () => {
    const h = histogram([]);
    expect(h.map((b) => b.label)).toEqual(['< 1d', '1–3d', '3–7d', '1–2w', '2–4w', '4w+']);
    expect(h.every((b) => b.count === 0)).toBe(true);
    expect(h[5].to).toBeUndefined();
  });

  it('puts boundary values in the upper bucket', () => {
    const h = histogram([0, 0.9, 1, 2.9, 3, 7, 14, 28, 400]);
    expect(h.map((b) => b.count)).toEqual([2, 2, 1, 1, 1, 2]);
  });

  it('skips junk', () => {
    expect(histogram([-1, Number.NaN]).reduce((n, b) => n + b.count, 0)).toBe(0);
  });
});

describe('formatting helpers', () => {
  it('rounds to one decimal without negative zero', () => {
    expect(round1(1.26)).toBe(1.3);
    expect(Object.is(round1(-0.01), -0)).toBe(false);
  });

  it('writes spans', () => {
    expect(span(0.001)).toBe('<1h');
    expect(span(0.5)).toBe('12h');
    expect(span(2.34)).toBe('2.3d');
    expect(span(12.4)).toBe('12d');
  });

  it('resolves actors, with a fallback for unknown ids and nobody', () => {
    const names = new Map([['u1', { name: 'Ada', type: 'user' as const }], ['a1', { name: 'Bot', type: 'agent' as const }]]);
    expect(actorOf('u1', names)).toEqual({ type: 'user', id: 'u1', name: 'Ada' });
    expect(actorOf('a1', names)).toEqual({ type: 'agent', id: 'a1', name: 'Bot' });
    expect(actorOf('zzz', names).name).toBe('zzz');
    expect(actorOf(null, names).type).toBe('unassigned');
  });
});
