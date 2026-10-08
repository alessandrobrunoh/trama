import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Client, TokenClient, createTestApp, uniq } from './app.js';

describe('auth', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('GET /api/health checks the database', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('signup sets an httpOnly SameSite=Lax session cookie and never leaks the password hash', async () => {
    const email = `${uniq('u')}@test.dev`;
    const res = await request(app.getHttpServer())
      .post('/api/auth/signup')
      .send({ name: 'Ada', email, password: 'password123' })
      .expect(201);
    expect(res.body.user).toMatchObject({ name: 'Ada', email });
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^nabla_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    await request(app.getHttpServer())
      .post('/api/auth/signup')
      .send({ name: 'Ada', email: email.toUpperCase(), password: 'password123' })
      .expect(409);
  });

  it('login, me and logout round-trip with the cookie session', async () => {
    const { email } = await Client.signup(app.getHttpServer());
    await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'wrong-password' }).expect(401);
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password: 'password123' }).expect(200);
    const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const client = new Client(app.getHttpServer(), cookie);
    const me = await client.get('/api/auth/me').expect(200);
    expect(me.body.user.email).toBe(email);
    const logout = await client.post('/api/auth/logout').expect(204);
    const cleared = (logout.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cleared).toMatch(/nabla_session=/);
    expect(cleared).toMatch(/HttpOnly/i);
    expect(cleared).toMatch(/SameSite=Lax/i);
    expect(cleared).toMatch(/Max-Age=0|Expires=/i);
    await client.get('/api/auth/me').expect(401);
  });

  it('rejects unauthenticated requests and enforces the CSRF header on cookie mutations', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    await request(app.getHttpServer()).get('/api/workspaces').expect(401);
    const { client } = await Client.signup(app.getHttpServer());
    const cookie = client.cookieHeader;
    // same cookie, no X-Client-Id / X-Requested-With → forbidden
    await request(app.getHttpServer()).post('/api/workspaces').set('Cookie', cookie).send({ name: 'Nope' }).expect(403);
    // non-JSON bodies are refused
    await request(app.getHttpServer())
      .post('/api/workspaces')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'test')
      .set('Content-Type', 'text/plain')
      .send('name=Nope')
      .expect(415);
  });

  it('API tokens authenticate as a user and as an agent (secret shown once, only the hash stored)', async () => {
    const { client } = await Client.signup(app.getHttpServer());
    const ws = (await client.post('/api/workspaces', { name: 'Tokens Inc' }).expect(201)).body;
    const slug = ws.slug;

    const created = (await client.post(`/api/w/${slug}/tokens`, { name: 'my laptop', scope: 'admin' }).expect(201)).body;
    expect(created.token.scope).toBe('admin');
    expect(created.secret).toMatch(/^nbl_/);
    expect(created.token.prefix).toBe(`${created.secret.slice(0, 8)}…`);
    expect(created.token.tokenHash).toBeUndefined();
    const listed = (await client.get(`/api/w/${slug}/tokens`).expect(200)).body;
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(created.secret);

    const asUser = new TokenClient(app.getHttpServer(), created.secret);
    expect((await asUser.get(`/api/w/${slug}/snapshot`).expect(200)).body.myRole).toBe('owner');
    await asUser.get('/api/workspaces').expect(200);
    // A bogus bearer must not authenticate as some other live token, or as the browser session.
    await request(app.getHttpServer()).get('/api/workspaces').set('Authorization', 'Bearer nbl_bogus').expect(401);
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Cookie', client.cookieHeader)
      .set('Authorization', 'Bearer nbl_bogus')
      .expect(401);

    // agent token: role member, actor = agent, no user-only endpoints
    const agent = (await client.post(`/api/w/${slug}/agents`, { name: 'Bot', provider: 'claude_code' }).expect(201)).body;
    const agentToken = (await client.post(`/api/w/${slug}/tokens`, { name: 'bot', agentId: agent.id }).expect(201)).body;
    const asAgent = new TokenClient(app.getHttpServer(), agentToken.secret);
    await asAgent.get(`/api/w/${slug}/teams`).expect(200);
    await asAgent.get('/api/auth/me').expect(403);
    await asAgent.post(`/api/w/${slug}/teams`, { name: 'Nope', key: 'NOPE' }).expect(403); // member < admin
    await asAgent.get(`/api/w/${slug}/snapshot`).expect(403);

    // token revoked → 401
    await client.delete(`/api/w/${slug}/tokens/${created.token.id}`).expect(204);
    await asUser.get('/api/workspaces').expect(401);
    await request(app.getHttpServer()).get('/api/workspaces').set('Authorization', 'Bearer nbl_bogus').expect(401);
  });

  it('an expired session or API token is signed out, not still accepted', async () => {
    const { client, user } = await Client.signup(app.getHttpServer());
    const ws = (await client.post('/api/workspaces', { name: 'Expiry Inc' }).expect(201)).body;
    const created = (
      await client
        .post(`/api/w/${ws.slug}/tokens`, {
          name: 'laptop',
          scope: 'read',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        })
        .expect(201)
    ).body;
    const asUser = new TokenClient(app.getHttpServer(), created.secret);
    await asUser.get('/api/workspaces').expect(200);

    const db = app.get(DataSource);
    await db.query(`UPDATE api_tokens SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [created.token.id]);
    await asUser.get('/api/workspaces').expect(401);

    await client.get('/api/auth/me').expect(200);
    await db.query(`UPDATE sessions SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1`, [user.id]);
    await client.get('/api/auth/me').expect(401);
    await client.get('/api/workspaces').expect(401);
  });
});
