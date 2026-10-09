import { describe, expect, it } from 'vitest';
import { demandConditions } from './demand-filter.js';

describe('demandConditions', () => {
  it('adds nothing without filters', () => {
    expect(demandConditions('i', 'issueId', {})).toEqual([]);
  });

  it('scopes every subquery to the row and its workspace', () => {
    const conds = demandConditions('p', 'projectId', { customerId: 'cus_1', tierId: 'ct_1', minCustomers: 2, minRequests: 3, minRevenue: 50000, important: true });
    expect(conds).toHaveLength(6);
    for (const c of conds) {
      expect(c.sql).toContain('cr."workspaceId" = p."workspaceId"');
      expect(c.sql).toContain('cr."projectId" = p.id');
      expect(c.sql).not.toContain('cus_1');
    }
  });

  it('passes values as named parameters, never in the SQL text', () => {
    const conds = demandConditions('i', 'issueId', { customerId: "x'; DROP TABLE", tierId: 't', minCustomers: 2.7, minRequests: 4, minRevenue: 1000 });
    expect(Object.assign({}, ...conds.map((c) => c.params))).toEqual({
      dmCustomerId: "x'; DROP TABLE",
      dmTierId: 't',
      dmMinCustomers: 2,
      dmMinRequests: 4,
      dmMinRevenue: 1000,
    });
    expect(conds.some((c) => c.sql.includes('DROP'))).toBe(false);
  });

  it('counts a customer once for revenue and for the customer threshold', () => {
    const [customers] = demandConditions('i', 'issueId', { minCustomers: 2 });
    expect(customers.sql).toContain('COUNT(DISTINCT cr."customerId")');
    const [revenue] = demandConditions('i', 'issueId', { minRevenue: 1 });
    expect(revenue.sql).toContain('c.id IN (SELECT cr."customerId"');
  });

  it('ignores thresholds that are not positive numbers and important=false', () => {
    expect(demandConditions('i', 'issueId', { minCustomers: 0, minRequests: Number.NaN, minRevenue: -5, important: false })).toEqual([]);
  });

  it('refuses an alias that is not a plain identifier', () => {
    expect(() => demandConditions('i; DROP', 'issueId', { important: true })).toThrow();
  });
});
