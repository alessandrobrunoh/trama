import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { HttpClient, type HttpRequest, type HttpResponse } from '../src/integrations/http-client.js';
import { ConnectionsService } from '../src/integrations/connections.service.js';
import { Client } from './app.js';

/** GitHub answers `GET /user` with the login encoded in the token: `tok_<login>`; `bad` is refused. */
class MockGithub extends HttpClient {
  request(req: HttpRequest): Promise<HttpResponse> {
    const token = (req.headers?.['Authorization'] ?? '').replace(/^Bearer /, '');
    if (!token.startsWith('tok_')) return Promise.resolve({ status: 401, headers: {}, json: { message: 'Bad credentials' } });
    return Promise.resolve({ status: 200, headers: {}, json: { login: token.slice(4) } });
  }
}

describe('connection ownership (personal and workspace connections)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let connections: ConnectionsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(HttpClient).useValue(new MockGithub()).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    connections = app.get(ConnectionsService);
  });
  afterAll(() => app.close());

  async function setup() {
    const owner = await Client.signup(server, 'Olivia');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Own Co' }).expect(201)).body;
    const member = await Client.signup(server, 'Mia');
    await owner.client.post(`/api/w/${ws.slug}/members`, { email: member.email, role: 'member' }).expect(201);
    return { owner, member, ws, w: `/api/w/${ws.slug}`, me: '/api/me/connections' };
  }

  it('lets a person add several personal accounts per provider, with labels', async () => {
    const { member, me } = await setup();
    const first = (await member.client.post(me, { provider: 'github', token: 'tok_mia' }).expect(201)).body;
    expect(first.connection).toMatchObject({
      ownerType: 'user',
      ownerUserId: member.user.id,
      ownerName: 'Mia',
      label: 'GitHub · mia',
      provider: 'github',
      host: 'github.com',
      account: 'mia',
      status: 'connected',
    });
    expect(first.connection).not.toHaveProperty('workspaceId');
    const second = (await member.client.post(me, { provider: 'github', token: 'tok_mia-work', label: 'GitHub · work' }).expect(201)).body;
    expect(second.connection.label).toBe('GitHub · work');
    await member.client.post(me, { provider: 'github', token: 'tok_mia' }).expect(409);

    const list = (await member.client.get(me).expect(200)).body as { label: string }[];
    expect(list.map((c) => c.label)).toEqual(['GitHub · mia', 'GitHub · work']);
  });

  it('never returns a token or secret after creation', async () => {
    const { member, me } = await setup();
    const created = (await member.client.post(me, { provider: 'github', token: 'tok_secretive' }).expect(201)).body;
    const id = created.connection.id as string;
    // the webhook signing secret is shown once, on creation, and nowhere else
    const webhookSecret = created.webhook.secret as string;
    expect(JSON.stringify(created.connection)).not.toContain('tok_secretive');
    for (const body of [(await member.client.get(me).expect(200)).body, (await member.client.get(`${me}/${id}`).expect(200)).body]) {
      const json = JSON.stringify(body);
      expect(json).not.toContain('tok_secretive');
      expect(json).not.toContain(webhookSecret);
      expect(json).not.toMatch(/"(token|secret|webhookSecret)"/);
    }
    const renamed = (await member.client.patch(`${me}/${id}`, { label: 'Renamed' }).expect(200)).body;
    expect(JSON.stringify(renamed)).not.toContain('tok_secretive');
  });

  it('keeps a personal connection invisible and untouchable for everyone else, admins included', async () => {
    const { owner, member, w, me } = await setup();
    const id = (await member.client.post(me, { provider: 'github', token: 'tok_mia' }).expect(201)).body.connection.id as string;

    expect((await owner.client.get(me).expect(200)).body).toEqual([]);
    await owner.client.get(`${me}/${id}`).expect(404);
    await owner.client.patch(`${me}/${id}`, { label: 'mine now' }).expect(404);
    await owner.client.post(`${me}/${id}/revoke`).expect(404);
    await owner.client.delete(`${me}/${id}`).expect(404);
    await owner.client.get(`${me}/${id}/remote-repositories`).expect(404);

    // the workspace's own list and snapshot do not carry it either
    expect((await owner.client.get(`${w}/integrations`).expect(200)).body).toEqual([]);
    await owner.client.get(`${w}/integrations/${id}`).expect(404);
    await owner.client.patch(`${w}/integrations/${id}`, { label: 'x' }).expect(404);
    await owner.client.post(`${w}/integrations/${id}/revoke`).expect(404);
    expect((await owner.client.get(`${w}/snapshot`).expect(200)).body.integrations).toEqual([]);

    // still intact for its owner
    expect((await member.client.get(`${me}/${id}`).expect(200)).body).toMatchObject({ status: 'connected', label: 'GitHub · mia' });
  });

  it('rejects anonymous callers and validates input', async () => {
    const { member, me } = await setup();
    await request(server).get(me).expect(401);
    await member.client.post(me, { provider: 'svn', token: 'tok_x' }).expect(400);
    await member.client.post(me, { provider: 'github' }).expect(400);
    await member.client.post(me, { provider: 'github', token: 'tok_x', label: '' }).expect(400);
    await member.client.post(me, { provider: 'github', token: 'bad' }).expect(400);
  });

  it('renames, revokes (status flips, token wiped), reconnects and deletes', async () => {
    const { member, me } = await setup();
    const id = (await member.client.post(me, { provider: 'github', token: 'tok_mia' }).expect(201)).body.connection.id as string;

    expect((await member.client.patch(`${me}/${id}`, { label: 'GitHub · personal' }).expect(200)).body.label).toBe('GitHub · personal');
    await member.client.patch(`${me}/${id}`, { label: '' }).expect(400);

    const revoked = (await member.client.post(`${me}/${id}/revoke`).expect(200)).body;
    expect(revoked).toMatchObject({ id, status: 'revoked', lastError: 'Revoked', label: 'GitHub · personal' });
    expect((await member.client.get(me).expect(200)).body[0].status).toBe('revoked');
    // a revoked connection reads nothing
    await member.client.get(`${me}/${id}/remote-repositories`).expect(400);
    // a rename still works, and a fresh token brings it back
    await member.client.patch(`${me}/${id}`, { label: 'GitHub · old' }).expect(200);
    expect((await member.client.get(`${me}/${id}`).expect(200)).body.status).toBe('revoked');
    const back = (await member.client.patch(`${me}/${id}`, { token: 'tok_mia' }).expect(200)).body;
    expect(back).toMatchObject({ status: 'connected', account: 'mia' });
    expect(back).not.toHaveProperty('lastError');

    await member.client.delete(`${me}/${id}`).expect(204);
    await member.client.get(`${me}/${id}`).expect(404);
  });

  it('keeps workspace connections under the integrations permission, several per provider, separate from personal ones', async () => {
    const { owner, member, w, me } = await setup();
    await member.client.get(`${w}/integrations`).expect(403);
    await member.client.post(`${w}/integrations`, { provider: 'github', token: 'tok_acme' }).expect(403);

    const acme = (await owner.client.post(`${w}/integrations`, { provider: 'github', token: 'tok_acme', label: 'GitHub · Acme' }).expect(201)).body.connection;
    expect(acme).toMatchObject({ ownerType: 'workspace', label: 'GitHub · Acme', host: 'github.com', status: 'connected' });
    expect(acme.workspaceId).toBeTruthy();
    expect(acme).not.toHaveProperty('ownerUserId');
    await owner.client.post(`${w}/integrations`, { provider: 'github', token: 'tok_acme-labs' }).expect(201);
    await owner.client.post(`${w}/integrations`, { provider: 'github', token: 'tok_acme' }).expect(409);

    // the same GitHub account may be connected by a person and by the workspace
    await owner.client.post(me, { provider: 'github', token: 'tok_acme' }).expect(201);
    expect((await owner.client.get(`${w}/integrations`).expect(200)).body).toHaveLength(2);
    expect((await owner.client.get(me).expect(200)).body).toHaveLength(1);

    // workspace connections revoke too, and then show it in the snapshot
    await member.client.post(`${w}/integrations/${acme.id}/revoke`).expect(403);
    expect((await owner.client.post(`${w}/integrations/${acme.id}/revoke`).expect(200)).body.status).toBe('revoked');
    const snap = (await owner.client.get(`${w}/snapshot`).expect(200)).body.integrations as { id: string; status: string }[];
    expect(snap.find((c) => c.id === acme.id)?.status).toBe('revoked');
    await owner.client.delete(`${w}/integrations/${acme.id}`).expect(204);
  });

  it('usableFor: own personal connections, plus the workspace ones with permission, workspace suggested', async () => {
    const { owner, member, ws, w, me } = await setup();
    await owner.client.post(`${w}/integrations`, { provider: 'github', token: 'tok_acme', label: 'GitHub · Acme' }).expect(201);
    await owner.client.post(me, { provider: 'github', token: 'tok_olivia' }).expect(201);
    await member.client.post(me, { provider: 'github', token: 'tok_mia' }).expect(201);
    const revoked = (await member.client.post(me, { provider: 'github', token: 'tok_mia-old' }).expect(201)).body.connection.id as string;
    await member.client.post(`${me}/${revoked}/revoke`).expect(200);

    const forMember = await connections.usableFor(member.user.id, ws.id);
    expect(forMember.map((c) => c.account)).toEqual(['mia']);
    expect(forMember[0]).toMatchObject({ ownerName: 'Mia', suggested: true });

    const forOwner = await connections.usableFor(owner.user.id, ws.id);
    expect(forOwner.map((c) => [c.label, c.suggested])).toEqual([
      ['GitHub · Acme', true],
      ['GitHub · olivia', false],
    ]);
    expect(JSON.stringify([forMember, forOwner])).not.toMatch(/tok_|"secret"|"webhookSecret"/);

    // someone outside the workspace gets nothing, not even their own connections
    const outsider = await Client.signup(server, 'Otto');
    await outsider.client.post(me, { provider: 'github', token: 'tok_otto' }).expect(201);
    expect(await connections.usableFor(outsider.user.id, ws.id)).toEqual([]);
  });
});
