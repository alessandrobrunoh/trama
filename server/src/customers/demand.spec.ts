import { describe, expect, it } from 'vitest';
import {
  NO_DEMAND,
  buildDemandIndex,
  demandOf,
  isRequestDelivered,
  mergeDemand,
  type CustomerRequest,
} from '../contracts/domain.js';

const customers = new Map([
  ['cus_a', { tierId: 'ct_gold', revenue: 100_000, size: 500 }],
  ['cus_b', { tierId: 'ct_gold', revenue: 40_000, size: 20 }],
  ['cus_c', { tierId: undefined, revenue: undefined, size: undefined }],
]);

const req = (id: string, customerId: string, target: { issueId?: string; projectId?: string }, important = false): CustomerRequest =>
  ({ id, customerId, important, workspaceId: 'ws_1', createdBy: { type: 'user', id: 'u' }, createdAt: '', updatedAt: '', ...target }) as CustomerRequest;

describe('demandOf', () => {
  it('counts a customer once however often it asked, and sums revenue once', () => {
    const d = demandOf(
      [{ customerId: 'cus_a', important: true }, { customerId: 'cus_a', important: false }, { customerId: 'cus_b', important: false }],
      customers,
    );
    expect(d).toMatchObject({ customerCount: 2, requestCount: 3, importantCount: 1, revenue: 140_000, size: 500 });
    expect(d.customerIds).toEqual(['cus_a', 'cus_b']);
    expect(d.tierIds).toEqual(['ct_gold']);
  });

  it('treats missing revenue, size and tier as nothing, and ignores unknown customers', () => {
    expect(demandOf([{ customerId: 'cus_c', important: false }], customers)).toMatchObject({ customerCount: 1, revenue: 0, size: 0, tierIds: [] });
    expect(demandOf([{ customerId: 'cus_gone', important: true }], customers)).toBe(NO_DEMAND);
  });
});

describe('buildDemandIndex', () => {
  it('groups requests by the issue or project they sit on', () => {
    const index = buildDemandIndex(
      [req('1', 'cus_a', { issueId: 'in_1' }), req('2', 'cus_b', { issueId: 'in_1' }, true), req('3', 'cus_a', { projectId: 'pj_1' })],
      customers,
    );
    expect(index.get('in_1')).toMatchObject({ customerCount: 2, requestCount: 2, importantCount: 1 });
    expect(index.get('pj_1')).toMatchObject({ customerCount: 1, revenue: 100_000 });
    expect(index.has('in_2')).toBe(false);
  });
});

describe('mergeDemand', () => {
  it('rolls issues up into a workstream without counting a customer twice', () => {
    const index = buildDemandIndex(
      [req('1', 'cus_a', { issueId: 'in_1' }), req('2', 'cus_a', { issueId: 'in_2' }), req('3', 'cus_b', { issueId: 'in_2' })],
      customers,
    );
    const merged = mergeDemand([index.get('in_1')!, index.get('in_2')!], customers);
    expect(merged).toMatchObject({ customerCount: 2, requestCount: 3, revenue: 140_000 });
    expect(mergeDemand([], customers)).toBe(NO_DEMAND);
  });
});

describe('isRequestDelivered', () => {
  const issues = new Map([['in_done', { status: 'done' }], ['in_open', { status: 'in_progress' }], ['in_no', { status: 'canceled' }]]);
  const projects = new Map([['pj_done', { status: 'completed' }], ['pj_open', { status: 'in_progress' }]]);
  it('is true once the issue is done or the project completed, never for canceled work', () => {
    expect(isRequestDelivered({ issueId: 'in_done' }, issues as never, projects as never)).toBe(true);
    expect(isRequestDelivered({ issueId: 'in_open' }, issues as never, projects as never)).toBe(false);
    expect(isRequestDelivered({ issueId: 'in_no' }, issues as never, projects as never)).toBe(false);
    expect(isRequestDelivered({ projectId: 'pj_done' }, issues as never, projects as never)).toBe(true);
    expect(isRequestDelivered({ projectId: 'pj_open' }, issues as never, projects as never)).toBe(false);
    expect(isRequestDelivered({ issueId: 'in_missing' }, issues as never, projects as never)).toBe(false);
  });
});
