import http from 'node:http';
import https from 'node:https';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { ActorRef } from '../contracts/domain.js';
import { notFound } from '../common/util.js';
import {
  HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../integrations/http-client.js';
import { SecretsService } from '../integrations/secrets.service.js';
import type { ProjectsService } from '../projects/projects.service.js';
import { IssueEntity } from '../database/entities/index.js';
import {
  LunaGestConnectionEntity,
  LunaGestIssueLinkEntity,
  LunaGestProjectLinkEntity,
} from './entities.js';
import { LunagestService } from './lunagest.service.js';

process.env.TRAMA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const USER = 'ada@example.com';
const PASSWORD = 'pw_luna_9f3c_do_not_leak';
const API_KEY = 'key_luna_9f3c_do_not_leak';
const TOKEN = 'tok_luna_9f3c_do_not_leak';
const ADMIN: ActorRef = { type: 'user', id: 'usr_admin' };
const CREDS = { username: USER, password: PASSWORD, apiKey: API_KEY };
const PROJECTS: Record<string, string[]> = {
  ws_1: ['pj_1', 'pj_2'],
  ws_2: ['pj_other'],
};

/** Every request the fakes accepted. Checked after each test so a write to LunaGest cannot slip through. */
const seen: HttpRequest[] = [];

let httpsRequest: { mockRestore: () => void; mock: { calls: unknown[] } };
let httpRequest: { mockRestore: () => void; mock: { calls: unknown[] } };

beforeAll(() => {
  httpsRequest = vi.spyOn(https, 'request').mockImplementation(() => {
    throw new Error('unexpected HTTPS request');
  });
  httpRequest = vi.spyOn(http, 'request').mockImplementation(() => {
    throw new Error('unexpected HTTP request');
  });
});

afterAll(() => {
  httpsRequest.mockRestore();
  httpRequest.mockRestore();
});

afterEach(() => {
  for (const call of seen) {
    const method = call.method ?? 'GET';
    expect(method === 'GET' || method === 'POST' || method === 'PUT').toBe(true);
    expect(call.url.startsWith('https://')).toBe(true);
    if (method === 'POST') {
      expect(
        call.url.includes('/auth/v1/token?grant_type=password') ||
          call.url.includes('resource=tasks'),
      ).toBe(true);
    }
    if (method === 'PUT') {
      expect(call.url).toContain('resource=tasks');
      expect(call.url).toContain('id=');
    }
    if (method === 'GET' || method === 'PUT') {
      expect(
        JSON.stringify({
          url: call.url,
          headers: call.headers,
          body: call.body ?? null,
        }),
      ).not.toContain(PASSWORD);
      expect(JSON.stringify(call.body ?? null)).not.toContain(API_KEY);
    }
    if (call.url.includes('/functions/v1/')) {
      expect(
        call.url.includes('resource=projects') || call.url.includes('resource=tasks'),
      ).toBe(true);
    }
  }
  seen.length = 0;
  expect(httpsRequest.mock.calls).toHaveLength(0);
  expect(httpRequest.mock.calls).toHaveLength(0);
});

/** Stands in for HttpClient. Records the call and never opens a socket. */
class ScriptedHttp extends HttpClient {
  readonly calls: HttpRequest[] = [];
  constructor(
    private readonly answer: (req: HttpRequest) => Partial<HttpResponse>,
  ) {
    super();
  }
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    seen.push(req);
    return { status: 200, headers: {}, json: null, ...this.answer(req) };
  }
}

type Where = Record<string, unknown>;
const matches = (row: object, where: Where) =>
  Object.entries(where).every(
    ([k, v]) => (row as Record<string, unknown>)[k] === v,
  );

function fakeRepo<T extends object>(
  rows: T[],
  make: (x: Partial<T>) => T,
  key: (row: T) => string,
) {
  return {
    create: (x: Partial<T>) => make(x),
    save: async (x: T) => {
      const i = rows.findIndex((r) => key(r) === key(x));
      if (i >= 0) rows[i] = x;
      else rows.push(x);
      return x;
    },
    findOneBy: async (w: Where) => rows.find((r) => matches(r, w)) ?? null,
    delete: async (w: Where) => {
      for (let i = rows.length - 1; i >= 0; i--)
        if (matches(rows[i], w)) rows.splice(i, 1);
    },
    find: async (opts?: { where?: Where }) =>
      rows.filter((row) => !opts?.where || matches(row, opts.where)),
  };
}

function projects(): ProjectsService {
  return {
    get: async (workspaceId: string, id: string) => {
      if (!PROJECTS[workspaceId]?.includes(id)) throw notFound('Project', id);
      return { id, workspaceId };
    },
  } as unknown as ProjectsService;
}

function setup(http: HttpClient) {
  process.env.TRAMA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const secrets = new SecretsService();
  const connections: LunaGestConnectionEntity[] = [];
  const links: LunaGestProjectLinkEntity[] = [];
  const issueLinks: LunaGestIssueLinkEntity[] = [];
  const issues: IssueEntity[] = [];
  const service = new LunagestService(
    http,
    secrets,
    fakeRepo(
      connections,
      (x) => Object.assign(new LunaGestConnectionEntity(), x),
      (r) => r.id,
    ) as unknown as Repository<LunaGestConnectionEntity>,
    fakeRepo(
      links,
      (x) => Object.assign(new LunaGestProjectLinkEntity(), x),
      (r) => r.projectId,
    ) as unknown as Repository<LunaGestProjectLinkEntity>,
    fakeRepo(
      issueLinks,
      (x) => Object.assign(new LunaGestIssueLinkEntity(), x),
      (r) => r.issueId,
    ) as unknown as Repository<LunaGestIssueLinkEntity>,
    fakeRepo(
      issues,
      (x) => Object.assign(new IssueEntity(), x),
      (r) => r.id,
    ) as unknown as Repository<IssueEntity>,
    projects(),
  );
  return { service, connections, links, issueLinks, issues, secrets, http };
}

function route(projectsJson: unknown) {
  return (req: HttpRequest): Partial<HttpResponse> => {
    if (req.url.includes('/auth/v1/token?grant_type=password'))
      return { json: { access_token: TOKEN } };
    if (req.url.includes('/functions/v1/pm?resource=projects'))
      return { json: projectsJson };
    throw new Error(`unexpected ${req.method ?? 'GET'} ${req.url}`);
  };
}

function rejectionText(err: unknown): string {
  const error = err as BadRequestException;
  return `${error.message} ${JSON.stringify(error.getResponse())}`;
}

describe('LunaGest connection', () => {
  it('connection JSON has no secret, password, or apiKey', async () => {
    const http = new ScriptedHttp(route([]));
    const s = setup(http);
    const view = await s.service.saveConnection('ws_1', ADMIN, CREDS);
    expect(view).toEqual({
      configured: true,
      id: s.connections[0].id,
      baseUrl: 'https://panel.lunagest.com',
      account: USER,
      updatedAt: s.connections[0].updatedAt,
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain(PASSWORD);
    expect(json).not.toContain(API_KEY);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('secret');
    expect(json).not.toContain('password');
    expect(json).not.toContain('apiKey');
    expect(Object.keys(s.connections[0].toJSON())).not.toContain('secret');
    expect(s.connections[0].secret).not.toContain(PASSWORD);
    expect(s.connections[0].secret).not.toContain(API_KEY);
    expect(JSON.stringify(await s.service.getConnection('ws_1'))).toBe(json);
    expect(http.calls[0].body).toEqual({ email: USER, password: PASSWORD });
    expect(http.calls[0].headers).toMatchObject({
      apikey: API_KEY,
      'content-type': 'application/json',
    });
    expect(http.calls[0].url).not.toContain(PASSWORD);
    expect(http.calls[0].url).not.toContain(API_KEY);
  });

  it('failed login does not persist a connection and the error text does not contain the password or apiKey', async () => {
    const http = new ScriptedHttp(() => ({
      status: 401,
      json: {
        message: `nope ${PASSWORD} ${API_KEY}`,
        access_token: { leaked: PASSWORD },
      },
    }));
    const s = setup(http);
    const err = await s.service
      .saveConnection('ws_1', ADMIN, CREDS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const text = rejectionText(err);
    expect(text).toContain('LunaGest rejected the login');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(API_KEY);
    expect(s.connections).toHaveLength(0);
  });

  it('successful login then GET projects persists the connection', async () => {
    const http = new ScriptedHttp(route([{ id: 'rp_1', name: 'Alpha' }]));
    const s = setup(http);
    await s.service.saveConnection('ws_1', ADMIN, {
      ...CREDS,
      baseUrl: 'https://luna.example.com/',
    });
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].baseUrl).toBe('https://luna.example.com');
    expect(s.connections[0].account).toBe(USER);
    expect(
      JSON.parse(
        s.secrets.decrypt(
          s.connections[0].secret,
          `${s.connections[0].id}:lunagest`,
        ),
      ),
    ).toEqual(CREDS);
    expect(http.calls.map((c) => c.method)).toEqual(['POST']);

    await s.service.bind('ws_1', 'pj_1', 'rp_1');
    expect(s.connections).toHaveLength(1);
    expect(http.calls.map((c) => c.method ?? 'GET')).toEqual([
      'POST',
      'POST',
      'GET',
    ]);
    expect(http.calls[2].url).toBe(
      'https://luna.example.com/functions/v1/pm?resource=projects',
    );
    expect(http.calls[2].headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('does not replace a saved connection when a later login fails', async () => {
    let allow = true;
    const http = new ScriptedHttp(() => {
      if (!allow)
        return {
          status: 401,
          json: { message: `nope ${PASSWORD} other-password other-key` },
        };
      return { json: { access_token: TOKEN } };
    });
    const s = setup(http);
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    const secret = s.connections[0].secret;
    allow = false;
    const err = await s.service
      .saveConnection('ws_1', ADMIN, {
        ...CREDS,
        password: 'other-password',
        apiKey: 'other-key',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(rejectionText(err)).not.toContain('other-password');
    expect(rejectionText(err)).not.toContain('other-key');
    expect(s.connections).toHaveLength(1);
    expect(s.connections[0].secret).toBe(secret);
  });

  it('does not call LunaGest or persist when baseUrl is not an https origin', async () => {
    const http = new ScriptedHttp(route([]));
    const s = setup(http);
    for (const baseUrl of [
      'http://panel.lunagest.com',
      'https://user:secret@panel.lunagest.com',
      'https://panel.lunagest.com/extra',
      'https://panel.lunagest.com?x=1',
      'not a url',
    ]) {
      const err = await s.service
        .saveConnection('ws_1', ADMIN, { ...CREDS, baseUrl })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(rejectionText(err)).not.toContain(PASSWORD);
      expect(rejectionText(err)).not.toContain(API_KEY);
    }
    expect(http.calls).toHaveLength(0);
    expect(s.connections).toHaveLength(0);
  });

  it('delete connection removes the row', async () => {
    const s = setup(new ScriptedHttp(route([])));
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    await s.service.saveConnection('ws_2', ADMIN, {
      ...CREDS,
      username: 'bea@example.com',
    });
    await s.service.removeConnection('ws_1');
    expect(s.connections.map((c) => c.workspaceId)).toEqual(['ws_2']);
    await expect(s.service.getConnection('ws_1')).resolves.toEqual({
      configured: false,
    });
  });

  it('lists remote projects for the picker and refuses when nothing is saved', async () => {
    const http = new ScriptedHttp(
      route([
        { id: 'rp_1', name: 'Alpha', code: 'A' },
        { id: 5, name: 'Dropped' },
      ]),
    );
    const s = setup(http);
    const missing = await s.service
      .listRemoteProjects('ws_1')
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(BadRequestException);
    expect(http.calls).toHaveLength(0);

    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    const listed = await s.service.listRemoteProjects('ws_1');
    expect(listed).toEqual({ projects: [{ id: 'rp_1', name: 'Alpha' }] });
    expect(JSON.stringify(listed)).not.toContain(PASSWORD);
    expect(JSON.stringify(listed)).not.toContain(API_KEY);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
  });
});

describe('LunaGest project binding', () => {
  const listed = {
    ok: true,
    projects: [
      { id: 'rp_1', name: 'Alpha', code: 'A', status: 'active' },
      { id: 5, name: 'Not a string id' },
      { name: 'No id' },
    ],
  };

  it('binding stores remoteProjectId and remoteProjectName from the fake list', async () => {
    const s = setup(new ScriptedHttp(route(listed)));
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    const linked = await s.service.bind('ws_1', 'pj_1', 'rp_1');
    expect(linked).toEqual({
      state: 'linked',
      remoteProjectId: 'rp_1',
      remoteProjectName: 'Alpha',
      updatedAt: s.links[0].updatedAt,
    });
    expect(s.links).toEqual([
      expect.objectContaining({
        projectId: 'pj_1',
        workspaceId: 'ws_1',
        connectionId: s.connections[0].id,
        remoteProjectId: 'rp_1',
        remoteProjectName: 'Alpha',
      }),
    ]);
    expect(await s.service.getLink('ws_1', 'pj_1')).toEqual(linked);
  });

  it('binding an unknown remote id fails and writes no link', async () => {
    const http = new ScriptedHttp(route(listed));
    const s = setup(http);
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    const err = await s.service
      .bind('ws_1', 'pj_1', 'missing')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(rejectionText(err)).not.toContain(PASSWORD);
    expect(rejectionText(err)).not.toContain(API_KEY);
    expect(s.links).toHaveLength(0);
    const numeric = await s.service
      .bind('ws_1', 'pj_1', '5')
      .catch((e: unknown) => e);
    expect(numeric).toBeInstanceOf(BadRequestException);
    expect(s.links).toHaveLength(0);
  });

  it('the same remote id cannot bind a second project', async () => {
    const s = setup(new ScriptedHttp(route(listed)));
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    await s.service.bind('ws_1', 'pj_1', 'rp_1');
    const err = await s.service
      .bind('ws_1', 'pj_2', 'rp_1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(s.links.map((link) => link.projectId)).toEqual(['pj_1']);
    await expect(s.service.getLink('ws_1', 'pj_2')).resolves.toEqual({
      state: 'unlinked',
    });
  });

  it('a project with no link reports unlinked', async () => {
    const http = new ScriptedHttp(route(listed));
    const s = setup(http);
    await expect(s.service.getLink('ws_1', 'pj_1')).resolves.toEqual({
      state: 'unlinked',
    });
    await expect(s.service.unbind('ws_1', 'pj_1')).resolves.toBeUndefined();
    await expect(s.service.bind('ws_1', 'pj_1', 'rp_1')).rejects.toThrow(
      'Save a LunaGest connection first',
    );
    await expect(s.service.getLink('ws_1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(http.calls).toHaveLength(0);
  });

  it('retries a 401 project list once and does not loop', async () => {
    let logins = 0;
    let lists = 0;
    const http = new ScriptedHttp((req) => {
      if (req.url.includes('/auth/v1/token')) {
        logins += 1;
        if (logins > 2) throw new Error('login loop');
        return { json: { access_token: `tok-${logins}` } };
      }
      lists += 1;
      if (lists > 2) throw new Error('list loop');
      if (lists === 1)
        return { status: 401, json: { message: PASSWORD, hint: API_KEY } };
      return { json: [{ id: 'rp_1', name: 'Alpha' }] };
    });
    const s = setup(http);
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    logins = 0;
    const linked = await s.service.bind('ws_1', 'pj_1', 'rp_1');
    expect(linked).toMatchObject({
      state: 'linked',
      remoteProjectId: 'rp_1',
      remoteProjectName: 'Alpha',
    });
    expect(JSON.stringify(linked)).not.toContain(PASSWORD);
    expect(JSON.stringify(linked)).not.toContain(API_KEY);
    expect(logins).toBe(2);
    expect(lists).toBe(2);
    const gets = http.calls.filter((c) => (c.method ?? 'GET') === 'GET');
    expect(gets.map((c) => c.headers?.Authorization)).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ]);
  });

  it('writes no link when the project list stays unauthorized', async () => {
    let logins = 0;
    let lists = 0;
    const http = new ScriptedHttp((req) => {
      if (req.url.includes('/auth/v1/token')) {
        logins += 1;
        if (logins > 2) throw new Error('login loop');
        return { json: { access_token: TOKEN } };
      }
      lists += 1;
      if (lists > 2) throw new Error('list loop');
      return {
        status: 401,
        json: { message: `denied ${PASSWORD}`, apiKey: API_KEY },
      };
    });
    const s = setup(http);
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    logins = 0;
    const err = await s.service
      .bind('ws_1', 'pj_1', 'rp_1')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    const text = rejectionText(err);
    expect(text).toContain('LunaGest did not return projects');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(API_KEY);
    expect(logins).toBe(2);
    expect(lists).toBe(2);
    expect(s.links).toHaveLength(0);
    expect(s.connections).toHaveLength(1);
  });
});

describe('LunaGest task push', () => {
  const created = {
    created: true,
    titleChanged: true,
    bodyChanged: true,
    projectChanged: false,
  };

  async function linkedProject(
    answer: (req: HttpRequest) => Partial<HttpResponse>,
  ) {
    const http = new ScriptedHttp((req) => {
      if (req.url.includes('/auth/v1/token?grant_type=password'))
        return { json: { access_token: TOKEN } };
      if (req.url.includes('resource=projects'))
        return { json: [{ id: 'rp_1', name: 'Alpha' }] };
      return answer(req);
    });
    const s = setup(http);
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    await s.service.bind('ws_1', 'pj_1', 'rp_1');
    http.calls.length = 0;
    return { http, s };
  }

  function remember(
    s: ReturnType<typeof setup>,
    issue: { id: string; title: string; body: string | null },
  ) {
    s.issues.push(
      Object.assign(new IssueEntity(), {
        ...issue,
        workspaceId: 'ws_1',
        key: issue.id.toUpperCase(),
        projectId: 'pj_1',
      }),
    );
  }

  it('stores the remote id on 201 and updates that id with PUT', async () => {
    const { http, s } = await linkedProject((req) => {
      if (req.method === 'POST') return { status: 201, json: { id: 'task_1' } };
      if (req.method === 'PUT') return { status: 200, json: { id: 'task_1' } };
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    await s.service.afterIssueSaved(
      'ws_1',
      { id: 'in_1', projectId: 'pj_1', title: 'Fix', body: 'desc' },
      created,
    );
    expect(s.issueLinks[0]).toMatchObject({
      remoteTaskId: 'task_1',
      state: 'linked',
      lastError: null,
    });
    const post = http.calls.find(
      (call) => call.method === 'POST' && call.url.includes('resource=tasks'),
    );
    expect(post?.body).toEqual({
      title: 'Fix',
      description: 'desc',
      project_id: 'rp_1',
    });

    http.calls.length = 0;
    await s.service.afterIssueSaved(
      'ws_1',
      { id: 'in_1', projectId: 'pj_1', title: 'Fix 2', body: 'desc' },
      {
        created: false,
        titleChanged: true,
        bodyChanged: false,
        projectChanged: false,
      },
    );
    const put = http.calls.find((call) => call.method === 'PUT');
    expect(put?.url).toContain('id=task_1');
    expect(put?.body).toEqual({ title: 'Fix 2', description: 'desc' });
    expect(
      http.calls.some(
        (call) => call.method === 'POST' && call.url.includes('resource=tasks'),
      ),
    ).toBe(false);
    expect(s.issueLinks).toHaveLength(1);
    expect(s.issueLinks[0].remoteTaskId).toBe('task_1');
  });

  it('keeps the issue with no remote id when the create returns 500', async () => {
    const { s } = await linkedProject(() => ({
      status: 500,
      json: { message: `nope ${PASSWORD}`, apiKey: API_KEY },
    }));
    await expect(
      s.service.afterIssueSaved(
        'ws_1',
        { id: 'in_1', projectId: 'pj_1', title: 'Fix', body: null },
        created,
      ),
    ).resolves.toBeUndefined();
    expect(s.issueLinks).toHaveLength(1);
    expect(s.issueLinks[0].remoteTaskId).toBeNull();
    expect(s.issueLinks[0].state).toBe('push_failed');
    expect(s.issueLinks[0].lastError).toBe('LunaGest did not accept the task');
    expect(s.issueLinks[0].lastError).not.toContain(PASSWORD);
    expect(s.issueLinks[0].lastError).not.toContain(API_KEY);
  });

  it('rejects a remote task that is already linked to another issue', async () => {
    const { s } = await linkedProject((req) => {
      if (req.url.includes('resource=tasks'))
        return { json: [{ id: 'task_9', title: 'Remote' }] };
      throw new Error(`unexpected ${req.method} ${req.url}`);
    });
    remember(s, { id: 'in_1', title: 'One', body: null });
    remember(s, { id: 'in_2', title: 'Two', body: null });
    await s.service.linkIssueTask('ws_1', 'in_1', 'task_9');
    const err = await s.service
      .linkIssueTask('ws_1', 'in_2', 'task_9')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(rejectionText(err)).toContain('already linked');
    expect(s.issueLinks.map((link) => link.issueId)).toEqual(['in_1']);
    expect(s.issueLinks[0].remoteTaskId).toBe('task_9');
  });
});

describe('LunaGest realign', () => {
  async function ready(
    local: { title: string; body: string | null },
    remote: { title: string; description: string },
    base: { title: string; body: string },
  ) {
    const http = new ScriptedHttp((req) => {
      if (req.url.includes('/auth/v1/token?grant_type=password'))
        return { json: { access_token: TOKEN } };
      if (req.url.includes('resource=projects'))
        return { json: [{ id: 'rp_1', name: 'Alpha' }] };
      if (req.url.includes('resource=tasks')) return { json: [{ id: 'task_1', ...remote }] };
      throw new Error(`unexpected ${req.method ?? 'GET'} ${req.url}`);
    });
    const s = setup(http);
    await s.service.saveConnection('ws_1', ADMIN, CREDS);
    await s.service.bind('ws_1', 'pj_1', 'rp_1');
    s.issues.push(
      Object.assign(new IssueEntity(), {
        id: 'in_1',
        workspaceId: 'ws_1',
        key: 'IN-1',
        projectId: 'pj_1',
        title: local.title,
        body: local.body,
      }),
    );
    s.issueLinks.push(
      Object.assign(new LunaGestIssueLinkEntity(), {
        issueId: 'in_1',
        workspaceId: 'ws_1',
        remoteTaskId: 'task_1',
        state: 'linked',
        lastError: null,
        syncedTitle: base.title,
        syncedBody: base.body,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    http.calls.length = 0;
    return { http, s };
  }

  it('pulls a title that changed only on LunaGest and does not write back', async () => {
    const { http, s } = await ready(
      { title: 'Same', body: 'Body' },
      { title: 'Remote title', description: 'Body' },
      { title: 'Same', body: 'Body' },
    );
    const result = await s.service.realign('ws_1', ADMIN, 'pj_1');
    expect(result.pulled).toEqual([{ issueId: 'in_1', field: 'title' }]);
    expect(result.pushed).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(s.issues[0].title).toBe('Remote title');
    expect(s.issueLinks[0].syncedTitle).toBe('Remote title');
    expect(http.calls.some((call) => call.method === 'PUT' || (call.method === 'POST' && call.url.includes('resource=tasks')))).toBe(false);
  });

  it('pushes a title that changed only in Trama', async () => {
    const { http, s } = await ready(
      { title: 'Local title', body: 'Body' },
      { title: 'Same', description: 'Body' },
      { title: 'Same', body: 'Body' },
    );
    const result = await s.service.realign('ws_1', ADMIN, 'pj_1');
    expect(result.pushed).toEqual([{ issueId: 'in_1', field: 'title' }]);
    expect(result.pulled).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(s.issues[0].title).toBe('Local title');
    const put = http.calls.find((call) => call.method === 'PUT');
    expect(put?.body).toEqual({ title: 'Local title', description: 'Body' });
    expect(s.issueLinks[0].syncedTitle).toBe('Local title');
  });

  it('does not write when title changed on both sides', async () => {
    const { http, s } = await ready(
      { title: 'Local title', body: 'Body' },
      { title: 'Remote title', description: 'Body' },
      { title: 'Same', body: 'Body' },
    );
    const result = await s.service.realign('ws_1', ADMIN, 'pj_1');
    expect(result.conflicts).toEqual([
      {
        issueId: 'in_1',
        issueKey: 'IN-1',
        field: 'title',
        local: 'Local title',
        remote: 'Remote title',
      },
    ]);
    expect(result.pulled).toEqual([]);
    expect(result.pushed).toEqual([]);
    expect(s.issues[0].title).toBe('Local title');
    expect(s.issueLinks[0].syncedTitle).toBe('Same');
    expect(http.calls.some((call) => call.method === 'PUT')).toBe(false);

    const chosen = await s.service.realign('ws_1', ADMIN, 'pj_1', [
      { issueId: 'in_1', field: 'title', take: 'remote' },
    ]);
    expect(chosen.conflicts).toEqual([]);
    expect(chosen.pulled).toEqual([{ issueId: 'in_1', field: 'title' }]);
    expect(s.issues[0].title).toBe('Remote title');
    expect(s.issueLinks[0].syncedTitle).toBe('Remote title');
  });

  it('does not create a remote task for an issue that was never linked', async () => {
    const { http, s } = await ready(
      { title: 'Same', body: 'Body' },
      { title: 'Same', description: 'Body' },
      { title: 'Same', body: 'Body' },
    );
    s.issues.push(
      Object.assign(new IssueEntity(), {
        id: 'in_2',
        workspaceId: 'ws_1',
        key: 'IN-2',
        projectId: 'pj_1',
        title: 'Local only',
        body: null,
      }),
    );
    const result = await s.service.realign('ws_1', ADMIN, 'pj_1');
    expect(result.skipped).toContainEqual({ issueId: 'in_2', reason: 'not linked' });
    expect(http.calls.some((call) => call.method === 'POST' && call.url.includes('resource=tasks'))).toBe(false);
    expect(s.issueLinks.map((link) => link.issueId)).toEqual(['in_1']);
  });
});
