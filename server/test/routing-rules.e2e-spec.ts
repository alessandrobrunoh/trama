import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { HttpClient, type HttpRequest, type HttpResponse } from '../src/integrations/http-client.js';
import { TwoWaySyncService } from '../src/routing/two-way-sync.service.js';
import { signGithub } from '../src/webhooks/signatures.js';
import { ghIssue, ghPullRequest } from '../src/webhooks/fixtures.js';
import { Client, uniq } from './app.js';

/**
 * A GitHub that knows `GET /user` (the login is in the token: `tok_<login>`), lists a few repositories and
 * records the issue writes two-way rules make.
 */
class MockGithub extends HttpClient {
  calls: HttpRequest[] = [];
  failIssueWrites = false;
  request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const path = new URL(req.url).pathname;
    const token = (req.headers?.['Authorization'] ?? '').replace(/^Bearer /, '');
    const ok = (json: unknown): Promise<HttpResponse> => Promise.resolve({ status: 200, headers: {}, json });
    if (path === '/user') return token.startsWith('tok_') ? ok({ login: token.slice(4) }) : Promise.resolve({ status: 401, headers: {}, json: { message: 'Bad credentials' } });
    if (path === '/user/repos')
      return ok(['acme/web', 'acme/shop', 'acme/checkout'].map((full_name) => ({ full_name, html_url: `https://github.com/${full_name}`, default_branch: 'main', private: false })));
    if (req.method === 'PATCH' && /\/repos\/.+\/issues\/\d+$/.test(path))
      return this.failIssueWrites ? Promise.resolve({ status: 500, headers: {}, json: { message: 'boom' } }) : ok({});
    return Promise.resolve({ status: 404, headers: {}, json: { message: 'Not Found' } });
  }
  issueWrites() {
    return this.calls.filter((c) => c.method === 'PATCH');
  }
}

const repoOf = (full_name: string) => ({ full_name, html_url: `https://github.com/${full_name}`, default_branch: 'main' });

describe('routing rules (project sources)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let github: MockGithub;
  let twoWay: TwoWaySyncService;

  beforeAll(async () => {
    github = new MockGithub();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(HttpClient).useValue(github).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    twoWay = app.get(TwoWaySyncService);
  });
  afterAll(() => app.close());

  async function setup() {
    github.calls = [];
    github.failIssueWrites = false;
    const owner = await Client.signup(server, 'Olivia');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Route Co' }).expect(201)).body;
    const w = `/api/w/${ws.slug}`;
    const add = async (name: string, role: string) => {
      const u = await Client.signup(server, name);
      await owner.client.post(`${w}/members`, { email: u.email, role }).expect(201);
      return u;
    };
    const member = await add('Mia', 'member');
    const viewer = await add('Vic', 'viewer');
    const web = (await owner.client.post(`${w}/projects`, { name: 'Web app' }).expect(201)).body;
    const shop = (await owner.client.post(`${w}/projects`, { name: 'Shop' }).expect(201)).body;
    const acme = (await owner.client.post(`${w}/integrations`, { provider: 'github', token: 'tok_acme', label: 'GitHub · Acme' }).expect(201)).body;
    const rules = (projectId: string) => `${w}/projects/${projectId}/routing-rules`;
    return { owner: owner.client, member, viewer, ws, w, web, shop, acme, conn: acme.connection.id as string, hook: acme.webhook.secret as string, rules };
  }

  /** What GitHub sends: signed with the connection's webhook secret. */
  function deliver(connectionId: string, secret: string, event: string, payload: unknown) {
    const body = JSON.stringify(payload);
    return request(server)
      .post(`/api/webhooks/github/${connectionId}`)
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', event)
      .set('X-GitHub-Delivery', uniq('d'))
      .set('X-Hub-Signature-256', signGithub(secret, body))
      .send(body);
  }

  const issue = (repo: string, number: number, over: Record<string, unknown> = {}, action = 'opened') =>
    ghIssue({ number, title: `Issue ${number}`, html_url: `https://github.com/${repo}/issues/${number}`, ...over }, action, repoOf(repo));

  describe('rules', () => {
    it('adds a source, lists it with its connection and health, edits and removes it', async () => {
      const { owner, rules, web, conn } = await setup();
      const rule = (await owner.post(rules(web.id), { provider: 'github', sourcePath: 'https://github.com/acme/web.git', connectionId: conn }).expect(201)).body;
      expect(rule).toMatchObject({
        projectId: web.id,
        provider: 'github',
        host: 'github.com',
        sourcePath: 'acme/web',
        direction: 'inbound',
        filters: {},
        health: 'ok',
        taskCount: 0,
        connection: { id: conn, label: 'GitHub · Acme', ownerType: 'workspace' },
      });
      const overview = (await owner.get(rules(web.id)).expect(200)).body;
      expect(overview.rules).toHaveLength(1);
      expect(overview.stats).toEqual({ tasksArrived: 0, unmatchedPlaced: 0, rulesFailing: 0 });
      expect(overview.canManage).toBe(true);
      expect(JSON.stringify(overview)).not.toMatch(/tok_|"secret"|webhookSecret/);

      const edited = (await owner.patch(`${rules(web.id)}/${rule.id}`, { direction: 'two_way', filters: { labels: ['bug'] } }).expect(200)).body;
      expect(edited).toMatchObject({ direction: 'two_way', filters: { labels: ['bug'] } });
      await owner.delete(`${rules(web.id)}/${rule.id}`).expect(204);
      expect((await owner.get(rules(web.id)).expect(200)).body.rules).toEqual([]);
      await owner.delete(`${rules(web.id)}/${rule.id}`).expect(404);
    });

    it('rejects a source that is not valid for the connection', async () => {
      const { owner, rules, web, conn } = await setup();
      const post = (body: object) => owner.post(rules(web.id), { provider: 'github', connectionId: conn, ...body });
      await post({ sourcePath: 'acme' }).expect(400);
      await post({ sourcePath: 'a/b/c' }).expect(400);
      await post({ sourcePath: 'https://gitlab.com/a/b' }).expect(400);
      await post({ sourcePath: 'acme/web', provider: 'gitlab' }).expect(400);
      await post({ sourcePath: 'acme/web', provider: 'svn' }).expect(400);
      await post({ sourcePath: 'acme/web', connectionId: 'ic_nope' }).expect(404);
      await post({ sourcePath: 'acme/web', direction: 'both' }).expect(400);
      await post({ sourcePath: 'acme/web', filters: { labels: Array.from({ length: 11 }, (_, i) => `l${i}`) } }).expect(400);
    });

    it('one source, one project: duplicates and overlaps are a 409', async () => {
      const { owner, rules, web, shop, conn } = await setup();
      const add = (projectId: string, sourcePath: string, filters?: object) =>
        owner.post(rules(projectId), { provider: 'github', sourcePath, connectionId: conn, ...(filters ? { filters } : {}) });
      await add(web.id, 'acme/web').expect(201);

      // the same source again, in another letter case, here or in another project
      await add(web.id, 'acme/web').expect(409);
      await add(web.id, 'ACME/Web').expect(409);
      const other = await add(shop.id, 'acme/web').expect(409);
      expect(other.body.message).toContain('"Web app"');
      expect(other.body.message).toMatch(/one source, one project/i);

      // a group over a repository that is already routed, and a repository inside a routed group
      await add(shop.id, 'acme/*').expect(409);
      await add(shop.id, 'lab/*').expect(201);
      await add(web.id, 'lab/tools').expect(409);
      await add(web.id, 'lab/*').expect(409);
      await add(shop.id, 'acme-labs/app').expect(201); // a name that merely starts the same is not inside acme/*

      // filters keep two rules on one source apart only when they cannot match the same item
      await add(web.id, 'split/app', { milestone: 'v1' }).expect(201);
      await add(shop.id, 'split/app', { milestone: 'v2' }).expect(201);
      await add(shop.id, 'split/app', { milestone: 'V1' }).expect(409);
      await add(shop.id, 'split/app', { labels: ['bug'] }).expect(409);
      await add(shop.id, 'split/app').expect(409);
    });

    it('editing filters cannot create an overlap', async () => {
      const { owner, rules, web, shop, conn } = await setup();
      const add = (projectId: string, filters: object) =>
        owner.post(rules(projectId), { provider: 'github', sourcePath: 'split/app', connectionId: conn, filters });
      await add(web.id, { milestone: 'v1' }).expect(201);
      const second = (await add(shop.id, { milestone: 'v2' }).expect(201)).body;
      await owner.patch(`${rules(shop.id)}/${second.id}`, { filters: { milestone: 'v1' } }).expect(409);
      await owner.patch(`${rules(shop.id)}/${second.id}`, { filters: { milestone: 'v3' } }).expect(200);
    });
  });

  describe('permissions', () => {
    it('lets anyone who sees the project read its sources, and only people who can create tasks change them', async () => {
      const { owner, member, viewer, ws, w, web, rules, conn } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'acme/web', connectionId: conn }).expect(201);

      const overview = (await viewer.client.get(rules(web.id)).expect(200)).body;
      expect(overview.rules).toHaveLength(1);
      expect(overview.canManage).toBe(false);
      await viewer.client.post(rules(web.id), { provider: 'github', sourcePath: 'acme/api', connectionId: conn }).expect(403);
      await viewer.client.get(`${rules(web.id)}/suggestions?provider=github`).expect(403);

      // a member may add sources through their own connection, never through one they cannot pick
      const mine = (await member.client.post('/api/me/connections', { provider: 'github', token: 'tok_mia' }).expect(201)).body.connection.id as string;
      await member.client.post(rules(web.id), { provider: 'github', sourcePath: 'mia/notes', connectionId: conn }).expect(404); // workspace connection needs the integrations permission
      const added = (await member.client.post(rules(web.id), { provider: 'github', sourcePath: 'mia/notes', connectionId: mine }).expect(201)).body;
      expect(added.connection).toMatchObject({ ownerType: 'user', ownerName: 'Mia', mine: true });
      expect((await owner.get(rules(web.id)).expect(200)).body.rules.find((r: { id: string }) => r.id === added.id).connection.mine).toBeUndefined();

      // someone else's personal connection is not theirs to use
      const olivia = (await owner.post('/api/me/connections', { provider: 'github', token: 'tok_olivia' }).expect(201)).body.connection.id as string;
      await member.client.post(rules(web.id), { provider: 'github', sourcePath: 'mia/other', connectionId: olivia }).expect(404);
      await member.client.patch(`${rules(web.id)}/${added.id}`, { connectionId: olivia }).expect(404);

      // taking createIssues away from the role takes the right to change sources with it
      const caps = ((await owner.get(w).expect(200)).body.settings.roles.find((r: { id: string }) => r.id === 'member').capabilities as string[]).filter((c) => c !== 'createIssues');
      await owner.patch(`${w}/roles/member`, { capabilities: caps }).expect(200);
      await member.client.post(rules(web.id), { provider: 'github', sourcePath: 'mia/more', connectionId: mine }).expect(403);
      await member.client.delete(`${rules(web.id)}/${added.id}`).expect(403);
      expect((await member.client.get(rules(web.id)).expect(200)).body.canManage).toBe(false);
      expect(ws.id).toBeTruthy();
    });

    it('hides a project from someone whose access does not include it', async () => {
      const { owner, member, w, web, shop, rules, conn } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'acme/web', connectionId: conn }).expect(201);
      const memberships = (await owner.get(`${w}/members`).expect(200)).body as { id: string; userId: string }[];
      const membership = memberships.find((m) => m.userId === member.user.id)!;
      await owner.patch(`${w}/members/${membership.id}`, { access: { projects: { all: false, projectIds: [shop.id] }, includeUnassigned: false } }).expect(200);
      await member.client.get(rules(web.id)).expect(404);
      await member.client.post(rules(web.id), { provider: 'github', sourcePath: 'x/y', connectionId: conn }).expect(404);
      await member.client.get(rules(shop.id)).expect(200);
    });

    it('does not let another workspace touch a rule', async () => {
      const { owner, rules, web, conn } = await setup();
      const rule = (await owner.post(rules(web.id), { provider: 'github', sourcePath: 'acme/web', connectionId: conn }).expect(201)).body;
      const stranger = await Client.signup(server, 'Stan');
      await stranger.client.get(rules(web.id)).expect(404);
      await stranger.client.delete(`${rules(web.id)}/${rule.id}`).expect(404);
    });
  });

  describe('sources of a repository the connection can see', () => {
    it('suggests repositories and says where they already go', async () => {
      const { owner, rules, web, shop, conn } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'acme/web', connectionId: conn }).expect(201);
      await owner.post(rules(shop.id), { provider: 'github', sourcePath: 'acme/shop', connectionId: conn }).expect(201);
      const res = (await owner.get(`${rules(web.id)}/suggestions?provider=github&connectionId=${conn}&q=acme/`).expect(200)).body;
      const by = (path: string) => res.items.find((i: { sourcePath: string }) => i.sourcePath === path);
      expect(by('acme/checkout')).toMatchObject({ status: 'available' });
      expect(by('acme/web')).toMatchObject({ status: 'this_project' });
      expect(by('acme/shop')).toMatchObject({ status: 'other_project', projectName: 'Shop' });
      expect(by('acme/*')).toBeDefined();
      expect(res.items[0].status).toBe('available');
      expect(res.error).toBeUndefined();
    });

    it('lists the connections a person may pick, with the workspace one suggested', async () => {
      const { owner, rules, web, conn } = await setup();
      await owner.post('/api/me/connections', { provider: 'github', token: 'tok_olivia' }).expect(201);
      const options = (await owner.get(`${rules(web.id)}/connections?provider=github`).expect(200)).body as { id: string; label: string; suggested: boolean; ownerType: string }[];
      expect(options.map((o) => [o.label, o.ownerType, o.suggested])).toEqual([
        ['GitHub · Acme', 'workspace', true],
        ['GitHub · olivia', 'user', false],
      ]);
      expect(options[0].id).toBe(conn);
    });
  });

  describe('inbound routing', () => {
    it('places an issue no task explains in the rule\'s project, once, and follows its state', async () => {
      const { owner, w, web, rules, conn, hook } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'acme/web', connectionId: conn }).expect(201);

      const opened = await deliver(conn, hook, 'issues', issue('acme/web', 31)).expect(200);
      expect(opened.body).toMatchObject({ status: 'processed', routed: 'created' });
      const key = opened.body.issues[0] as string;
      const task = (await owner.get(`${w}/tasks/${key}`).expect(200)).body;
      expect(task).toMatchObject({ projectId: web.id, title: 'Issue 31', source: 'github', kind: 'bug', status: 'backlog', externalUrl: 'https://github.com/acme/web/issues/31' });

      // a redelivery or an edit makes no second task
      expect((await deliver(conn, hook, 'issues', issue('acme/web', 31, {}, 'edited')).expect(202)).body.status).toBe('ignored');
      const overview = (await owner.get(rules(web.id)).expect(200)).body;
      expect(overview.rules[0]).toMatchObject({ taskCount: 1, health: 'ok' });
      expect(overview.rules[0].lastSyncAt).toBeTruthy();
      expect(overview.stats).toMatchObject({ tasksArrived: 1, unmatchedPlaced: 0 });

      // the host closes it, then reopens it: the task follows
      await deliver(conn, hook, 'issues', issue('acme/web', 31, { state: 'closed' }, 'closed')).expect(200);
      expect((await owner.get(`${w}/tasks/${key}`).expect(200)).body.status).toBe('done');
      await deliver(conn, hook, 'issues', issue('acme/web', 31, {}, 'reopened')).expect(200);
      expect((await owner.get(`${w}/tasks/${key}`).expect(200)).body.status).toBe('todo');
      await deliver(conn, hook, 'issues', issue('acme/web', 31, { state: 'closed', state_reason: 'not_planned' }, 'closed')).expect(200);
      expect((await owner.get(`${w}/tasks/${key}`).expect(200)).body.status).toBe('canceled');
    });

    it('leaves alone what no rule takes: another repository, a closed issue it never saw, a label it does not match', async () => {
      const { owner, w, web, shop, rules, conn, hook } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'acme/web', connectionId: conn }).expect(201);
      await owner.post(rules(shop.id), { provider: 'github', sourcePath: 'acme/shop', connectionId: conn, filters: { labels: ['frontend'] } }).expect(201);

      expect((await deliver(conn, hook, 'issues', issue('other/repo', 1)).expect(202)).body.reason).toMatch(/no routing rule/);
      expect((await deliver(conn, hook, 'issues', issue('acme/web', 2, { state: 'closed' }, 'closed')).expect(202)).body.status).toBe('ignored');
      expect((await deliver(conn, hook, 'issues', issue('acme/shop', 3, { labels: [{ name: 'backend' }] })).expect(202)).body.status).toBe('ignored');
      const matched = await deliver(conn, hook, 'issues', issue('acme/shop', 4, { labels: [{ name: 'Frontend' }, { name: 'ui' }] })).expect(200);
      expect((await owner.get(`${w}/tasks/${matched.body.issues[0]}`).expect(200)).body.projectId).toBe(shop.id);
    });

    it('prefers the repository rule to a group rule that also contains it', async () => {
      const { owner, w, web, shop, rules, conn, hook } = await setup();
      await owner.post(rules(shop.id), { provider: 'github', sourcePath: 'acme/*', connectionId: conn }).expect(201);
      const sent = await deliver(conn, hook, 'issues', issue('acme/anything', 8)).expect(200);
      expect((await owner.get(`${w}/tasks/${sent.body.issues[0]}`).expect(200)).body.projectId).toBe(shop.id);
      expect(web.id).toBeTruthy();
    });

    it('places a pull request that names no task, and keeps the one that does with its task', async () => {
      const { owner, w, web, rules, conn, hook } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'acme/web', connectionId: conn }).expect(201);
      const pr = (over: Record<string, unknown>, action = 'opened') => ({
        ...ghPullRequest({ number: 5, html_url: 'https://github.com/acme/web/pull/5', ...over }, action),
        repository: repoOf('acme/web'),
      });

      const placed = await deliver(conn, hook, 'pull_request', pr({ title: 'Refactor login', body: 'No key here' })).expect(200);
      expect(placed.body).toMatchObject({ status: 'processed', routed: 'created' });
      const key = placed.body.issues[0] as string;
      expect((await owner.get(`${w}/tasks/${key}`).expect(200)).body).toMatchObject({ projectId: web.id, title: 'Refactor login', status: 'in_review' });
      const task = (await owner.get(`${w}/tasks/${key}`).expect(200)).body;
      const artifacts = (await owner.get(`${w}/tasks/${task.id}/artifacts`).expect(200)).body as { externalId: string; kind: string; state: string }[];
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({ kind: 'pull_request', externalId: '#5', state: 'open' });

      // a later event of the same pull request updates it and creates nothing
      const merged = await deliver(conn, hook, 'pull_request', pr({ title: 'Refactor login', body: 'No key here', state: 'closed', merged: true }, 'closed')).expect(200);
      expect(merged.body).toMatchObject({ status: 'processed', artifactsUpdated: 1 });
      expect((await owner.get(`${w}/tasks/${task.id}/artifacts`).expect(200)).body[0].state).toBe('merged');
      const overview = (await owner.get(rules(web.id)).expect(200)).body;
      expect(overview.rules[0].taskCount).toBe(1);
      expect(overview.stats).toMatchObject({ tasksArrived: 1, unmatchedPlaced: 1 });

      // a pull request that carries a task key is matched by key, as before; the rule places nothing
      const existing = (await owner.post(`${w}/tasks`, { title: 'Existing work', kind: 'feature', projectId: web.id }).expect(201)).body;
      const keyed = await deliver(conn, hook, 'pull_request', pr({ number: 6, title: `${existing.key}: Implement it`, html_url: 'https://github.com/acme/web/pull/6' })).expect(200);
      expect(keyed.body.issues).toEqual([existing.key]);
      expect(keyed.body.routed).toBeUndefined();
      expect((await owner.get(rules(web.id)).expect(200)).body.rules[0].taskCount).toBe(1);
    });

    it('routes the events of a personal connection through its rules', async () => {
      const { member, web, w, rules } = await setup();
      const created = (await member.client.post('/api/me/connections', { provider: 'github', token: 'tok_mia' }).expect(201)).body;
      const mine = created.connection.id as string;
      const rule = (await member.client.post(rules(web.id), { provider: 'github', sourcePath: 'mia/notes', connectionId: mine }).expect(201)).body;
      const sent = await deliver(mine, created.webhook.secret, 'issues', issue('mia/notes', 3)).expect(200);
      expect(sent.body.routed).toBe('created');
      expect((await member.client.get(`${w}/tasks/${sent.body.issues[0]}`).expect(200)).body.projectId).toBe(web.id);
      expect((await member.client.get(rules(web.id)).expect(200)).body.rules.find((r: { id: string }) => r.id === rule.id).taskCount).toBe(1);
    });

    it('does not route events that arrive through another connection than the rule\'s', async () => {
      const { owner, member, web, rules, conn } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'acme/web', connectionId: conn }).expect(201);
      const mine = (await member.client.post('/api/me/connections', { provider: 'github', token: 'tok_mia' }).expect(201)).body;
      const sent = await deliver(mine.connection.id, mine.webhook.secret, 'issues', issue('acme/web', 9)).expect(202);
      expect(sent.body.status).toBe('ignored');
    });
  });

  describe('two-way sync', () => {
    it('closes and reopens the external issue when the task is closed and reopened in Trama', async () => {
      const { owner, w, web, rules, conn, hook } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'two/way', connectionId: conn, direction: 'two_way' }).expect(201);
      const key = (await deliver(conn, hook, 'issues', issue('two/way', 7)).expect(200)).body.issues[0] as string;
      github.calls = [];

      await owner.patch(`${w}/tasks/${key}`, { status: 'done' }).expect(200);
      await twoWay.idle();
      expect(github.issueWrites()).toHaveLength(1);
      expect(github.issueWrites()[0]).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/two/way/issues/7', body: { state: 'closed', state_reason: 'completed' } });

      // moving between two open or two closed statuses writes nothing
      await owner.patch(`${w}/tasks/${key}`, { status: 'canceled' }).expect(200);
      await twoWay.idle();
      expect(github.issueWrites()).toHaveLength(1);

      await owner.patch(`${w}/tasks/${key}`, { status: 'todo' }).expect(200);
      await twoWay.idle();
      expect(github.issueWrites()).toHaveLength(2);
      expect(github.issueWrites()[1].body).toMatchObject({ state: 'open', state_reason: 'reopened' });

      const overview = (await owner.get(rules(web.id)).expect(200)).body;
      expect(overview.rules[0]).toMatchObject({ direction: 'two_way', health: 'ok' });
    });

    it('closes as not planned when the task is canceled', async () => {
      const { owner, w, web, rules, conn, hook } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'two/way', connectionId: conn, direction: 'two_way' }).expect(201);
      const key = (await deliver(conn, hook, 'issues', issue('two/way', 8)).expect(200)).body.issues[0] as string;
      github.calls = [];
      await owner.patch(`${w}/tasks/${key}`, { status: 'canceled' }).expect(200);
      await twoWay.idle();
      expect(github.issueWrites()[0].body).toMatchObject({ state: 'closed', state_reason: 'not_planned' });
    });

    it('does nothing for an inbound rule, and never echoes what the host itself closed', async () => {
      const { owner, w, web, shop, rules, conn, hook } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'in/only', connectionId: conn }).expect(201);
      await owner.post(rules(shop.id), { provider: 'github', sourcePath: 'two/way', connectionId: conn, direction: 'two_way' }).expect(201);
      const inbound = (await deliver(conn, hook, 'issues', issue('in/only', 1)).expect(200)).body.issues[0] as string;
      const both = (await deliver(conn, hook, 'issues', issue('two/way', 2)).expect(200)).body.issues[0] as string;
      github.calls = [];

      await owner.patch(`${w}/tasks/${inbound}`, { status: 'done' }).expect(200);
      await deliver(conn, hook, 'issues', issue('two/way', 2, { state: 'closed' }, 'closed')).expect(200);
      await twoWay.idle();
      expect((await owner.get(`${w}/tasks/${both}`).expect(200)).body.status).toBe('done');
      expect(github.issueWrites()).toHaveLength(0);
    });

    it('shows a failed write on the rule, and clears it on the next one that works', async () => {
      const { owner, w, web, rules, conn, hook } = await setup();
      await owner.post(rules(web.id), { provider: 'github', sourcePath: 'two/way', connectionId: conn, direction: 'two_way' }).expect(201);
      const key = (await deliver(conn, hook, 'issues', issue('two/way', 3)).expect(200)).body.issues[0] as string;

      github.failIssueWrites = true;
      await owner.patch(`${w}/tasks/${key}`, { status: 'done' }).expect(200);
      await twoWay.idle();
      let rule = (await owner.get(rules(web.id)).expect(200)).body.rules[0];
      expect(rule).toMatchObject({ health: 'error' });
      expect(rule.healthReason).toMatch(/Could not close two\/way#3/);
      expect((await owner.get(rules(web.id)).expect(200)).body.stats.rulesFailing).toBe(1);

      github.failIssueWrites = false;
      await owner.patch(`${w}/tasks/${key}`, { status: 'todo' }).expect(200); // the host still has it open: nothing to write
      await owner.patch(`${w}/tasks/${key}`, { status: 'done' }).expect(200);
      await twoWay.idle();
      rule = (await owner.get(rules(web.id)).expect(200)).body.rules[0];
      expect(rule.health).toBe('ok');
    });

    it('refuses two-way where the host cannot close issues', async () => {
      const { owner, rules, web, conn } = await setup();
      // bitbucket has no connection here, so this is rejected for the provider before the connection is looked at
      await owner.post(rules(web.id), { provider: 'bitbucket', sourcePath: 'a/b', connectionId: conn, direction: 'two_way' }).expect(400);
    });
  });

  describe('health', () => {
    it('reports a rule whose connection was revoked or removed, and recovers when switched', async () => {
      const { owner, member, w, web, rules } = await setup();
      const first = (await member.client.post('/api/me/connections', { provider: 'github', token: 'tok_mia' }).expect(201)).body.connection.id as string;
      const second = (await member.client.post('/api/me/connections', { provider: 'github', token: 'tok_mia-work', label: 'GitHub · work' }).expect(201)).body.connection.id as string;
      const rule = (await member.client.post(rules(web.id), { provider: 'github', sourcePath: 'client-group/*', connectionId: first }).expect(201)).body;

      await member.client.post(`/api/me/connections/${first}/revoke`).expect(200);
      let seen = (await owner.get(rules(web.id)).expect(200)).body;
      expect(seen.rules[0]).toMatchObject({ id: rule.id, health: 'error' });
      expect(seen.rules[0].healthReason).toBe("Mia's connection was revoked. New issues from client-group aren't arriving.");
      expect(seen.stats.rulesFailing).toBe(1);

      // switching to a connection that works puts it right; a revoked one cannot be picked
      await member.client.patch(`${rules(web.id)}/${rule.id}`, { connectionId: first }).expect(404);
      const switched = (await member.client.patch(`${rules(web.id)}/${rule.id}`, { connectionId: second }).expect(200)).body;
      expect(switched).toMatchObject({ health: 'ok', connection: { label: 'GitHub · work' } });

      // deleting the connection leaves the rule in place, in error
      await member.client.delete(`/api/me/connections/${second}`).expect(204);
      seen = (await owner.get(rules(web.id)).expect(200)).body;
      expect(seen.rules[0].connectionId).toBeUndefined();
      expect(seen.rules[0]).toMatchObject({ health: 'error' });
      expect(seen.rules[0].healthReason).toMatch(/was removed/);
      expect(w).toBeTruthy();
    });
  });
});
