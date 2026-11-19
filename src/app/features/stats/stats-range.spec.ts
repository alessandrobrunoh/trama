import { DAY, bucketIndex, buckets, previousRange, resolveRange, sampleTimes } from './stats-range';
import { NOW } from './stats-fixtures';

describe('resolveRange', () => {
  it('ends a fixed period now and starts that many days earlier', () => {
    const r = resolveRange('30d', NOW);
    expect(r.to).toBe(NOW + 1);
    expect(r.to - r.from).toBe(30 * DAY);
    expect(r.days).toBe(30);
    expect(r.custom).toBe(false);
  });

  it('reads a custom range as whole local days, end day included', () => {
    const r = resolveRange('custom', NOW, '2026-03-01', '2026-03-10');
    expect(r.custom).toBe(true);
    expect(r.days).toBe(10);
    expect(new Date(r.from).getDate()).toBe(1);
    expect(new Date(r.to - 1).getDate()).toBe(10);
  });

  it('puts swapped dates right and never reaches into the future', () => {
    const swapped = resolveRange('custom', NOW, '2026-03-10', '2026-03-01');
    expect(swapped.days).toBe(10);
    const future = resolveRange('custom', NOW, '2026-03-10', '2026-12-31');
    expect(future.to).toBe(NOW + 1);
  });

  it('cuts a range over a year to its last year', () => {
    const r = resolveRange('custom', NOW, '2020-01-01', '2026-03-10');
    expect(r.days).toBeLessThanOrEqual(366);
  });

  it('falls back to the default period when the custom dates are unreadable', () => {
    expect(resolveRange('custom', NOW, 'nope', null).days).toBe(30);
    expect(resolveRange('custom', NOW, '2027-01-01', '2027-02-01').days).toBe(30);
  });
});

describe('previousRange', () => {
  it('is the same length and ends where the range starts', () => {
    const r = resolveRange('7d', NOW);
    const p = previousRange(r);
    expect(p.to).toBe(r.from);
    expect(p.to - p.from).toBe(7 * DAY);
  });
});

describe('buckets', () => {
  it('uses one bucket per day for a short range, today last', () => {
    const { unit, items } = buckets(resolveRange('7d', NOW));
    expect(unit).toBe('day');
    expect(items).toHaveLength(7);
    expect(items[6].from).toBeLessThanOrEqual(NOW);
    expect(items[6].to).toBeGreaterThan(NOW);
  });

  it('uses trailing weeks that cover a long range', () => {
    const { unit, items } = buckets(resolveRange('30d', NOW));
    expect(unit).toBe('week');
    expect(items).toHaveLength(5);
    expect(items[4].to).toBe(NOW + 1);
    expect(items[1].from).toBe(items[0].to);
    expect(buckets(resolveRange('90d', NOW)).items).toHaveLength(13);
  });

  it('finds the bucket of a moment', () => {
    const { items } = buckets(resolveRange('30d', NOW));
    expect(bucketIndex(items, NOW)).toBe(4);
    expect(bucketIndex(items, NOW - 8 * DAY)).toBe(3);
    expect(bucketIndex(items, NOW - 400 * DAY)).toBe(-1);
    expect(bucketIndex(items, undefined)).toBe(-1);
  });
});

describe('sampleTimes', () => {
  it('ends at now and is thinned for a long range', () => {
    const short = sampleTimes(resolveRange('30d', NOW), NOW);
    expect(short[short.length - 1]).toBe(NOW);
    expect(short.length).toBeGreaterThanOrEqual(30);
    const long = sampleTimes(resolveRange('custom', NOW, '2025-03-21', '2026-03-20'), NOW, 90);
    expect(long.length).toBeLessThanOrEqual(95);
    expect(long[long.length - 1]).toBe(NOW);
  });
});
