import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { HttpClient, type HttpRequest, type HttpResponse } from '../src/integrations/http-client.js';
import { signGithub } from '../src/webhooks/signatures.js';
import { bbCommitStatus, bbPullRequest, bbRepo, ghCheckRun, ghCheckSuite, ghPullRequest, ghRepo, ghStatus, glMergeRequest, glPipeline, glProject } from '../src/webhooks/fixtures.js';
import { Client, uniq } from './app.js';

/** Provider API stub: no test touches the network. */
class MockHttp extends HttpClient {
  calls: HttpRequest[] = [];
  request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const ok = (json: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> => Promise.resolve({ status: 200, headers, json });
    const fail = (status: number, message: string, headers: Record<string, string> = {}): Promise<HttpResponse> =>
      Promise.resolve({ status, headers, json: { message } });
    const raw = req.headers?.Authorization ?? req.headers?.['PRIVATE-TOKEN'] ?? '';
    const auth = raw.startsWith('Basic ') ? Buffer.from(raw.slice(6), 'base64').toString() : raw;
    const { host, pathname } = new URL(req.url);
    if (!auth.includes('good')) return fail(401, 'Bad credentials');
    if (auth.includes('limited')) return fail(403, 'rate limit', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4102444800' });
    if (host === 'api.github.com') {
      if (pathname === '/user') return ok({ login: 'acme-bot' });
      if (pathname === '/user/repos')
        return ok([{ ...ghRepo, private: true }, { full_name: 'acme/web', html_url: 'https://github.com/acme/web', default_branch: 'develop' }], {
          link: '<https://api.github.com/user/repos?page=2>; rel="next"',
        });
      if (pathname === '/repos/acme/auth-service') return ok(ghRepo);
      if (pathname === '/repos/acme/web') return ok({ full_name: 'acme/web', html_url: 'https://github.com/acme/web', default_branch: 'develop' });
    }
    if (host === 'gitlab.example.com' || host === 'gitlab.com') {
      if (pathname === '/api/v4/user') return ok({ username: 'gl-bot' });
      if (pathname === '/api/v4/projects') return ok([glProject], { 'x-next-page': '' });
    }
    if (host === 'api.bitbucket.org') {
      if (pathname === '/2.0/user') return ok({ nickname: 'bb-bot' });
      if (pathname === '/2.0/user/permissions/repositories') return ok({ values: [{ permission: 'admin', repository: bbRepo }], next: 'https://api.bitbucket.org/2.0/next' });
      if (pathname === '/2.0/repositories/acme-bb/payments') return ok(bbRepo);
    }
    return fail(404, 'Not Found');
  }
}

describe('integrations: connections, repository linking and webhooks', () => {
  let app: INestApplication;
  let http: MockHttp;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    http = new MockHttp();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(HttpClient).useValue(http).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  async function setup() {
    const owner = await Client.signup(server, 'Olivia');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Hooks Co' }).expect(201)).body;
    const slug: string = ws.slug;
    const member = await Client.signup(server, 'Mia');
    await owner.client.post(`/api/w/${slug}/members`, { email: member.email, role: 'member' }).expect(201);
    const team = (await owner.client.post(`/api/w/${slug}/teams`, { name: 'Auth', key: 'AUTH' }).expect(201)).body;
    const workstream = (await owner.client.post(`/api/w/${slug}/workstreams`, { title: 'Refresh rotation', ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    return { owner: owner.client, member: member.client, slug, team, key: workstream.key as string, workstream };
  }

  const base = (slug: string) => `/api/w/${slug}/integrations`;
  async function connect(owner: Client, slug: string, provider: 'github' | 'gitlab' | 'bitbucket', extra: object = {}) {
    const res = await owner.post(base(slug), { provider, token: 'good-token', ...extra }).expect(201);
    return res.body as { connection: { id: string }; webhook: { url: string; secret: string } };
  }

  async function artifacts(owner: Client, slug: string, query = '') {
    return (await owner.get(`/api/w/${slug}/artifacts${query}`).expect(200)).body as Array<Record<string, unknown>>;
  }

  // ───────────────────────── connections ─────────────────────────

  describe('connections', () => {
    it('validates the credential, encrypts it, returns the webhook secret once and never any secret', async () => {
      const { owner, slug } = await setup();
      await owner.post(base(slug), { provider: 'github', token: 'bad' }).expect(400);

      const created = await connect(owner, slug, 'github');
      expect(created.connection).toMatchObject({ provider: 'github', account: 'acme-bot', status: 'connected', webhookConfigured: true });
      expect(created.webhook.url).toMatch(new RegExp(`/api/webhooks/github/${created.connection.id}$`));
      expect(created.webhook.secret).toMatch(/^whsec_/);
      // the credential check really went to the GitHub API with the token
      expect(http.calls.some((c) => c.url === 'https://api.github.com/user' && c.headers?.Authorization === 'Bearer good-token')).toBe(true);

      const list = (await owner.get(base(slug)).expect(200)).body;
      expect(list).toHaveLength(1);
      const wire = JSON.stringify(list) + JSON.stringify(created.connection) + JSON.stringify((await owner.get(`${base(slug)}/${created.connection.id}`).expect(200)).body);
      expect(wire).not.toContain('good-token');
      expect(wire).not.toContain(created.webhook.secret);
      expect(wire).not.toMatch(/"(secret|webhookSecret|token|config)"/);

      const snapshot = (await owner.get(`/api/w/${slug}/snapshot`).expect(200)).body;
      expect(JSON.stringify(snapshot.integrations)).not.toContain('good-token');

      // at rest: AES-GCM ciphertext, not the token
      const [row] = await app.get(DataSource).query(`SELECT "secret","webhookSecret" FROM integration_connections WHERE id=$1`, [created.connection.id]);
      expect(row.secret).toMatch(/^v2:/);
      expect(row.secret).not.toContain('good-token');
      expect(row.webhookSecret).not.toContain(created.webhook.secret);

      await owner.post(base(slug), { provider: 'github', token: 'good-token' }).expect(409);
    });

    it('supports self-hosted GitLab, Delta (stub) and secret rotation', async () => {
      const { owner, slug } = await setup();
      const gl = await connect(owner, slug, 'gitlab', { baseUrl: 'https://gitlab.example.com/' });
      expect(gl.connection).toMatchObject({ provider: 'gitlab', account: 'gl-bot', baseUrl: 'https://gitlab.example.com' });
      expect(http.calls.some((c) => c.url === 'https://gitlab.example.com/api/v4/user' && c.headers?.['PRIVATE-TOKEN'] === 'good-token')).toBe(true);

      const delta = (await owner.post(base(slug), { provider: 'delta', token: 'dlt', baseUrl: 'https://delta.dev' }).expect(201)).body;
      expect(delta.connection).toMatchObject({ provider: 'delta', account: 'delta.dev', webhookConfigured: false });
      expect(delta.webhook).toBeUndefined();
      await owner.post(base(slug), { provider: 'delta', token: 'dlt' }).expect(400); // baseUrl required
      await owner.post(`${base(slug)}/${delta.connection.id}/rotate-webhook-secret`).expect(400);
      await owner.post(base(slug), { provider: 'gitlab', token: 'good-token', baseUrl: 'ftp://nope' }).expect(400);

      const rotated = (await owner.post(`${base(slug)}/${gl.connection.id}/rotate-webhook-secret`).expect(200)).body;
      expect(rotated.webhook.secret).toMatch(/^whsec_/);
      expect(rotated.webhook.secret).not.toBe(gl.webhook.secret);
    });

    it('PATCH re-validates a new token; DELETE removes the connection; admins only', async () => {
      const { owner, member, slug } = await setup();
      const { connection } = await connect(owner, slug, 'github');
      await owner.patch(`${base(slug)}/${connection.id}`, { token: 'bad-token' }).expect(400);
      await owner.patch(`${base(slug)}/${connection.id}`, { token: 'good-token-2' }).expect(200);
      await member.get(base(slug)).expect(403);
      await member.post(base(slug), { provider: 'github', token: 'good-token' }).expect(403);
      await member.delete(`${base(slug)}/${connection.id}`).expect(403);
      await owner.delete(`${base(slug)}/${connection.id}`).expect(204);
      await owner.get(`${base(slug)}/${connection.id}`).expect(404);
    });

    it('maps rate limits and provider failures to errors, lists and links repositories', async () => {
      const { owner, slug } = await setup();
      await owner.post(base(slug), { provider: 'github', token: 'good-limited' }).expect(400).expect((r) => expect(r.body.message).toMatch(/Rate limited/));

      const { connection } = await connect(owner, slug, 'github');
      const remote = (await owner.get(`${base(slug)}/${connection.id}/remote-repositories?perPage=2`).expect(200)).body;
      expect(remote).toMatchObject({ page: 1, perPage: 2, hasMore: true });
      expect(remote.items.map((r: { fullName: string }) => r.fullName)).toEqual(['acme/auth-service', 'acme/web']);
      expect(remote.items[0].linked).toBe(false);

      const team = (await owner.post(`/api/w/${slug}/teams`, { name: 'Web', key: 'WEB' }).expect(201)).body;
      const repo = (await owner.post(`${base(slug)}/${connection.id}/link-repository`, { fullName: 'acme/web', teamIds: [team.id] }).expect(201)).body;
      expect(repo).toMatchObject({ provider: 'github', fullName: 'acme/web', url: 'https://github.com/acme/web', defaultBranch: 'develop', teamIds: [team.id] });
      // linking again adopts the existing row
      await owner.post(`${base(slug)}/${connection.id}/link-repository`, { fullName: 'acme/web' }).expect(200);
      await owner.post(`${base(slug)}/${connection.id}/link-repository`, { fullName: 'acme/missing' }).expect(400);
      const again = (await owner.get(`${base(slug)}/${connection.id}/remote-repositories`).expect(200)).body;
      expect(again.items.find((r: { fullName: string }) => r.fullName === 'acme/web')).toMatchObject({ linked: true, repositoryId: repo.id });
      const conn = (await owner.get(`${base(slug)}/${connection.id}`).expect(200)).body;
      expect(conn.repositoryIds).toEqual([repo.id]);
      await owner.delete(`${base(slug)}/${connection.id}/repositories/${repo.id}`).expect(204);
      expect((await owner.get(`${base(slug)}/${connection.id}`).expect(200)).body.repositoryIds).toEqual([]);
    });
  });

  // ───────────────────────── GitHub webhooks ─────────────────────────

  describe('GitHub webhooks', () => {
    async function githubSetup() {
      const s = await setup();
      const c = await connect(s.owner, s.slug, 'github');
      await s.owner.post(`${base(s.slug)}/${c.connection.id}/link-repository`, { fullName: 'acme/auth-service' }).expect(201);
      const send = (event: string, payload: unknown, opts: { secret?: string; delivery?: string; pretty?: boolean; sign?: boolean } = {}) => {
        const body = opts.pretty ? JSON.stringify(payload, null, 4) : JSON.stringify(payload);
        const req = request(server)
          .post(`/api/webhooks/github/${c.connection.id}`)
          .set('Content-Type', 'application/json')
          .set('X-GitHub-Event', event)
          .set('X-GitHub-Delivery', opts.delivery ?? uniq('d'));
        if (opts.sign !== false) req.set('X-Hub-Signature-256', signGithub(opts.secret ?? c.webhook.secret, body));
        return req.send(body);
      };
      const pr = (over: Record<string, unknown> = {}, action = 'opened') =>
        ghPullRequest({ title: `${s.key}: Implement refresh token rotation`, body: '', head: { sha: 'a'.repeat(40), ref: 'feature/x' }, ...over }, action);
      return { ...s, c, send, pr };
    }

    it('rejects missing/invalid signatures and unknown endpoints', async () => {
      const { send, pr, c } = await githubSetup();
      await send('pull_request', pr(), { sign: false }).expect(401);
      await send('pull_request', pr(), { secret: 'wrong' }).expect(401);
      await request(server).post(`/api/webhooks/github/ic_nope`).set('Content-Type', 'application/json').send('{}').expect(404);
      await request(server).post(`/api/webhooks/gitlab/${c.connection.id}`).set('Content-Type', 'application/json').send('{}').expect(404); // wrong provider
    });

    it('PR opened creates an artifact linked to the workstream and records events; a replay is deduplicated', async () => {
      const { owner, slug, key, workstream, send, pr } = await githubSetup();
      const delivery = uniq('delivery');
      const res = await send('pull_request', pr(), { delivery, pretty: true }).expect(200); // raw-body HMAC works for any formatting
      expect(res.body).toMatchObject({ status: 'processed', artifactsCreated: 1, workstreams: [key] });

      const list = await artifacts(owner, slug, `?workstreamId=${workstream.id}`);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        kind: 'pull_request', provider: 'github', externalId: '#182', state: 'open', ci: 'pending', review: 'none', hasConflicts: false,
        url: 'https://github.com/acme/auth-service/pull/182',
      });
      expect(list[0].repositoryId).toBeTruthy();
      expect((await send('pull_request', pr(), { delivery }).expect(200)).body).toEqual({ status: 'duplicate' });
      expect(await artifacts(owner, slug)).toHaveLength(1);

      const events = (await owner.get(`/api/w/${slug}/events?workstreamId=${workstream.id}&type=artifact`).expect(200)).body;
      expect(events.map((e: { type: string }) => e.type)).toContain('artifact.attached');
      expect(events[0].actor).toEqual({ type: 'system' });
      const snapshot = (await owner.get(`/api/w/${slug}/snapshot`).expect(200)).body;
      expect(snapshot.artifacts.some((a: { externalId: string }) => a.externalId === '#182')).toBe(true);
      expect(snapshot.integrations[0].lastWebhookAt).toBeUndefined(); // internal: only on the integrations route
      expect((await owner.get(`${base(slug)}`).expect(200)).body[0].lastWebhookAt).toBeTruthy();
    });

    it('links by branch name (any case), and one PR can link several workstreams', async () => {
      const { owner, slug, team, key, workstream, send, pr } = await githubSetup();
      const second = (await owner.post(`/api/w/${slug}/workstreams`, { title: 'Second', ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
      const payload = pr({ title: 'Rotate tokens', body: `Also touches ${second.key}`, head: { sha: 'a'.repeat(40), ref: `${key.toLowerCase()}/rotation` } });
      const res = await send('pull_request', payload).expect(200);
      expect(res.body.artifactsCreated).toBe(2);
      const forFirst = await artifacts(owner, slug, `?workstreamId=${workstream.id}`);
      expect(forFirst[0].workstreamId).toBe(workstream.id);
      expect(await artifacts(owner, slug, `?workstreamId=${second.id}`)).toHaveLength(1);
    });

    it('CI failure sets artifact.ci = failing, then passing; new commits reset it to pending', async () => {
      const { owner, slug, send, pr } = await githubSetup();
      await send('pull_request', pr()).expect(200);
      const ci = async () => (await artifacts(owner, slug))[0].ci;

      await send('check_suite', ghCheckSuite('failure')).expect(200);
      expect(await ci()).toBe('failing');
      const events = (await owner.get(`/api/w/${slug}/events?type=artifact.updated`).expect(200)).body;
      expect(events[0].data.changes.ci).toEqual(['pending', 'failing']);

      await send('check_run', ghCheckRun('success')).expect(200);
      expect(await ci()).toBe('passing');
      await send('status', ghStatus('failure')).expect(200);
      expect(await ci()).toBe('failing');
      await send('pull_request', pr()).expect(200); // same payload as "opened": CI untouched
      expect(await ci()).toBe('failing');
      await send('pull_request', pr({}, 'synchronize')).expect(200);
      expect(await ci()).toBe('pending');
      // CI for a commit nobody tracks is accepted but ignored
      const unknown = ghCheckSuite('failure', 'completed', 'f'.repeat(40));
      unknown.check_suite.pull_requests = [];
      await send('check_suite', unknown).expect(202);
      expect(await ci()).toBe('pending');
    });

    it('merged / closed / draft / review / conflicts', async () => {
      const { owner, slug, send, pr } = await githubSetup();
      const state = async () => (await artifacts(owner, slug))[0];
      await send('pull_request', pr({ draft: true })).expect(200);
      expect((await state()).state).toBe('draft');
      await send('pull_request', pr({}, 'ready_for_review')).expect(200);
      expect((await state()).state).toBe('open');
      await send('pull_request', pr({ requested_reviewers: [{ login: 'maya' }] }, 'review_requested')).expect(200);
      expect((await state()).review).toBe('requested');
      const reviewEvents = (await owner.get(`/api/w/${slug}/events?type=review.requested`).expect(200)).body;
      expect(reviewEvents).toHaveLength(1);
      await send('pull_request', pr({ mergeable: false, mergeable_state: 'dirty' }, 'edited')).expect(200);
      expect((await state()).hasConflicts).toBe(true);
      await send('pull_request', pr({ state: 'closed', merged: true }, 'closed')).expect(200);
      expect((await state()).state).toBe('merged');

      // a second PR that gets closed without merging
      await send('pull_request', pr({ number: 190, html_url: 'https://github.com/acme/auth-service/pull/190', state: 'closed' }, 'closed')).expect(200);
      expect((await artifacts(owner, slug)).find((a) => a.externalId === '#190')).toMatchObject({ state: 'closed' });
    });

    it('ignores unknown events, unlinked repositories and PRs without a workstream key; answers ping; 400 on malformed payloads', async () => {
      const { owner, slug, send, pr } = await githubSetup();
      await send('ping', { zen: 'hi' }).expect(200).expect((r) => expect(r.body.status).toBe('pong'));
      await send('issues', { action: 'opened' }).expect(202);
      await send('pull_request', pr({}, 'labeled')).expect(202);
      await send('pull_request', { ...pr(), repository: { ...ghRepo, full_name: 'acme/other' } }).expect(202);
      await send('pull_request', pr({ title: 'No key here', body: 'nothing', head: { sha: 'a'.repeat(40), ref: 'feature/x' } })).expect(202);
      expect(await artifacts(owner, slug)).toHaveLength(0);

      await send('pull_request', { action: 'opened' }).expect(400);
      await send('pull_request', { action: 'opened', repository: ghRepo, pull_request: 'nope' }).expect(400);
      await send('check_suite', { repository: ghRepo }).expect(400);
      await send('pull_request', ['not', 'an', 'object']).expect(400);
      const bad = '{"action": ';
      await request(server).post(`/api/webhooks/github/${(await githubSetupConnectionId(owner, slug))}`).set('Content-Type', 'application/json').set('X-GitHub-Event', 'push').send(bad).expect(400);
    });

    async function githubSetupConnectionId(owner: Client, slug: string) {
      return ((await owner.get(base(slug)).expect(200)).body as Array<{ id: string }>)[0].id;
    }

    it('a failed delivery can be retried (delivery id is released) and webhook secret rotation invalidates the old secret', async () => {
      const { owner, slug, c, send, pr } = await githubSetup();
      await send('pull_request', pr()).expect(200);
      const rotated = (await owner.post(`${base(slug)}/${c.connection.id}/rotate-webhook-secret`).expect(200)).body;
      await send('pull_request', pr()).expect(401); // old secret
      await send('pull_request', pr(), { secret: rotated.webhook.secret }).expect(200);
    });
  });

  // ───────────────────────── GitLab webhooks ─────────────────────────

  describe('GitLab webhooks', () => {
    async function gitlabSetup() {
      const s = await setup();
      const c = await connect(s.owner, s.slug, 'gitlab');
      await s.owner.post(`/api/w/${s.slug}/repositories`, { provider: 'gitlab', fullName: 'acme-internal/mobile-app' }).expect(201);
      const send = (payload: unknown, opts: { token?: string | null; uuid?: string } = {}) => {
        const req = request(server)
          .post(`/api/webhooks/gitlab/${c.connection.id}`)
          .set('Content-Type', 'application/json')
          .set('X-Gitlab-Event-UUID', opts.uuid ?? uniq('u'));
        if (opts.token !== null) req.set('X-Gitlab-Token', opts.token ?? c.webhook.secret);
        return req.send(JSON.stringify(payload));
      };
      const mr = (attrs: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
        glMergeRequest({ title: `${s.key}: Session TTL handling`, ...attrs }, extra);
      return { ...s, c, send, mr };
    }

    it('rejects a missing/wrong token', async () => {
      const { send, mr } = await gitlabSetup();
      await send(mr(), { token: null }).expect(401);
      await send(mr(), { token: 'nope' }).expect(401);
    });

    it('MR opened -> artifact linked by key; approved; conflicts; merged; closed', async () => {
      const { owner, slug, key, workstream, send, mr } = await gitlabSetup();
      const res = await send(mr()).expect(200);
      expect(res.body).toMatchObject({ status: 'processed', artifactsCreated: 1, workstreams: [key] });
      const list = await artifacts(owner, slug, `?workstreamId=${workstream.id}`);
      expect(list[0]).toMatchObject({ kind: 'merge_request', provider: 'gitlab', externalId: '!12', state: 'open', ci: 'pending', review: 'none', hasConflicts: false });
      const state = async () => (await artifacts(owner, slug))[0];

      await send(mr({ action: 'approved' })).expect(200);
      expect((await state()).review).toBe('approved');
      await send(mr({ action: 'update', detailed_merge_status: 'conflict', merge_status: 'cannot_be_merged' })).expect(200);
      expect((await state()).hasConflicts).toBe(true);
      await send(mr({ action: 'merge', state: 'merged' })).expect(200);
      expect((await state()).state).toBe('merged');
      await send(mr({ iid: 13, action: 'close', state: 'closed' })).expect(200);
      expect((await artifacts(owner, slug)).find((a) => a.externalId === '!13')).toMatchObject({ state: 'closed' });
    });

    it('pipeline failure/success updates the MR ci; deduplicates by event uuid; ignores other events', async () => {
      const { owner, slug, send, mr } = await gitlabSetup();
      await send(mr()).expect(200);
      const ci = async () => (await artifacts(owner, slug))[0].ci;
      await send(glPipeline('failed', 12)).expect(200);
      expect(await ci()).toBe('failing');
      await send(glPipeline('success')).expect(200); // matched by head sha only
      expect(await ci()).toBe('passing');
      const uuid = uniq('same');
      await send(glPipeline('failed'), { uuid }).expect(200);
      expect(await ci()).toBe('failing');
      await send(glPipeline('success'), { uuid }).expect(200).expect((r) => expect(r.body.status).toBe('duplicate'));
      expect(await ci()).toBe('failing');
      await send({ object_kind: 'push', project: glProject }).expect(202);
      await send({ object_kind: 'merge_request', project: glProject }).expect(400);
      await send({}).expect(400);
    });
  });

  // ───────────────────────── Bitbucket ─────────────────────────

  describe('Bitbucket', () => {
    async function bitbucketSetup() {
      const s = await setup();
      const c = await connect(s.owner, s.slug, 'bitbucket');
      await s.owner.post(`/api/w/${s.slug}/repositories`, { provider: 'bitbucket', fullName: 'acme-bb/payments' }).expect(201);
      const send = (event: string, payload: unknown, opts: { secret?: string | null; uuid?: string } = {}) => {
        const raw = JSON.stringify(payload);
        const req = request(server)
          .post(`/api/webhooks/bitbucket/${c.connection.id}`)
          .set('Content-Type', 'application/json')
          .set('X-Event-Key', event)
          .set('X-Request-UUID', opts.uuid ?? uniq('u'));
        if (opts.secret !== null) req.set('X-Hub-Signature', signGithub(opts.secret ?? c.webhook.secret, raw));
        return req.send(raw);
      };
      const pr = (attrs: Record<string, unknown> = {}) => bbPullRequest({ title: `${s.key}: Retry failed charges`, ...attrs });
      return { ...s, c, send, pr };
    }

    it('connects with an access token or an email:token pair, and refuses a base URL', async () => {
      const { owner, slug } = await setup();
      const created = await owner.post(base(slug), { provider: 'bitbucket', token: 'good-token' }).expect(201);
      expect(created.body.connection).toMatchObject({ provider: 'bitbucket', account: 'bb-bot', status: 'connected', webhookConfigured: true });
      expect(created.body.webhook).toMatchObject({ url: expect.stringMatching(/\/api\/webhooks\/bitbucket\//), events: expect.arrayContaining(['pullrequest:created']) });
      expect(http.calls.some((c) => c.url === 'https://api.bitbucket.org/2.0/user' && c.headers?.Authorization === 'Bearer good-token')).toBe(true);

      await owner.post(base(slug), { provider: 'bitbucket', token: 'someone@acme.dev:good-api-token' }).expect(409); // same account
      expect(http.calls.some((c) => c.headers?.Authorization === `Basic ${Buffer.from('someone@acme.dev:good-api-token').toString('base64')}`)).toBe(true);
      await owner.post(base(slug), { provider: 'bitbucket', token: 'bad' }).expect(400);
      await owner.post(base(slug), { provider: 'bitbucket', token: 'good-token', baseUrl: 'https://bitbucket.example.com' }).expect(400);
    });

    it('lists and links repositories', async () => {
      const { owner, slug } = await setup();
      const c = await connect(owner, slug, 'bitbucket');
      const remote = (await owner.get(`${base(slug)}/${c.connection.id}/remote-repositories`).expect(200)).body;
      expect(remote).toMatchObject({ hasMore: true, items: [{ fullName: 'acme-bb/payments', url: 'https://bitbucket.org/acme-bb/payments', defaultBranch: 'main', private: true, linked: false }] });
      const linked = (await owner.post(`${base(slug)}/${c.connection.id}/link-repository`, { fullName: 'acme-bb/payments' }).expect(201)).body;
      expect(linked).toMatchObject({ provider: 'bitbucket', fullName: 'acme-bb/payments', url: 'https://bitbucket.org/acme-bb/payments' });
    });

    it('rejects a missing/wrong signature', async () => {
      const { send, pr } = await bitbucketSetup();
      await send('pullrequest:created', pr(), { secret: null }).expect(401);
      await send('pullrequest:created', pr(), { secret: 'whsec_nope' }).expect(401);
    });

    it('PR created -> artifact linked by key; approved; merged; build status updates ci; dedupes by request uuid', async () => {
      const { owner, slug, key, workstream, send, pr } = await bitbucketSetup();
      const res = await send('pullrequest:created', pr()).expect(200);
      expect(res.body).toMatchObject({ status: 'processed', artifactsCreated: 1, workstreams: [key] });
      expect((await artifacts(owner, slug, `?workstreamId=${workstream.id}`))[0]).toMatchObject({ kind: 'pull_request', provider: 'bitbucket', externalId: '#21', state: 'open' });
      const state = async () => (await artifacts(owner, slug))[0];

      await send('pullrequest:approved', pr()).expect(200);
      expect((await state()).review).toBe('approved');
      const uuid = uniq('same');
      await send('repo:commit_status_updated', bbCommitStatus('FAILED'), { uuid }).expect(200);
      expect((await state()).ci).toBe('failing');
      await send('repo:commit_status_updated', bbCommitStatus('SUCCESSFUL'), { uuid }).expect(200).expect((r) => expect(r.body.status).toBe('duplicate'));
      expect((await state()).ci).toBe('failing');
      await send('repo:commit_status_updated', bbCommitStatus('SUCCESSFUL')).expect(200);
      expect((await state()).ci).toBe('passing');
      await send('pullrequest:fulfilled', pr({ state: 'MERGED' })).expect(200);
      expect((await state()).state).toBe('merged');

      await send('diagnostics:ping', {}).expect(200).expect((r) => expect(r.body.status).toBe('pong'));
      await send('repo:push', {}).expect(202);
      await send('pullrequest:created', {}).expect(400);
    });
  });
});
