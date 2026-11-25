import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { ExternalIdentitiesService } from '../src/external-identities/external-identities.service.js';
import { HttpClient, type HttpRequest, type HttpResponse } from '../src/integrations/http-client.js';
import { ghPullRequest } from '../src/webhooks/fixtures.js';
import { signGithub } from '../src/webhooks/signatures.js';
import { Client } from './app.js';

/** Every provider call answers with the same account; nothing here touches the network. */
class FakeProvider extends HttpClient {
  request(_req: HttpRequest): Promise<HttpResponse> {
    return Promise.resolve({ status: 200, headers: {}, json: { login: 'workspace-bot' } });
  }
}

type Identity = { id: string; provider: string; host: string; login: string; source: string; userId: string };
type Notification = { id: string; kind: string; link: string };

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let last!: T;
  for (let i = 0; i < 40; i++) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

describe('external identities', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let identities: ExternalIdentitiesService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(HttpClient)
      .useValue(new FakeProvider())
      .compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    identities = app.get(ExternalIdentitiesService);
  });
  afterAll(() => app.close());

  const url = '/api/me/external-identities';
  const uniqLogin = (p: string) => `${p}-${Math.random().toString(36).slice(2, 10)}`;

  describe('endpoints', () => {
    it('adds, lists and removes the logins of the current person only', async () => {
      const ada = await Client.signup(server, 'Ada');
      const bob = await Client.signup(server, 'Bob');
      const login = uniqLogin('Ada-GH');

      const added = (await ada.client.post(url, { provider: 'github', login: `@${login}` }).expect(201)).body as Identity;
      expect(added).toMatchObject({ provider: 'github', host: 'github.com', login, source: 'manual', userId: ada.user.id });

      expect((await ada.client.get(url).expect(200)).body.map((i: Identity) => i.id)).toEqual([added.id]);
      expect((await bob.client.get(url).expect(200)).body).toEqual([]);

      // someone else's identity looks like it does not exist
      await bob.client.delete(`${url}/${added.id}`).expect(404);
      expect((await ada.client.get(url).expect(200)).body).toHaveLength(1);

      await ada.client.delete(`${url}/${added.id}`).expect(204);
      await ada.client.delete(`${url}/${added.id}`).expect(404);
      expect((await ada.client.get(url).expect(200)).body).toEqual([]);
    });

    it('answers 409 for a login another person already has, however it is spelled', async () => {
      const ada = await Client.signup(server, 'Ada');
      const bob = await Client.signup(server, 'Bob');
      const login = uniqLogin('Shared');
      await ada.client.post(url, { provider: 'github', login }).expect(201);

      await bob.client.post(url, { provider: 'github', login: login.toUpperCase() }).expect(409);
      await bob.client.post(url, { provider: 'github', host: 'https://GitHub.com/', login: `@${login}` }).expect(409);
      // the owner cannot add it twice either
      await ada.client.post(url, { provider: 'github', login: login.toLowerCase() }).expect(409);
      // the same name on another provider or host is another identity
      await bob.client.post(url, { provider: 'gitlab', login }).expect(201);
      await bob.client.post(url, { provider: 'github', host: 'ghe.acme.dev', login }).expect(201);
    });

    it('validates the input and needs a signed-in person', async () => {
      const ada = await Client.signup(server, 'Ada');
      await ada.client.post(url, { provider: 'svn', login: 'x' }).expect(400);
      await ada.client.post(url, { provider: 'github' }).expect(400);
      await ada.client.post(url, { provider: 'github', login: 'has space' }).expect(400);
      await ada.client.post(url, { provider: 'github', host: 'not a host', login: 'x' }).expect(400);
      await ada.client.post(url, { provider: 'jira', login: 'x' }).expect(400); // Jira needs a site
      await ada.client.post(url, { provider: 'jira', host: 'acme.atlassian.net', login: 'x' }).expect(201);
      await request(server).get(url).expect(401);
    });
  });

  describe('resolver', () => {
    it('resolves every login of one person to that person', async () => {
      const ada = await Client.signup(server, 'Ada');
      const bob = await Client.signup(server, 'Bob');
      const work = uniqLogin('ada-work');
      const home = uniqLogin('ada-home');
      await ada.client.post(url, { provider: 'github', login: work }).expect(201);
      await ada.client.post(url, { provider: 'github', login: home }).expect(201);
      const other = uniqLogin('bob');
      await bob.client.post(url, { provider: 'github', login: other }).expect(201);

      expect(await identities.resolveUserByLogin('github', 'github.com', work)).toBe(ada.user.id);
      expect(await identities.resolveUserByLogin('github', null, home.toUpperCase())).toBe(ada.user.id);
      expect(await identities.resolveUserByLogin('github', null, other)).toBe(bob.user.id);
      expect(await identities.resolveUserByLogin('github', null, uniqLogin('nobody'))).toBeNull();
      expect(await identities.resolveUserByLogin('gitlab', null, work)).toBeNull();
    });

    it('fills a connection login in once, marks it as coming from a connection, and never steals', async () => {
      const ada = await Client.signup(server, 'Ada');
      const bob = await Client.signup(server, 'Bob');
      const login = uniqLogin('conn');
      const made = await identities.ensureFromConnection(ada.user.id, 'github', 'https://github.com', login);
      expect(made).toMatchObject({ source: 'connection', userId: ada.user.id });
      expect((await identities.ensureFromConnection(ada.user.id, 'github', null, login.toUpperCase()))?.id).toBe(made?.id);
      expect(await identities.ensureFromConnection(bob.user.id, 'github', null, login)).toBeNull();
      expect(await identities.resolveUserByLogin('github', null, login)).toBe(ada.user.id);

      const listed = (await ada.client.get(url).expect(200)).body as Identity[];
      expect(listed.filter((i) => i.login === login)).toMatchObject([{ source: 'connection' }]);
    });

    it('only resolves members of the workspace', async () => {
      const owner = await Client.signup(server, 'Olivia');
      const member = await Client.signup(server, 'Mia');
      const outsider = await Client.signup(server, 'Otto');
      const ws = (await owner.client.post('/api/workspaces', { name: 'Resolver Co' }).expect(201)).body;
      await owner.client.post(`/api/w/${ws.slug}/members`, { email: member.email, role: 'member' }).expect(201);
      const a = uniqLogin('mia');
      const b = uniqLogin('otto');
      await member.client.post(url, { provider: 'github', login: a }).expect(201);
      await outsider.client.post(url, { provider: 'github', login: b }).expect(201);

      expect(await identities.resolveMemberByLogin(ws.id, 'github', null, a)).toBe(member.user.id);
      expect(await identities.resolveMemberByLogin(ws.id, 'github', null, b)).toBeNull();
      const many = await identities.resolveMembersByLogins(ws.id, 'github', null, [a, b]);
      expect([...many.entries()]).toEqual([[a.toLowerCase(), member.user.id]]);
    });
  });

  describe('inbound review requests', () => {
    it('tell the person behind the requested login, whichever of their logins it is', async () => {
      const owner = await Client.signup(server, 'Olivia');
      const reviewer = await Client.signup(server, 'Rae');
      const assignee = await Client.signup(server, 'Alex');
      const ws = (await owner.client.post('/api/workspaces', { name: 'Review Co' }).expect(201)).body;
      const base = `/api/w/${ws.slug}`;
      await owner.client.post(`${base}/members`, { email: reviewer.email, role: 'member' }).expect(201);
      await owner.client.post(`${base}/members`, { email: assignee.email, role: 'member' }).expect(201);

      // Rae reviews from two accounts; Olivia's is proven by a connection.
      const raeWork = uniqLogin('rae-work');
      const raeHome = uniqLogin('rae-home');
      await reviewer.client.post(url, { provider: 'github', login: raeWork }).expect(201);
      await reviewer.client.post(url, { provider: 'github', login: raeHome }).expect(201);
      const olivia = uniqLogin('olivia');
      await identities.ensureFromConnection(owner.user.id, 'github', null, olivia);

      const connection = (await owner.client.post(`${base}/integrations`, { provider: 'github', token: 'tok' }).expect(201)).body as {
        connection: { id: string };
        webhook: { secret: string };
      };
      const send = async (payload: object, delivery: string) => {
        const body = JSON.stringify(payload);
        await request(server)
          .post(`/api/webhooks/github/${connection.connection.id}`)
          .set('Content-Type', 'application/json')
          .set('X-GitHub-Event', 'pull_request')
          .set('X-GitHub-Delivery', delivery)
          .set('X-Hub-Signature-256', signGithub(connection.webhook.secret, body))
          .send(body)
          .expect(200);
      };
      const inbox = async (c: Client) => (await c.get(`${base}/notifications`).expect(200)).body.items as Notification[];
      const reviewAsked = (items: Notification[]) => items.filter((n) => n.kind === 'review_requested');

      const first = (await owner.client.post(`${base}/tasks`, { title: 'Rotate tokens', kind: 'feature', assigneeId: assignee.user.id }).expect(201)).body;
      await send(
        {
          ...ghPullRequest({ number: 301, title: `${first.key}: rotate`, body: '', requested_reviewers: [{ login: raeHome }] }, 'review_requested'),
          requested_reviewer: { login: raeHome.toUpperCase() },
          sender: { login: olivia },
        },
        uniqLogin('d1'),
      );
      const got = await eventually(() => inbox(reviewer.client), (items) => reviewAsked(items).length > 0, 'the review request');
      expect(reviewAsked(got)[0]).toMatchObject({ link: `tasks/${first.key}` });
      expect(reviewAsked(await inbox(assignee.client))).toEqual([]); // not the assignee: the asked person
      expect(reviewAsked(await inbox(owner.client))).toEqual([]); // nor the person who caused it

      // the sender has a verified login: the artifact is credited to them, not to "system"
      const artifacts = (await owner.client.get(`${base}/tasks/${first.key}/artifacts`).expect(200)).body as { authorRef?: { type: string; id?: string } }[];
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].authorRef).toEqual({ type: 'user', id: owner.user.id });

      // a login typed by hand is not proof enough to credit someone for what happened in GitHub
      const second = (await owner.client.post(`${base}/tasks`, { title: 'Audit log', kind: 'feature' }).expect(201)).body;
      await send(
        {
          ...ghPullRequest({ number: 302, title: `${second.key}: audit`, body: '', requested_reviewers: [{ login: raeWork }] }, 'review_requested'),
          requested_reviewer: { login: raeWork },
          sender: { login: raeHome },
        },
        uniqLogin('d2'),
      );
      await eventually(() => inbox(reviewer.client), (items) => reviewAsked(items).length > 1, 'the second review request');
      const audit = (await owner.client.get(`${base}/tasks/${second.key}/artifacts`).expect(200)).body as { authorRef?: { type: string } }[];
      expect(audit[0].authorRef).toEqual({ type: 'system' });
    });
  });
});
