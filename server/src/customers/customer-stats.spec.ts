import { describe, expect, it } from 'vitest';
import type { Customer, CustomerRequest, CustomerTier, DomainEvent, Issue, Project } from '../contracts/domain.js';
import {
  customerActivity,
  customerStats,
  describeRequestStates,
  groupCustomerStats,
  groupWork,
  requestState,
  sortCustomerStats,
  sortWork,
  workRows,
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

describe('workRows', () => {
  const work = new Map<string, Issue>([
    ['in_open', { id: 'in_open', key: 'BUG-1', title: 'Open one', status: 'in_progress', priority: 'high', teamId: 'tm_1' } as Issue],
    ['in_done', { id: 'in_done', key: 'BUG-2', title: 'Done one', status: 'done', priority: 'low' } as Issue],
  ]);
  const projs = new Map<string, Project>([['pj_open', { id: 'pj_open', name: 'Onboarding', status: 'planned', priority: 'urgent', teamIds: ['tm_2'] } as Project]]);
  const requests = [
    request('1', 'a', { issueId: 'in_open' }, { createdAt: '2026-01-01T00:00:00.000Z' }),
    request('2', 'a', { issueId: 'in_open' }, { important: true, createdAt: '2026-02-01T00:00:00.000Z' }),
    request('3', 'a', { issueId: 'in_done' }),
    request('4', 'a', { projectId: 'pj_open' }),
    request('5', 'a', { issueId: 'in_gone' }),
    request('6', 'b', { issueId: 'in_open' }),
  ];
  const rows = workRows('a', requests, work, projs);

  it("rolls a customer's requests up per issue or project and skips missing targets", () => {
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === 'in_open')).toMatchObject({ kind: 'issue', key: 'BUG-1', requests: 2, important: 1, state: 'open', teamId: 'tm_1', lastRequestAt: '2026-02-01T00:00:00.000Z' });
    expect(rows.find((r) => r.id === 'pj_open')).toMatchObject({ kind: 'project', title: 'Onboarding', teamId: 'tm_2', state: 'open' });
    expect(rows.find((r) => r.id === 'in_done')).toMatchObject({ state: 'delivered' });
  });

  it('puts important and most requested first', () => {
    expect(sortWork(rows).map((r) => r.id)).toEqual(['in_open', 'in_done', 'pj_open']);
  });

  it('groups by state, priority, team and kind in a stable order', () => {
    expect(groupWork(sortWork(rows), 'state').map((g) => [g.key, g.rows.length])).toEqual([['open', 2], ['delivered', 1]]);
    expect(groupWork(rows, 'priority').map((g) => g.key)).toEqual(['urgent', 'high', 'low']);
    expect(groupWork(rows, 'team').map((g) => g.key)).toEqual(['tm_1', 'tm_2', '']);
    expect(groupWork(rows, 'kind').map((g) => g.key)).toEqual(['issue', 'project']);
  });
});

describe('customerActivity', () => {
  const ev = (id: string, at: string, type: string, subjectId: string, data: Record<string, unknown>): DomainEvent =>
    ({ id, at, type, data, workspaceId: 'ws_1', actor: { type: 'user', id: 'u_1' }, subject: { type: type.startsWith('customer_request') ? 'customer_request' : 'customer', id: subjectId } }) as DomainEvent;
  const work = new Map<string, Issue>([
    ['in_1', { id: 'in_1', key: 'BUG-1', status: 'done', completedAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-04-01T00:00:00.000Z' } as Issue],
    ['in_2', { id: 'in_2', key: 'BUG-2', status: 'todo', updatedAt: '2026-01-01T00:00:00.000Z' } as Issue],
  ]);
  const events = [
    ev('e1', '2026-01-01T00:00:00.000Z', 'customer.created', 'a', {}),
    ev('e2', '2026-02-01T00:00:00.000Z', 'customer_request.linked', 'crq_1', { customerId: 'a', issueId: 'in_1', important: true }),
    ev('e3', '2026-03-01T00:00:00.000Z', 'customer_request.updated', 'crq_1', { customerId: 'a', issueId: 'in_1', fields: ['important'], important: false }),
    ev('e4', '2026-03-02T00:00:00.000Z', 'customer.updated', 'a', { fields: ['tierId', 'revenue'] }),
    ev('e5', '2026-03-03T00:00:00.000Z', 'customer_request.linked', 'crq_9', { customerId: 'other', issueId: 'in_2' }),
    ev('e6', '2026-03-04T00:00:00.000Z', 'issue.updated', 'in_2', {}),
  ];
  const requests = [request('crq_1', 'a', { issueId: 'in_1' }), request('crq_2', 'a', { issueId: 'in_2' })];
  const items = customerActivity('a', events, requests, work, new Map());

  it('lists this customer\'s events newest first, with delivery derived from the work', () => {
    expect(items.map((i) => i.text)).toEqual([
      'BUG-1 was delivered',
      'Updated tier, revenue',
      'Removed the important flag on BUG-1',
      'Recorded an important request on BUG-1',
      'Added the customer',
    ]);
  });

  it('links to the work and leaves delivery without an actor', () => {
    expect(items[0]).toMatchObject({ link: ['issues', 'BUG-1'] });
    expect(items[0].actor).toBeUndefined();
    expect(items[3].link).toEqual(['issues', 'BUG-1']);
  });
});

describe('describeRequestStates', () => {
  it('reads like a sentence', () => {
    expect(describeRequestStates(3, 2)).toBe('3 open · 2 delivered');
    expect(describeRequestStates(0, 2)).toBe('2 delivered');
    expect(describeRequestStates(0, 0)).toBe('No requests');
  });
});
