import { describe, expect, it } from 'vitest';
import {
  normalizeCustomerDomain,
  normalizeCustomerDomains,
  normalizeHttpUrl,
  resolveCustomerTiers,
  resolveWorkspaceSettings,
} from '../contracts/domain.js';
import {
  compactNumber,
  customerCounts,
  requestRows,
  requestsOn,
  splitDomains,
} from '../../../src/app/features/customers/customer-model.ts';
import type { Customer, CustomerRequest, Issue, Project } from '../contracts/domain.js';

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

describe('normalizeCustomerDomains', () => {
  it('keeps order, drops duplicates and blanks, and reports the invalid ones', () => {
    expect(normalizeCustomerDomains(['https://Acme.com', '', 'www.acme.com', 'acme.io'])).toEqual({
      domains: ['acme.com', 'acme.io'],
      invalid: [],
    });
    expect(normalizeCustomerDomains(['acme.com', 'nope', 'localhost'])).toEqual({
      domains: ['acme.com'],
      invalid: ['nope', 'localhost'],
    });
  });
});

describe('normalizeHttpUrl', () => {
  it('accepts http(s) URLs only', () => {
    expect(normalizeHttpUrl(' https://acme.zendesk.com/tickets/42 ')).toBe('https://acme.zendesk.com/tickets/42');
    expect(normalizeHttpUrl('http://example.com/logo.png')).toBe('http://example.com/logo.png');
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(normalizeHttpUrl('ftp://example.com/x')).toBeNull();
    expect(normalizeHttpUrl('not a url')).toBeNull();
    expect(normalizeHttpUrl('')).toBeNull();
    expect(normalizeHttpUrl(`https://example.com/${'a'.repeat(2000)}`)).toBeNull();
  });
});

describe('customer tiers in workspace settings', () => {
  it('starts empty, and keeps well-formed tiers only', () => {
    expect(resolveWorkspaceSettings(null).customerTiers).toEqual([]);
    expect(
      resolveCustomerTiers([
        { id: 'ct_1', name: ' Enterprise ', color: '#2563eb' },
        { id: 'ct_1', name: 'Dupe', color: '#2563eb' },
        { id: 'ct_2', name: '', color: '#2563eb' },
        { id: 'ct_3', name: 'Bad colour', color: 'blue' },
        { id: 'ct_4', name: 'x'.repeat(41), color: '#2563eb' },
      ]),
    ).toEqual([{ id: 'ct_1', name: 'Enterprise', color: '#2563eb' }]);
  });
});

const at = '2026-01-01T00:00:00.000Z';
const actor = { type: 'user', id: 'u' } as const;

const issue = (id: string): Issue =>
  ({ id, key: id.toUpperCase(), title: id, status: 'todo', updatedAt: at, workspaceId: 'ws', number: 1, kind: 'bug', source: 'manual', workstreamIds: [], milestoneIds: [], labels: [], aliases: [], priority: 'none', createdAt: at }) as Issue;

const project = (id: string): Project => ({ id, workspaceId: 'ws', name: id }) as Project;

const customer = (id: string, name: string): Customer => ({
  id,
  workspaceId: 'ws',
  name,
  domain: `${id}.com`,
  domains: [`${id}.com`],
  status: 'active',
  createdBy: actor,
  createdAt: at,
  updatedAt: at,
});

const request = (id: string, customerId: string, target: { issueId: string } | { projectId: string }, extra: Partial<CustomerRequest> = {}): CustomerRequest => ({
  id,
  workspaceId: 'ws',
  customerId,
  ...target,
  important: false,
  createdBy: actor,
  createdAt: at,
  updatedAt: at,
  ...extra,
});

describe('customer request views', () => {
  const requests = [
    request('a', 'cus_1', { issueId: 'iss_1' }, { createdAt: '2026-02-01T00:00:00.000Z' }),
    request('a2', 'cus_1', { issueId: 'iss_1' }, { createdAt: '2026-03-01T00:00:00.000Z' }),
    request('b', 'cus_1', { projectId: 'pj_1' }, { important: true }),
    request('c', 'cus_2', { issueId: 'iss_1' }, { important: true }),
    request('gone', 'cus_1', { issueId: 'iss_missing' }),
  ];
  const customers = new Map([
    ['cus_1', customer('cus_1', 'Acme')],
    ['cus_2', customer('cus_2', 'Beta')],
  ]);
  const issues = new Map([['iss_1', issue('iss_1')]]);
  const projects = new Map([['pj_1', project('pj_1')]]);

  it('lists the requests on an issue in full: important first, then newest', () => {
    expect(requestsOn({ issueId: 'iss_1' }, requests, customers).map((r) => r.request.id)).toEqual(['c', 'a2', 'a']);
  });

  it('lists the requests on a project', () => {
    expect(requestsOn({ projectId: 'pj_1' }, requests, customers).map((r) => r.customer.name)).toEqual(['Acme']);
  });

  it('shows one customer\'s requests on issues and projects, and drops missing targets', () => {
    const rows = requestRows('cus_1', requests, issues, projects);
    expect(rows.map((r) => r.request.id)).toEqual(['b', 'a2', 'a']);
    expect(rows[0]!.project?.id).toBe('pj_1');
    expect(rows[1]!.issue?.id).toBe('iss_1');
  });

  it('counts distinct customers per issue, ignoring projects', () => {
    const counts = customerCounts(requests);
    expect(counts.get('iss_1')).toBe(2);
    expect(counts.has('pj_1')).toBe(false);
  });

  it('splits and formats edit-form input', () => {
    expect(splitDomains('acme.com, acme.io\nfoo.dev ;')).toEqual(['acme.com', 'acme.io', 'foo.dev']);
    expect(compactNumber(1_250_000)).toBe('1.3M');
  });
});
