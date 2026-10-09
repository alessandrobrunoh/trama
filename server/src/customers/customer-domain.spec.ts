import { describe, expect, it } from 'vitest';
import { normalizeCustomerDomain } from '../contracts/domain.js';
import { customerCounts, linkedCustomers, linkedIssues } from '../../../src/app/features/customers/customer-model.ts';
import type { Customer, CustomerRequest, Issue } from '../contracts/domain.js';

describe('normalizeCustomerDomain', () => {
  it('strips scheme, www, path and port, and lower-cases', () => {
    expect(normalizeCustomerDomain('  HTTPS://WWW.Acme.com/pricing?x=1  ')).toBe('acme.com');
    expect(normalizeCustomerDomain('acme.com.')).toBe('acme.com');
    expect(normalizeCustomerDomain('https://support.acme.com:443/a')).toBe('support.acme.com');
  });

  it('rejects empty, single-label and non-host text', () => {
    expect(normalizeCustomerDomain('')).toBeNull();
    expect(normalizeCustomerDomain('acme')).toBeNull();
    expect(normalizeCustomerDomain('not a domain')).toBeNull();
    expect(normalizeCustomerDomain('https://')).toBeNull();
  });
});

const issue = (id: string, status: Issue['status'], updatedAt: string): Issue =>
  ({ id, key: id.toUpperCase(), title: id, status, updatedAt, workspaceId: 'ws', number: 1, kind: 'bug', source: 'manual', workstreamIds: [], milestoneIds: [], labels: [], aliases: [], priority: 'none', createdAt: updatedAt }) as Issue;

const customer = (id: string, name: string): Customer =>
  ({ id, workspaceId: 'ws', name, domain: `${id}.com`, createdBy: { type: 'user', id: 'u' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

const request = (id: string, customerId: string, issueId: string): CustomerRequest =>
  ({ id, workspaceId: 'ws', customerId, issueId, createdBy: { type: 'user', id: 'u' }, createdAt: '2026-01-01T00:00:00.000Z' });

describe('customer page and issue customer list', () => {
  const requests = [
    request('a', 'cus_1', 'iss_1'),
    request('dup', 'cus_1', 'iss_1'),
    request('b', 'cus_1', 'iss_2'),
    request('c', 'cus_2', 'iss_1'),
    request('gone', 'cus_1', 'iss_missing'),
  ];
  const issues = new Map([
    ['iss_1', issue('iss_1', 'todo', '2026-02-01T00:00:00.000Z')],
    ['iss_2', issue('iss_2', 'done', '2026-03-01T00:00:00.000Z')],
  ]);
  const customers = new Map([
    ['cus_1', customer('cus_1', 'Acme')],
    ['cus_2', customer('cus_2', 'Beta')],
  ]);

  it('lists a customer\'s issues once, with status, newest update first, and drops missing issues', () => {
    const rows = linkedIssues('cus_1', requests, issues);
    expect(rows.map((r) => [r.issue.id, r.issue.status])).toEqual([
      ['iss_2', 'done'],
      ['iss_1', 'todo'],
    ]);
  });

  it('lists an issue\'s customers once, by name, and counts distinct customers', () => {
    expect(linkedCustomers('iss_1', requests, customers).map((r) => r.customer.name)).toEqual(['Acme', 'Beta']);
    expect(customerCounts(requests).get('iss_1')).toBe(2);
    expect(customerCounts(requests).get('iss_2')).toBe(1);
  });
});
