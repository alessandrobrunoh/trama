import { describe, expect, it } from 'vitest';
import type { Demand } from '../contracts/domain.js';
import { applyFilters, groupItems, matchesFilter, sortItems } from './view-query.js';

const demand = (over: Partial<Demand>): Demand => ({
  customerIds: [],
  customerCount: 0,
  requestCount: 0,
  importantCount: 0,
  tierIds: [],
  revenue: 0,
  size: 0,
  ...over,
});

const rows = [
  { id: 'in_a', title: 'A' },
  { id: 'in_b', title: 'B' },
  { id: 'in_c', title: 'C' },
];
const ctx = {
  demand: new Map<string, Demand>([
    ['in_a', demand({ customerIds: ['cus_1', 'cus_2'], customerCount: 2, requestCount: 3, tierIds: ['ct_gold'], revenue: 150_000 })],
    ['in_b', demand({ customerIds: ['cus_1'], customerCount: 1, requestCount: 1, revenue: 100_000 })],
  ]),
};

describe('customer demand in a view', () => {
  it('filters numbers with at least / at most, comparing as numbers', () => {
    const gte = (field: string, value: string) => applyFilters('issue', rows, [{ field, op: 'gte', value }], ctx).map((r) => r.id);
    expect(gte('customerCount', '2')).toEqual(['in_a']);
    expect(gte('requestCount', '1')).toEqual(['in_a', 'in_b']);
    expect(gte('customerRevenue', '99999')).toEqual(['in_a', 'in_b']);
    expect(gte('customerRevenue', '1000000')).toEqual([]);
    // "9" is not more than "10" as text, but it is as a number.
    expect(applyFilters('issue', rows, [{ field: 'customerRevenue', op: 'lte', value: '9' }], ctx).map((r) => r.id)).toEqual(['in_c']);
  });

  it('filters by customer and tier like any other id field', () => {
    expect(applyFilters('issue', rows, [{ field: 'customerId', op: 'in', value: ['cus_2'] }], ctx).map((r) => r.id)).toEqual(['in_a']);
    expect(applyFilters('issue', rows, [{ field: 'customerTierId', op: 'in', value: ['ct_gold'] }], ctx).map((r) => r.id)).toEqual(['in_a']);
  });

  it('sorts by demand, biggest first when descending', () => {
    expect(sortItems('issue', rows, { field: 'customerRevenue', direction: 'desc' }, ctx).map((r) => r.id)).toEqual(['in_a', 'in_b', 'in_c']);
  });

  it('never groups by a customer field, so no customer is named', () => {
    expect(groupItems('issue', rows, 'customerId', ctx)).toEqual([{ key: '', items: rows }]);
    expect(groupItems('issue', rows, 'customerTierId', ctx)).toEqual([{ key: '', items: rows }]);
  });

  it('has no customer values without demand data, and numeric operators on them match nothing', () => {
    expect(applyFilters('issue', rows, [{ field: 'customerCount', op: 'gte', value: '0' }], {})).toEqual([]);
  });

  it('fails closed on an operator it does not know', () => {
    expect(matchesFilter('issue', rows[0], { field: 'title', op: 'bogus' as never, value: 'A' })).toBe(false);
  });

  it('applies to projects too, and not to workstreams', () => {
    const projects = [{ id: 'pj_a', name: 'P' }];
    const withDemand = { demand: new Map([['pj_a', demand({ customerCount: 4 })]]) };
    expect(applyFilters('project', projects, [{ field: 'customerCount', op: 'gte', value: '3' }], withDemand)).toHaveLength(1);
    expect(applyFilters('workstream', [{ id: 'wk_a' }], [{ field: 'customerCount', op: 'gte', value: '0' }], withDemand)).toEqual([]);
  });
});
