import { BadRequestException, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../contracts/domain.js';
import { CustomerEntity, IssueEntity, ProjectEntity } from '../database/entities/index.js';
import type { CustomersService } from '../customers/customers.service.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { CustomerIntakeService } from './customer-intake.service.js';
import { IntakeItemEntity, IntakeSourceEntity } from './entities.js';
import { signIntakeDelivery } from './intake-signatures.js';

type Where = Record<string, unknown>;

process.env.TRAMA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const secrets = new SecretsService();
const ACTOR: ActorRef = { type: 'user', id: 'u_1' };

function matches<T>(row: T, where: Where) {
  return Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
}

function fakeRepo<T extends { id: string }>(rows: T[], make: (x: Partial<T>) => T) {
  return {
    rows,
    create: (x: Partial<T>) => make(x),
    save: async (x: T) => {
      const i = rows.findIndex((r) => r.id === x.id);
      if (i >= 0) rows[i] = x;
      else rows.push(x);
      return x;
    },
    findOneBy: async (w: Where) => rows.find((r) => matches(r, w)) ?? null,
    find: async ({ where }: { where: Where }) => rows.filter((r) => matches(r, where)),
    countBy: async (w: Where) => rows.filter((r) => matches(r, w)).length,
    update: async (w: Where, patch: Partial<T>) => {
      const hit = rows.filter((r) => matches(r, w));
      for (const r of hit) Object.assign(r, patch);
      return { affected: hit.length };
    },
    delete: async (w: Where) => {
      for (const r of rows.filter((x) => matches(x, w))) rows.splice(rows.indexOf(r), 1);
    },
  };
}

function setup() {
  const sourceRows: IntakeSourceEntity[] = [];
  const itemRows: IntakeItemEntity[] = [];
  const sources = fakeRepo<IntakeSourceEntity>(sourceRows, (x) => Object.assign(new IntakeSourceEntity(), x));
  const items = fakeRepo<IntakeItemEntity>(itemRows, (x) => Object.assign(new IntakeItemEntity(), x));

  const customerRows: { id: string; workspaceId: string; name: string; domains: string[]; archivedAt: Date | null }[] = [
    { id: 'cus_acme', workspaceId: 'ws_1', name: 'Acme', domains: ['acme.com'], archivedAt: null },
    { id: 'cus_other', workspaceId: 'ws_2', name: 'Other WS Acme', domains: ['acme.com'], archivedAt: null },
  ];
  const requestCalls: { workspaceId: string; actor: ActorRef; customerId: string; input: Record<string, unknown> }[] = [];
  const customers = {
    list: vi.fn(async (workspaceId: string) => customerRows.filter((c) => c.workspaceId === workspaceId)),
    create: vi.fn(async (workspaceId: string, _actor: ActorRef, input: { name: string; domains: string[] }) => {
      if (customerRows.some((c) => c.workspaceId === workspaceId && c.domains.some((d) => input.domains.includes(d))))
        throw new ConflictException('domain taken');
      const row = { id: `cus_${customerRows.length + 1}`, workspaceId, name: input.name, domains: input.domains, archivedAt: null };
      customerRows.push(row);
      return row;
    }),
    createRequest: vi.fn(async (workspaceId: string, actor: ActorRef, customerId: string, input: Record<string, unknown>) => {
      if (input['issueId'] === 'iss_missing') throw new NotFoundException('Issue not found');
      requestCalls.push({ workspaceId, actor, customerId, input });
      return { id: `crq_${requestCalls.length}` };
    }),
  };

  const issueRows = [
    { id: 'iss_1', workspaceId: 'ws_1', key: 'BUG-1' },
    { id: 'iss_foreign', workspaceId: 'ws_2', key: 'BUG-1' },
  ];
  const repos = new Map<unknown, unknown>([
    [IssueEntity, { findOneBy: async (w: Where) => issueRows.find((r) => matches(r, w)) ?? null, createQueryBuilder: () => ({ where: () => ({ andWhere: () => ({ getOne: async () => null }) }) }) }],
    [ProjectEntity, { findOneBy: async (w: Where) => [{ id: 'pj_1', workspaceId: 'ws_1' }, { id: 'pj_foreign', workspaceId: 'ws_2' }].find((r) => matches(r, w)) ?? null }],
    [CustomerEntity, { existsBy: async (w: Where) => customerRows.some((r) => matches(r, w)) }],
  ]);
  const ds = {
    getRepository: (t: unknown) => repos.get(t),
    createQueryBuilder: () => {
      let values: IntakeItemEntity;
      const qb = {
        insert: () => qb,
        into: () => qb,
        values: (v: IntakeItemEntity) => {
          values = v;
          return qb;
        },
        orIgnore: () => qb,
        returning: () => qb,
        execute: async () => {
          if (itemRows.some((r) => r.sourceId === values.sourceId && r.externalId === values.externalId)) return { raw: [] };
          itemRows.push(Object.assign(new IntakeItemEntity(), { receivedAt: new Date(), resolvedAt: null, ...values }));
          return { raw: [{ id: values.id }] };
        },
      };
      return qb;
    },
  } as unknown as DataSource;

  const service = new CustomerIntakeService(
    ds,
    secrets,
    customers as unknown as CustomersService,
    sources as unknown as Repository<IntakeSourceEntity>,
    items as unknown as Repository<IntakeItemEntity>,
  );
  return { service, customers, customerRows, requestCalls, sourceRows, itemRows };
}

/** Posts a signed generic delivery to a source, the way a provider would. */
async function deliver(
  service: CustomerIntakeService,
  sourceId: string,
  secret: string,
  payload: Record<string, unknown>,
  provider: 'generic' | 'intercom' = 'generic',
) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  return service.receive({ sourceId, rawBody, payload, headers: signIntakeDelivery(provider, secret, rawBody) });
}

const ticket = (id: string, email = 'jane@acme.com') => ({ externalId: id, subject: 'SSO', body: 'We need SAML', requesterEmail: email, externalUrl: `https://desk.example/t/${id}` });

async function createGeneric(s: ReturnType<typeof setup>, input: Partial<Parameters<CustomerIntakeService['createSource']>[2]> = {}) {
  const created = await s.service.createSource('ws_1', ACTOR, { provider: 'generic', name: 'CRM', ...input }, 'https://trama.test');
  return { id: created.source.id, secret: created.secret! };
}

describe('customer intake: sources', () => {
  it('generates and returns the secret once for Trama-signed sources, stores it encrypted, never presents it', async () => {
    const s = setup();
    const created = await s.service.createSource('ws_1', ACTOR, { provider: 'generic', name: 'CRM' }, 'https://trama.test');
    expect(created.secret).toMatch(/^whsec_/);
    expect(s.sourceRows[0]!.secret).not.toContain(created.secret!);
    expect(JSON.stringify(created.source)).not.toContain(created.secret!);
    expect(created.source).toMatchObject({ hasSecret: true, webhookUrl: `https://trama.test/api/webhooks/intake/${created.source.id}` });
    const listed = JSON.stringify(await s.service.listSources('ws_1', 'https://trama.test'));
    expect(listed).not.toContain(created.secret!);
    expect(listed).not.toContain('"secret"');
  });

  it('provider-issued secrets are pasted in, can arrive later, and are refused for generated sources', async () => {
    const s = setup();
    const zendesk = await s.service.createSource('ws_1', ACTOR, { provider: 'zendesk', name: 'Support', subdomain: 'Acme' }, 'https://t');
    expect(zendesk.secret).toBeUndefined();
    expect(zendesk.source).toMatchObject({ hasSecret: false, subdomain: 'acme' });
    const updated = await s.service.updateSource('ws_1', zendesk.source.id, { secret: 'zd-signing-secret' }, 'https://t');
    expect(updated.hasSecret).toBe(true);
    const generic = await createGeneric(s);
    await expect(s.service.updateSource('ws_1', generic.id, { secret: 'mine' }, 'https://t')).rejects.toThrow(BadRequestException);
    await expect(s.service.rotateSecret('ws_1', zendesk.source.id, 'https://t')).rejects.toThrow(BadRequestException);
    const rotated = await s.service.rotateSecret('ws_1', generic.id, 'https://t');
    expect(rotated.secret).not.toBe(generic.secret);
  });

  it('only accepts a target project of the same workspace, and a subdomain only for Zendesk', async () => {
    const s = setup();
    await expect(s.service.createSource('ws_1', ACTOR, { provider: 'generic', name: 'x', targetProjectId: 'pj_foreign' }, 'u')).rejects.toThrow(NotFoundException);
    await expect(s.service.createSource('ws_1', ACTOR, { provider: 'generic', name: 'x', subdomain: 'acme' }, 'u')).rejects.toThrow(BadRequestException);
  });

  it('scopes reads and writes to the workspace', async () => {
    const s = setup();
    const { id } = await createGeneric(s);
    await expect(s.service.getSourcePresented('ws_2', id, 'u')).rejects.toThrow(NotFoundException);
    await expect(s.service.removeSource('ws_2', id)).rejects.toThrow(NotFoundException);
    expect(await s.service.listSources('ws_2', 'u')).toEqual([]);
  });
});

describe('customer intake: receiving', () => {
  it('rejects unsigned, wrongly signed and unknown-source deliveries', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s);
    const rawBody = Buffer.from(JSON.stringify(ticket('1')));
    await expect(s.service.receive({ sourceId: id, rawBody, payload: ticket('1'), headers: {} })).rejects.toThrow(UnauthorizedException);
    await expect(deliver(s.service, id, 'whsec_wrong', ticket('1'))).rejects.toThrow(UnauthorizedException);
    await expect(deliver(s.service, 'isrc_nope', secret, ticket('1'))).rejects.toThrow(NotFoundException);
    expect(s.itemRows).toHaveLength(0);
  });

  it('refuses a source whose provider secret was never pasted', async () => {
    const s = setup();
    const created = await s.service.createSource('ws_1', ACTOR, { provider: 'intercom', name: 'Intercom' }, 'u');
    const rawBody = Buffer.from('{}');
    await expect(s.service.receive({ sourceId: created.source.id, rawBody, payload: {}, headers: signIntakeDelivery('intercom', 'x', rawBody) })).rejects.toThrow(UnauthorizedException);
  });

  it('verifies a provider-style signature (Intercom, sha1 over the client secret)', async () => {
    const s = setup();
    const created = await s.service.createSource('ws_1', ACTOR, { provider: 'intercom', name: 'Intercom', secret: 'client-secret' }, 'u');
    const payload = { topic: 'conversation.user.created', app_id: 'a', data: { item: { id: '5', source: { body: 'Help', author: { email: 'jane@acme.com' } } } } };
    const res = await deliver(s.service, created.source.id, 'client-secret', payload, 'intercom');
    expect(res.body).toMatchObject({ status: 'processed' });
    await expect(deliver(s.service, created.source.id, 'not-the-secret', payload, 'intercom')).rejects.toThrow(UnauthorizedException);
  });

  it('matches the customer by email domain and waits in the inbox when no target is set', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s);
    const res = await deliver(s.service, id, secret, ticket('t1', 'Jane@Acme.com'));
    expect(res).toMatchObject({ httpStatus: 200, body: { status: 'processed', linked: false, customerId: 'cus_acme' } });
    expect(s.itemRows[0]).toMatchObject({ workspaceId: 'ws_1', status: 'pending', customerId: 'cus_acme', externalId: 't1' });
    expect(s.customers.create).not.toHaveBeenCalled();
    expect(s.requestCalls).toHaveLength(0);
  });

  it('never matches a customer of another workspace', async () => {
    const s = setup();
    s.customerRows.splice(0, 1); // ws_1 has no customer for acme.com; ws_2 does
    const { id, secret } = await createGeneric(s, { autoCreateCustomers: false });
    await deliver(s.service, id, secret, ticket('t1'));
    expect(s.itemRows[0]!.customerId).toBeNull();
  });

  it('auto-creates the customer from the company domain, as a prospect, created by the system', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s);
    await deliver(s.service, id, secret, ticket('t1', 'ops@support.newco.io'));
    expect(s.customers.create).toHaveBeenCalledWith('ws_1', { type: 'system' }, { name: 'Newco', domains: ['newco.io'], status: 'prospect' });
    expect(s.itemRows[0]!.customerId).toBe(s.customerRows.at(-1)!.id);
    await deliver(s.service, id, secret, ticket('t2', 'sam@newco.io'));
    expect(s.customers.create).toHaveBeenCalledTimes(1); // the second sender reuses it
  });

  it('does not auto-create when the source says no, or for mailbox providers', async () => {
    const s = setup();
    const off = await createGeneric(s, { autoCreateCustomers: false });
    await deliver(s.service, off.id, off.secret, ticket('t1', 'ops@newco.io'));
    const on = await createGeneric(s);
    await deliver(s.service, on.id, on.secret, ticket('t2', 'someone@gmail.com'));
    await deliver(s.service, on.id, on.secret, { externalId: 't3', body: 'no email at all' });
    expect(s.customers.create).not.toHaveBeenCalled();
    expect(s.itemRows.map((i) => i.customerId)).toEqual([null, null, null]);
  });

  it('is idempotent: the same external ticket twice records one item and one customer', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s);
    const first = await deliver(s.service, id, secret, ticket('t1', 'ops@newco.io'));
    const second = await deliver(s.service, id, secret, ticket('t1', 'ops@newco.io'));
    expect(first.body['status']).toBe('processed');
    expect(second).toMatchObject({ httpStatus: 200, body: { status: 'duplicate' } });
    expect(s.itemRows).toHaveLength(1);
    expect(s.customers.create).toHaveBeenCalledTimes(1);
  });

  it('keeps ticket ids apart per source', async () => {
    const s = setup();
    const a = await createGeneric(s);
    const b = await createGeneric(s);
    await deliver(s.service, a.id, a.secret, ticket('same'));
    const res = await deliver(s.service, b.id, b.secret, ticket('same'));
    expect(res.body['status']).toBe('processed');
    expect(s.itemRows).toHaveLength(2);
  });

  it('files the workspace of the source, whatever the payload says', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s);
    await deliver(s.service, id, secret, { ...ticket('t1'), workspaceId: 'ws_2', sourceId: 'isrc_other' });
    expect(s.itemRows[0]).toMatchObject({ workspaceId: 'ws_1', sourceId: id });
  });

  it('attaches straight to the target project and records provenance on the request', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s, { targetProjectId: 'pj_1' });
    const res = await deliver(s.service, id, secret, ticket('t1'));
    expect(res.body).toMatchObject({ linked: true });
    expect(s.itemRows[0]).toMatchObject({ status: 'linked', projectId: 'pj_1', customerRequestId: 'crq_1' });
    expect(s.requestCalls[0]).toMatchObject({
      workspaceId: 'ws_1',
      actor: { type: 'system' },
      customerId: 'cus_acme',
      input: { projectId: 'pj_1', source: 'generic', externalId: 't1', sourceUrl: 'https://desk.example/t/t1', requesterEmail: 'jane@acme.com', body: '**SSO**\n\nWe need SAML' },
    });
  });

  it('attaches to an issue named by key, in the source workspace only', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s);
    await deliver(s.service, id, secret, { ...ticket('t1'), issueKey: 'bug-1' });
    expect(s.requestCalls[0]!.input).toMatchObject({ issueId: 'iss_1' }); // not iss_foreign of ws_2
    await deliver(s.service, id, secret, { ...ticket('t2'), issueKey: 'NOPE-9' });
    expect(s.itemRows[1]!.status).toBe('pending');
  });

  it('keeps the request in the inbox when the target cannot be linked any more', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s);
    s.customers.createRequest.mockRejectedValueOnce(new NotFoundException('gone'));
    await deliver(s.service, id, secret, { ...ticket('t1'), issueKey: 'BUG-1' });
    expect(s.itemRows[0]!.status).toBe('pending');
  });

  it('a disabled source accepts nothing', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s, { enabled: false });
    const res = await deliver(s.service, id, secret, ticket('t1'));
    expect(res).toMatchObject({ httpStatus: 202, body: { status: 'ignored' } });
    expect(s.itemRows).toHaveLength(0);
  });

  it('malformed payloads are a 400, pings are answered', async () => {
    const s = setup();
    const { id, secret } = await createGeneric(s);
    await expect(deliver(s.service, id, secret, { body: 'no id' })).rejects.toThrow(BadRequestException);
    const intercom = await s.service.createSource('ws_1', ACTOR, { provider: 'intercom', name: 'i', secret: 'k' }, 'u');
    expect((await deliver(s.service, intercom.source.id, 'k', { topic: 'ping' }, 'intercom')).body).toEqual({ status: 'pong' });
  });

  it('Slack answers with an ephemeral message', async () => {
    const s = setup();
    const slack = await s.service.createSource('ws_1', ACTOR, { provider: 'slack', name: 'Slack', secret: 'slack-signing' }, 'u');
    const form = new URLSearchParams({ text: 'jane@acme.com needs SSO', trigger_id: 'tr1', user_name: 'sam' }).toString();
    const rawBody = Buffer.from(form);
    const res = await s.service.receive({
      sourceId: slack.source.id,
      rawBody,
      payload: Object.fromEntries(new URLSearchParams(form)),
      headers: signIntakeDelivery('slack', 'slack-signing', rawBody),
    });
    expect(res.body).toEqual({ response_type: 'ephemeral', text: 'Recorded in the Trama inbox.' });
    expect(s.itemRows[0]).toMatchObject({ provider: 'slack', customerId: 'cus_acme' });
  });
});

describe('customer intake: test button', () => {
  it('reports what a sample delivery would do and saves nothing', async () => {
    const s = setup();
    const { id } = await createGeneric(s);
    const result = await s.service.testSource('ws_1', id);
    expect(result).toMatchObject({ ok: true, dryRun: true, status: 'processed', inbox: true });
    expect(s.itemRows).toHaveLength(0);
    expect(s.customers.create).not.toHaveBeenCalled();
    expect(result).toHaveProperty('wouldCreate.domain', 'example.org');
  });

  it('needs a secret to sign with, and stays in its workspace', async () => {
    const s = setup();
    const z = await s.service.createSource('ws_1', ACTOR, { provider: 'zendesk', name: 'z' }, 'u');
    await expect(s.service.testSource('ws_1', z.source.id)).rejects.toThrow(BadRequestException);
    await expect(s.service.testSource('ws_2', z.source.id)).rejects.toThrow(NotFoundException);
  });
});

describe('customer intake: triage', () => {
  async function pending(s: ReturnType<typeof setup>, email = 'jane@acme.com', id = 't1') {
    const src = await createGeneric(s, { autoCreateCustomers: false });
    await deliver(s.service, src.id, src.secret, ticket(id, email));
    return s.itemRows.at(-1)!;
  }

  it('links a pending item to an issue as the person, once', async () => {
    const s = setup();
    const item = await pending(s);
    const linked = await s.service.link('ws_1', ACTOR, item.id, { issueId: 'iss_1', important: true });
    expect(linked).toMatchObject({ status: 'linked', issueId: 'iss_1', customerRequestId: 'crq_1' });
    expect(s.requestCalls[0]).toMatchObject({ actor: ACTOR, customerId: 'cus_acme', input: { issueId: 'iss_1', important: true, source: 'generic', externalId: 't1' } });
    await expect(s.service.link('ws_1', ACTOR, item.id, { issueId: 'iss_1' })).rejects.toThrow(ConflictException);
    expect(s.requestCalls).toHaveLength(1);
  });

  it('needs exactly one target, a known item and a customer', async () => {
    const s = setup();
    const item = await pending(s, 'someone@gmail.com');
    await expect(s.service.link('ws_1', ACTOR, item.id, {})).rejects.toThrow(BadRequestException);
    await expect(s.service.link('ws_1', ACTOR, item.id, { issueId: 'iss_1', projectId: 'pj_1' })).rejects.toThrow(BadRequestException);
    await expect(s.service.link('ws_1', ACTOR, item.id, { issueId: 'iss_1' })).rejects.toThrow(BadRequestException); // no customer, free mail
    await expect(s.service.link('ws_1', ACTOR, item.id, { issueId: 'iss_1', createCustomer: true })).rejects.toThrow(BadRequestException);
    await expect(s.service.link('ws_1', ACTOR, 'cin_nope', { issueId: 'iss_1' })).rejects.toThrow(NotFoundException);
    expect(item.status).toBe('pending');
  });

  it('links to a hand-picked customer, but only one of the workspace', async () => {
    const s = setup();
    const item = await pending(s, 'someone@gmail.com');
    await expect(s.service.link('ws_1', ACTOR, item.id, { issueId: 'iss_1', customerId: 'cus_other' })).rejects.toThrow(NotFoundException);
    await s.service.link('ws_1', ACTOR, item.id, { projectId: 'pj_1', customerId: 'cus_acme' });
    expect(item).toMatchObject({ status: 'linked', customerId: 'cus_acme', projectId: 'pj_1' });
  });

  it('creates the customer from the sender domain when asked', async () => {
    const s = setup();
    const item = await pending(s, 'ops@newco.io');
    await s.service.link('ws_1', ACTOR, item.id, { issueId: 'iss_1', createCustomer: true, customerName: 'NewCo Inc' });
    expect(s.customers.create).toHaveBeenCalledWith('ws_1', ACTOR, { name: 'NewCo Inc', domains: ['newco.io'], status: 'prospect' });
    expect(item.status).toBe('linked');
  });

  it('releases the item when the request cannot be created', async () => {
    const s = setup();
    const item = await pending(s);
    await expect(s.service.link('ws_1', ACTOR, item.id, { issueId: 'iss_missing' })).rejects.toThrow(NotFoundException);
    expect(item.status).toBe('pending');
  });

  it('cannot touch another workspace\'s item', async () => {
    const s = setup();
    const item = await pending(s);
    await expect(s.service.link('ws_2', ACTOR, item.id, { issueId: 'iss_foreign' })).rejects.toThrow(NotFoundException);
    await expect(s.service.dismiss('ws_2', item.id)).rejects.toThrow(NotFoundException);
    expect(await s.service.listItems('ws_2')).toEqual([]);
  });

  it('dismisses and restores', async () => {
    const s = setup();
    const item = await pending(s);
    expect((await s.service.dismiss('ws_1', item.id)).status).toBe('dismissed');
    await expect(s.service.dismiss('ws_1', item.id)).rejects.toThrow(ConflictException);
    expect(await s.service.pendingCount('ws_1')).toBe(0);
    expect((await s.service.restore('ws_1', item.id)).status).toBe('pending');
    expect(await s.service.pendingCount('ws_1')).toBe(1);
  });
});
