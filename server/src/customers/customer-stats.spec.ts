import { describe, expect, it } from 'vitest';
import type { Customer, CustomerRequest, CustomerTier, Issue, Project } from '../contracts/domain.js';
import {
  customerStats,
  describeRequestStates,
  groupCustomerStats,
  requestState,
  sortCustomerStats,
} from '../../../src/app/features/customers/customer-model.ts';

const gold: CustomerTier = { id: 'ct_gold', name: 'Gold', color: '#eab308' };
const silver: CustomerTier = { id: 'ct_silver', name: 'Silver', color: '#9ca3af' };

const customer = (id: string, name: string, extra: Partial<Customer> = {}): Customer =>
  ({ id, name, workspaceId: 'ws_1', domain: `${id}.com`, domains: [`${id}.com`], status: 'active', ...extra }) as Customer;

const request = (id: string, customerId: string, target: { issueId?: string; projectId?: string }, extra: Partial<CustomerRequest> = {}): CustomerRequest =>
  ({ id, customerId, important: false, createdAt: '2026-01-01T00:00:00.000Z', ...target, ...extra }) as CustomerRequest;

const issues = new Map<string, Issue>([
  ['in_open', { id: 'in_open', status: 'in_progress' } as Issue],
  ['in_done', { id: 'in_done', status: 'done' } as Issue],
  ['in_canceled', { id: 'in_canceled', status: 'canceled' } as Issue],
]);
const projects = new Map<string, Project>([
  ['pj_open', { id: 'pj_open', status: 'in_progress' } as Project],
  ['pj_done', { id: 'pj_done', status: 'completed' } as Project],
]);

describe('requestState', () => {
  it('is delivered when the work is done, dropped when canceled or gone, open otherwise', () => {
    expect(requestState({ issueId: 'in_open' }, issues, projects)).toBe('open');
    expect(requestState({ issueId: 'in_done' }, issues, projects)).toBe('delivered');
    expect(requestState({ issueId: 'in_canceled' }, issues, projects)).toBe('dropped');
    expect(requestState({ issueId: 'in_gone' }, issues, projects)).toBe('dropped');
    expect(requestState({ projectId: 'pj_open' }, issues, projects)).toBe('open');
    expect(requestState({ projectId: 'pj_done' }, issues, projects)).toBe('delivered');
  });
});

describe('customerStats', () => {
  const customers = [customer('a', 'Acme', { tierId: 'ct_gold', revenue: 100 }), customer('b', 'Beta'), customer('c', 'Cora', { tierId: 'ct_unknown' })];
  const requests = [
    request('1', 'a', { issueId: 'in_open' }, { important: true, createdAt: '2026-02-01T00:00:00.000Z' }),
    request('2', 'a', { issueId: 'in_done' }, { createdAt: '2026-03-01T00:00:00.000Z' }),
    request('3', 'a', { projectId: 'pj_done' }),
    request('4', 'b', { issueId: 'in_canceled' }),
    request('5', 'gone', { issueId: 'in_open' }),
  ];
  const stats = customerStats(customers, requests, issues, projects, [gold, silver]);

  it('counts requests, important, open and delivered per customer', () => {
    const a = stats.find((s) => s.customer.id === 'a')!;
    expect(a).toMatchObject({ requests: 3, important: 1, open: 1, delivered: 2, openImportant: 1, lastRequestAt: '2026-03-01T00:00:00.000Z' });
    expect(a.tier).toEqual(gold);
  });

  it('keeps customers without requests, ignores requests of unknown customers, drops canceled from open and delivered', () => {
    expect(stats).toHaveLength(3);
    expect(stats.find((s) => s.customer.id === 'b')).toMatchObject({ requests: 1, open: 0, delivered: 0 });
    expect(stats.find((s) => s.customer.id === 'c')).toMatchObject({ requests: 0 });
    expect(stats.find((s) => s.customer.id === 'c')!.lastRequestAt).toBeUndefined();
    expect(stats.find((s) => s.customer.id === 'c')!.tier).toBeUndefined();
  });

  it('sorts with empty values last in both directions', () => {
    expect(sortCustomerStats(stats, 'revenue', 'desc').map((s) => s.customer.name)).toEqual(['Acme', 'Beta', 'Cora']);
    expect(sortCustomerStats(stats, 'revenue', 'asc').map((s) => s.customer.name)).toEqual(['Acme', 'Beta', 'Cora']);
    expect(sortCustomerStats(stats, 'requests', 'desc').map((s) => s.customer.name)).toEqual(['Acme', 'Beta', 'Cora']);
    expect(sortCustomerStats(stats, 'name', 'desc').map((s) => s.customer.name)).toEqual(['Cora', 'Beta', 'Acme']);
  });

  it('groups by tier in workspace order with "No tier" last, and by status', () => {
    const byTier = groupCustomerStats(sortCustomerStats(stats, 'name', 'asc'), 'tier', [silver, gold]);
    expect(byTier.map((b) => [b.label, b.rows.map((r) => r.customer.name)])).toEqual([
      ['Gold', ['Acme']],
      ['No tier', ['Beta', 'Cora']],
    ]);
    const churned = customerStats([customer('x', 'Xeno', { status: 'churned' }), customer('y', 'Yard')], [], issues, projects, []);
    expect(groupCustomerStats(churned, 'status', []).map((b) => b.label)).toEqual(['Active', 'Churned']);
    expect(groupCustomerStats(churned, 'none', [])).toHaveLength(1);
  });
});

describe('describeRequestStates', () => {
  it('reads like a sentence', () => {
    expect(describeRequestStates(3, 2)).toBe('3 open · 2 delivered');
    expect(describeRequestStates(0, 2)).toBe('2 delivered');
    expect(describeRequestStates(0, 0)).toBe('No requests');
  });
});
