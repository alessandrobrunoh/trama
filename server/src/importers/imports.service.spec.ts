import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../contracts/domain.js';
import type { RefsService } from '../common/refs.service.js';
import { IntegrationConnectionEntity } from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import { HttpClient, type HttpRequest, type HttpResponse } from '../integrations/http-client.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { CredentialsService, providerFailure } from './credentials.service.js';
import { ImportJobEntity, TrackerCredentialEntity } from './entities.js';
import type { ImportRunnerService } from './import-runner.service.js';
import { ImportsService, normalizeSource, parseRepository } from './imports.service.js';

process.env.TRAMA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const secrets = new SecretsService();
const ADMIN: ActorRef = { type: 'user', id: 'usr_admin' };
const TOKEN = 'lin_api_0123456789abcdef0123456789abcdef';

type Where = Record<string, unknown>;
const matches = (row: object, where: Where) =>
  Object.entries(where).every(([k, v]) => {
    const actual = (row as Record<string, unknown>)[k];
    // In([...]) is a FindOperator holding its list in `_value`
    return v && typeof v === 'object' && Array.isArray((v as { _value?: unknown })._value) ? ((v as { _value: unknown[] })._value).includes(actual) : actual === v;
  });

/** Just enough of a TypeORM repository, filtering by every key of `where` (so a missing workspaceId would show). */
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
    findBy: async (w: Where) => rows.filter((r) => matches(r, w)),
    find: async (o: { where: Where }) => rows.filter((r) => matches(r, o.where)),
    existsBy: async (w: Where) => rows.some((r) => matches(r, w)),
    update: async (w: Where, patch: Partial<T>) => {
      for (const r of rows.filter((x) => matches(x, w))) Object.assign(r, patch);
    },
    delete: async (w: Where) => {
      for (const r of rows.filter((x) => matches(x, w))) rows.splice(rows.indexOf(r), 1);
    },
  };
}

class ScriptedHttp extends HttpClient {
  readonly calls: HttpRequest[] = [];
  constructor(private readonly answer: (req: HttpRequest) => Partial<HttpResponse>) {
    super();
  }
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    return { status: 200, headers: {}, json: null, ...this.answer(req) };
  }
}

function setup(http: HttpClient = new ScriptedHttp(() => ({ json: { data: { viewer: { id: 'v', name: 'Ada' } } } }))) {
  const credRows: TrackerCredentialEntity[] = [];
  const credRepo = fakeRepo<TrackerCredentialEntity>(credRows, (x) => Object.assign(new TrackerCredentialEntity(), x));
  const connRepo = fakeRepo<IntegrationConnectionEntity>([], (x) => Object.assign(new IntegrationConnectionEntity(), x));
  const credentials = new CredentialsService(http, secrets, credRepo as unknown as Repository<TrackerCredentialEntity>, connRepo as unknown as Repository<IntegrationConnectionEntity>);

  const jobRows: ImportJobEntity[] = [];
  const jobRepo = fakeRepo<ImportJobEntity>(jobRows, (x) => Object.assign(new ImportJobEntity(), x));
  const teams: Record<string, string[]> = { ws_1: ['tm_1'], ws_2: ['tm_other'] };
  const refs = {
    teams: vi.fn(async (ws: string, ids: string[]) => {
      if (ids.some((id) => !teams[ws]?.includes(id))) throw new BadRequestException(`Unknown team in: ${ids.join(', ')}`);
    }),
    projects: vi.fn(async () => undefined),
    users: vi.fn(async () => undefined),
  };
  const events = { record: vi.fn(async () => undefined) };
  const runner = { kick: vi.fn(async () => true) };
  const ds = { getRepository: () => ({ findOneByOrFail: async () => ({ settings: {} }) }) } as unknown as DataSource;
  const service = new ImportsService(
    ds,
    http,
    refs as unknown as RefsService,
    events as unknown as EventsService,
    credentials,
    runner as unknown as ImportRunnerService,
    jobRepo as unknown as Repository<ImportJobEntity>,
  );
  return { service, credentials, credRows, jobRows, refs, events, runner, http };
}

describe('source parsing', () => {
  it('accepts owner/name or a GitHub URL for a repository', () => {
    expect(parseRepository('acme/api')).toBe('acme/api');
    expect(parseRepository('https://github.com/acme/api')).toBe('acme/api');
    expect(parseRepository('https://github.com/acme/api.git')).toBe('acme/api');
    expect(parseRepository('https://github.com/acme/api/issues/4')).toBe('acme/api');
  });

  it.each(['', 'acme', 'acme/api/../../x', 'a b/c', 'acme/ap;i', '../etc/passwd'])('rejects %j', (bad) => {
    expect(() => parseRepository(bad)).toThrow(BadRequestException);
  });

  it('validates Linear team ids and drops duplicates', () => {
    expect(normalizeSource('linear', { teamIds: ['a', 'a', 'b_1'] })).toEqual({ teamIds: ['a', 'b_1'] });
    expect(() => normalizeSource('linear', { teamIds: ['ok', 'bad id!'] })).toThrow(BadRequestException);
  });
});

describe('credentials', () => {
  it('stores the token encrypted and never serializes it', async () => {
    const s = setup();
    const created = await s.credentials.create('ws_1', ADMIN, { provider: 'linear', token: TOKEN });
    expect(created.account).toBe('Ada');
    expect(s.credRows[0].secret).not.toContain(TOKEN);
    expect(JSON.stringify(created)).not.toContain(TOKEN);
    expect(JSON.stringify(created)).not.toContain(s.credRows[0].secret);
    expect(Object.keys(created.toJSON())).not.toContain('secret');
    await expect(s.credentials.resolve('ws_1', 'linear', { credentialId: created.id })).resolves.toEqual({ token: TOKEN, baseUrl: null });
  });

  it('updates the same credential when the same account is added again', async () => {
    const s = setup();
    const a = await s.credentials.create('ws_1', ADMIN, { provider: 'linear', token: TOKEN });
    const b = await s.credentials.create('ws_1', ADMIN, { provider: 'linear', token: `${TOKEN}2` });
    expect(b.id).toBe(a.id);
    expect(s.credRows).toHaveLength(1);
  });

  it('does not let one workspace use another workspace credential', async () => {
    const s = setup();
    const mine = await s.credentials.create('ws_1', ADMIN, { provider: 'linear', token: TOKEN });
    await expect(s.credentials.resolve('ws_2', 'linear', { credentialId: mine.id })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.credentials.remove('ws_2', mine.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(s.credRows).toHaveLength(1);
  });

  it('refuses a credential of the wrong provider', async () => {
    const s = setup();
    const mine = await s.credentials.create('ws_1', ADMIN, { provider: 'linear', token: TOKEN });
    await expect(s.credentials.resolve('ws_1', 'github', { credentialId: mine.id })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('needs a credential for Linear but not for a public GitHub repository', async () => {
    const s = setup();
    await expect(s.credentials.resolve('ws_1', 'linear', {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.credentials.resolve('ws_1', 'github', {})).resolves.toEqual({ token: null, baseUrl: null });
    await expect(s.credentials.resolve('ws_1', 'github', { credentialId: 'a', connectionId: 'b' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a bad token without echoing it', async () => {
    const http = new ScriptedHttp(() => ({ status: 401, json: { errors: [{ message: `bad key ${TOKEN}` }] } }));
    const s = setup(http);
    const err = (await s.credentials.create('ws_1', ADMIN, { provider: 'linear', token: TOKEN }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).not.toContain(TOKEN);
    expect(s.credRows).toHaveLength(0);
  });

  it('only contacts hosts an admin configured when linking', async () => {
    const s = setup();
    await expect(s.credentials.forHost('ws_1', 'github', 'ghe.example.com')).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.credentials.forHost('ws_1', 'github', 'github.com')).resolves.toEqual({ token: null, baseUrl: null });
    await expect(s.credentials.forHost('ws_1', 'linear', 'linear.app')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('providerFailure', () => {
  it('scrubs the token from whatever the provider said', () => {
    const e = providerFailure('GitHub', new Error(`connect failed for ${TOKEN}`), [TOKEN]);
    expect(e.message).not.toContain(TOKEN);
  });
});

describe('import jobs', () => {
  const request = { provider: 'linear' as const, source: { teamIds: [] }, mapping: { teams: {}, projects: {}, labels: {}, users: {}, statuses: {} } };

  async function withCredential(s: ReturnType<typeof setup>, ws = 'ws_1') {
    return (await s.credentials.create(ws, ADMIN, { provider: 'linear', token: TOKEN })).id;
  }

  it('queues a job, records the start and kicks the runner', async () => {
    const s = setup();
    const credentialId = await withCredential(s);
    const job = await s.service.start('ws_1', ADMIN, { ...request, credentialId });
    expect(job).toMatchObject({ workspaceId: 'ws_1', status: 'queued', provider: 'linear', createdBy: ADMIN });
    expect(job.id).toMatch(/^imp_/);
    expect(s.events.record).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws_1', type: 'import.started', subject: { type: 'import', id: job.id } }));
    expect(s.runner.kick).toHaveBeenCalledWith(job.id);
  });

  it('never returns the credential reference, the cursor or any token', async () => {
    const s = setup();
    const credentialId = await withCredential(s);
    const job = await s.service.start('ws_1', ADMIN, { ...request, credentialId });
    const json = JSON.stringify(job);
    expect(json).not.toContain(credentialId);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('"cursor"');
  });

  it('refuses a mapping that points at another workspace', async () => {
    const s = setup();
    const credentialId = await withCredential(s);
    await expect(
      s.service.start('ws_1', ADMIN, { ...request, credentialId, mapping: { ...request.mapping, teams: { t: { action: 'map', id: 'tm_other' } } } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s.jobRows).toHaveLength(0);
  });

  it('allows one active import per workspace', async () => {
    const s = setup();
    const credentialId = await withCredential(s);
    await s.service.start('ws_1', ADMIN, { ...request, credentialId });
    await expect(s.service.start('ws_1', ADMIN, { ...request, credentialId })).rejects.toBeInstanceOf(ConflictException);
    // another workspace is not affected
    const other = await withCredential(s, 'ws_2');
    await expect(s.service.start('ws_2', ADMIN, { ...request, credentialId: other })).resolves.toMatchObject({ workspaceId: 'ws_2' });
  });

  it('refuses to start without a credential for Linear', async () => {
    const s = setup();
    await expect(s.service.start('ws_1', ADMIN, request)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('scopes get, list, cancel and delete to the workspace', async () => {
    const s = setup();
    const credentialId = await withCredential(s);
    const job = await s.service.start('ws_1', ADMIN, { ...request, credentialId });
    await expect(s.service.get('ws_2', job.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.cancel('ws_2', job.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.retry('ws_2', job.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.remove('ws_2', job.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await s.service.get('ws_1', job.id)).toBe(job);
  });

  it('retries only failed jobs and deletes only finished ones', async () => {
    const s = setup();
    const credentialId = await withCredential(s);
    const job = await s.service.start('ws_1', ADMIN, { ...request, credentialId });
    await expect(s.service.retry('ws_1', job.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(s.service.remove('ws_1', job.id)).rejects.toBeInstanceOf(ConflictException);
    job.status = 'failed';
    await expect(s.service.remove('ws_1', job.id)).resolves.toBeUndefined();
    expect(s.jobRows).toHaveLength(0);
  });
});
