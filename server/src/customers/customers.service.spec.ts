import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../contracts/domain.js';
import {
  CustomerEntity,
  CustomerRequestEntity,
  IssueEntity,
  ProjectEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import { CustomersService } from './customers.service.js';

type Where = Record<string, unknown>;
type Row = { id: string };

/** In-memory stand-in for the TypeORM repositories the service touches. `make` builds real entities so `toJSON` works. */
function fakeRepo<T extends Row>(rows: T[], make?: (x: Partial<T>) => T) {
  const matches = (r: T, where: Where) =>
    Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v);
  return {
    rows,
    create: (x: Partial<T>) => (make ? make(x) : (x as T)),
    save: async (x: T) => {
      const i = rows.findIndex((r) => r.id === x.id);
      if (i >= 0) rows[i] = x;
      else rows.push(x);
      return x;
    },
    findOneBy: async (where: Where) => rows.find((r) => matches(r, where)) ?? null,
    findBy: async (where: Where & { id?: { _value?: string[] } }) => {
      const { id, ...rest } = where;
      const ids = (id as unknown as { _value: string[] } | undefined)?._value;
      return rows.filter((r) => matches(r, rest) && (!ids || ids.includes(r.id)));
    },
    find: async ({ where }: { where: Where }) =>
      rows.filter((r) => matches(r, where)).sort((a, b) => (b as unknown as { createdAt: Date }).createdAt.getTime() - (a as unknown as { createdAt: Date }).createdAt.getTime()),
    delete: async (where: Where) => {
      for (const r of rows.filter((x) => matches(x, where))) rows.splice(rows.indexOf(r), 1);
    },
  };
}

const ACTOR: ActorRef = { type: 'user', id: 'u_1' };
const TIER = { id: 'ct_gold', name: 'Gold', color: '#eab308' };

function setup() {
  const customerRows: CustomerEntity[] = [];
  const customers = fakeRepo<CustomerEntity>(customerRows, (x) => Object.assign(new CustomerEntity(), x));
  const requests = fakeRepo<CustomerRequestEntity>([], (x) => Object.assign(new CustomerRequestEntity(), x));
  const issues = fakeRepo<IssueEntity>([
    { id: 'iss_1', workspaceId: 'ws_1', key: 'BUG-1', title: 'Login', status: 'todo', updatedAt: new Date() } as IssueEntity,
    { id: 'iss_other', workspaceId: 'ws_2', key: 'BUG-9', title: 'Foreign', status: 'todo', updatedAt: new Date() } as IssueEntity,
  ]);
  const projects = fakeRepo<ProjectEntity>([
    { id: 'pj_1', workspaceId: 'ws_1', name: 'Onboarding', status: 'active', updatedAt: new Date() } as ProjectEntity,
    { id: 'pj_other', workspaceId: 'ws_2', name: 'Foreign', status: 'active', updatedAt: new Date() } as ProjectEntity,
  ]);
  const workspaces = fakeRepo<WorkspaceEntity>([
    { id: 'ws_1', settings: { customerTiers: [TIER] } } as unknown as WorkspaceEntity,
  ]);
  const byEntity = new Map<unknown, unknown>([
    [IssueEntity, issues],
    [ProjectEntity, projects],
    [WorkspaceEntity, workspaces],
    [CustomerEntity, customers],
  ]);
  const manager = {
    getRepository: (target: unknown) => byEntity.get(target),
    // advisory lock -> nothing; the domain clash probe -> a fake of the SQL's result
    query: async (sql: string, params: unknown[]) => {
      if (!sql.includes('jsonb_array_elements_text')) return [];
      const [workspaceId, selfId, domains] = params as [string, string, string[]];
      const hit = customerRows
        .filter((c) => c.workspaceId === workspaceId && c.id !== selfId)
        .flatMap((c) => c.domains)
        .find((d) => domains.includes(d));
      return hit ? [{ domain: hit }] : [];
    },
  };
  const ds = {
    getRepository: (target: unknown) => byEntity.get(target),
    transaction: async <R>(cb: (m: typeof manager) => Promise<R>) => cb(manager),
  } as unknown as DataSource;
  const events = { record: vi.fn(async () => ({})), publish: vi.fn() };
  const service = new CustomersService(
    ds,
    events as unknown as EventsService,
    customers as unknown as Repository<CustomerEntity>,
    requests as unknown as Repository<CustomerRequestEntity>,
  );
  return { service, events, customerRows, requestRows: requests.rows };
}

describe('customers: company fields', () => {
  it('creates a company with several normalized domains, attributes and a workspace tier', async () => {
    const { service, events } = setup();
    const c = await service.create('ws_1', ACTOR, {
      name: '  Acme  ',
      domains: ['https://WWW.Acme.com/x', 'acme.io', 'acme.com'],
      logoUrl: 'https://cdn.acme.com/logo.png',
      revenue: 5_000_000,
      size: 250,
      tierId: 'ct_gold',
      status: 'prospect',
    });
    expect(c).toMatchObject({
      name: 'Acme',
      domain: 'acme.com',
      domains: ['acme.com', 'acme.io'],
      logoUrl: 'https://cdn.acme.com/logo.png',
      revenue: 5_000_000,
      size: 250,
      tierId: 'ct_gold',
      status: 'prospect',
    });
    expect(events.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'customer.created' }));
  });

  it('still accepts a single legacy `domain` and defaults to active', async () => {
    const { service } = setup();
    const c = await service.create('ws_1', ACTOR, { name: 'Old', domain: 'old.example' });
    expect(c.domains).toEqual(['old.example']);
    expect(c.status).toBe('active');
  });

  it('requires at least one valid domain', async () => {
    const { service } = setup();
    await expect(service.create('ws_1', ACTOR, { name: 'X' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('ws_1', ACTOR, { name: 'X', domains: ['nope'] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('ws_1', ACTOR, { name: 'X', domains: Array.from({ length: 21 }, (_, i) => `d${i}.com`) }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a domain, primary or secondary, that another customer of the workspace owns', async () => {
    const { service } = setup();
    await service.create('ws_1', ACTOR, { name: 'Acme', domains: ['acme.com', 'acme.io'] });
    await expect(service.create('ws_1', ACTOR, { name: 'Other', domains: ['other.com', 'ACME.io'] })).rejects.toBeInstanceOf(ConflictException);
    const beta = await service.create('ws_1', ACTOR, { name: 'Beta', domains: ['beta.com'] });
    await expect(service.update('ws_1', ACTOR, beta.id, { domains: ['beta.com', 'acme.com'] })).rejects.toBeInstanceOf(ConflictException);
    // the same domain is fine in another workspace
    await expect(service.create('ws_2', ACTOR, { name: 'Acme too', domains: ['acme.com'] })).resolves.toMatchObject({ workspaceId: 'ws_2' });
  });

  it('validates logo, revenue, size, status and tier', async () => {
    const { service } = setup();
    const base = { name: 'V', domains: ['v.com'] };
    await expect(service.create('ws_1', ACTOR, { ...base, logoUrl: 'javascript:alert(1)' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('ws_1', ACTOR, { ...base, revenue: -1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('ws_1', ACTOR, { ...base, size: 1.5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('ws_1', ACTOR, { ...base, status: 'vip' as never })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('ws_1', ACTOR, { ...base, tierId: 'ct_nope' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a tier of another workspace cannot be assigned', async () => {
    const { service } = setup();
    await expect(service.create('ws_2', ACTOR, { name: 'Z', domains: ['z.com'], tierId: 'ct_gold' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updates attributes, `domain` swaps only the primary, null clears', async () => {
    const { service } = setup();
    const c = await service.create('ws_1', ACTOR, { name: 'Acme', domains: ['acme.com', 'acme.io'], tierId: 'ct_gold', revenue: 10 });
    const moved = await service.update('ws_1', ACTOR, c.id, { domain: 'ACME.io', name: 'Acme Inc' });
    expect(moved).toMatchObject({ name: 'Acme Inc', domain: 'acme.io', domains: ['acme.io', 'acme.com'] });
    const cleared = await service.update('ws_1', ACTOR, c.id, { tierId: null, revenue: null, logoUrl: null, status: 'churned' });
    expect(cleared).toMatchObject({ tierId: null, revenue: null, status: 'churned' });
    await expect(service.update('ws_2', ACTOR, c.id, { name: 'Nope' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('archive then restore records the matching event only', async () => {
    const { service, events } = setup();
    const c = await service.create('ws_1', ACTOR, { name: 'A', domains: ['a.com'] });
    await service.update('ws_1', ACTOR, c.id, { archived: true });
    await service.update('ws_1', ACTOR, c.id, { archived: false });
    const types = events.record.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types).toEqual(['customer.created', 'customer.archived', 'customer.restored']);
  });
});

describe('customers: requests', () => {
  async function withCustomer() {
    const ctx = setup();
    const customer = await ctx.service.create('ws_1', ACTOR, { name: 'Acme', domains: ['acme.com'] });
    return { ...ctx, customer };
  }

  it('attaches a request to an issue, with body, source and important', async () => {
    const { service, customer } = await withCustomer();
    const r = await service.createRequest('ws_1', ACTOR, customer.id, {
      issueId: 'iss_1',
      body: '  We **need** SSO  ',
      important: true,
      sourceUrl: 'https://acme.zendesk.com/tickets/42',
    });
    expect(r).toMatchObject({
      customerId: customer.id,
      issueId: 'iss_1',
      body: 'We **need** SSO',
      important: true,
      sourceUrl: 'https://acme.zendesk.com/tickets/42',
      createdBy: ACTOR,
      issue: { key: 'BUG-1' },
    });
    expect(r.projectId).toBeUndefined();
  });

  it('attaches a request to a project', async () => {
    const { service, customer } = await withCustomer();
    const r = await service.createRequest('ws_1', ACTOR, customer.id, { projectId: 'pj_1', body: 'Faster onboarding' });
    expect(r).toMatchObject({ projectId: 'pj_1', important: false, project: { name: 'Onboarding' } });
    expect(r.issueId).toBeUndefined();
  });

  it('needs exactly one target, in this workspace', async () => {
    const { service, customer } = await withCustomer();
    await expect(service.createRequest('ws_1', ACTOR, customer.id, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1', projectId: 'pj_1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_other' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createRequest('ws_1', ACTOR, customer.id, { projectId: 'pj_other' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createRequest('ws_2', ACTOR, customer.id, { issueId: 'iss_other' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a source URL that is not http(s) and an over-long body', async () => {
    const { service, customer } = await withCustomer();
    await expect(service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1', sourceUrl: 'javascript:alert(1)' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1', body: 'x'.repeat(20_001) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows several requests from one customer on the same issue', async () => {
    const { service, customer, requestRows } = await withCustomer();
    await service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1', body: 'one' });
    await service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1', body: 'two' });
    expect(requestRows).toHaveLength(2);
    expect(await service.listRequests('ws_1', { issueId: 'iss_1' })).toHaveLength(2);
  });

  it('edits the body, toggles important, clears the source, and records one event per real change', async () => {
    const { service, customer, events } = await withCustomer();
    const r = await service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1', body: 'old', sourceUrl: 'https://x.example/1' });
    events.record.mockClear();
    const edited = await service.updateRequest('ws_1', ACTOR, customer.id, r.id, { body: 'new', important: true, sourceUrl: null });
    expect(edited).toMatchObject({ body: 'new', important: true });
    expect(edited.sourceUrl).toBeUndefined();
    expect(events.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'customer_request.updated', data: expect.objectContaining({ fields: ['body', 'important', 'sourceUrl'] }) }));
    events.record.mockClear();
    await service.updateRequest('ws_1', ACTOR, customer.id, r.id, { important: true });
    expect(events.record).not.toHaveBeenCalled();
    const blank = await service.updateRequest('ws_1', ACTOR, customer.id, r.id, { body: '   ' });
    expect(blank.body).toBeUndefined();
  });

  it('cannot touch a request through another customer or workspace', async () => {
    const { service, customer } = await withCustomer();
    const other = await service.create('ws_1', ACTOR, { name: 'Other', domains: ['other.com'] });
    const r = await service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1' });
    await expect(service.updateRequest('ws_1', ACTOR, other.id, r.id, { important: true })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateRequest('ws_2', ACTOR, customer.id, r.id, { important: true })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.removeRequest('ws_1', ACTOR, other.id, r.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes a request and keeps the issue', async () => {
    const { service, customer, requestRows, events } = await withCustomer();
    const r = await service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1' });
    await service.removeRequest('ws_1', ACTOR, customer.id, r.id);
    expect(requestRows).toHaveLength(0);
    expect(events.record).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'customer_request.unlinked' }));
  });

  it('lists by customer and by importance', async () => {
    const { service, customer } = await withCustomer();
    await service.createRequest('ws_1', ACTOR, customer.id, { issueId: 'iss_1', important: true });
    await service.createRequest('ws_1', ACTOR, customer.id, { projectId: 'pj_1' });
    expect(await service.requestsFor('ws_1', customer.id)).toHaveLength(2);
    expect(await service.listRequests('ws_1', { important: true })).toHaveLength(1);
    await expect(service.requestsFor('ws_2', customer.id)).rejects.toBeInstanceOf(NotFoundException);
  });
});
