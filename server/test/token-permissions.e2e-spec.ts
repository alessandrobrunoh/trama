import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

describe('custom API tokens: permissions and limits', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  async function setup() {
    const owner = await Client.signup(server, 'Olivia Owner');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Tokens Co' }).expect(201)).body;
    const w = `/api/w/${ws.slug}`;
    const mint = async (body: object) => {
      const res = (await owner.client.post(`${w}/tokens`, { name: 'k', ...body }).expect(201)).body;
      return { client: new TokenClient(server, res.secret), token: res.token, secret: res.secret as string };
    };
    return { owner: owner.client, w, slug: ws.slug as string, mint };
  }

  it('only allows the listed resource × action pairs', async () => {
    const { w, mint } = await setup();
    const { client, token } = await mint({ permissions: ['issues:write', 'teams:read'] });
    expect(token.scope).toBe('custom');
    // write implies read
    expect(token.permissions).toEqual(['issues:read', 'issues:write', 'teams:read']);

    await client.get(`${w}/issues`).expect(200);
    await client.post(`${w}/issues`, { kind: 'bug', title: 'from custom token' }).expect(201);
    await client.get(`${w}/teams`).expect(200);

    const noDelete = await client.delete(`${w}/issues/BUG-1`).expect(403);
    expect(noDelete.body.message).toMatch(/issues:delete/);
    const noTeamWrite = await client.post(`${w}/teams`, { name: 'T', key: 'TT' }).expect(403);
    expect(noTeamWrite.body.message).toMatch(/teams:write/);
    await client.get(`${w}/workstreams`).expect(403);
    await client.get(`${w}/snapshot`).expect(403);
    await client.get(`${w}/tokens`).expect(403);
    await client.post(`${w}/ai/chat`, { messages: [{ role: 'user', content: 'hi' }] }).expect(403);
  });

  it('is still bounded by the acting user\'s role', async () => {
    const { owner, w, slug } = await setup();
    const person = await Client.signup(server, 'Vic Viewer');
    const membership = (await owner.post(`${w}/members`, { email: person.email, role: 'member' }).expect(201)).body;
    const res = (await person.client.post(`/api/w/${slug}/tokens`, { name: 'v', permissions: ['issues:write'] }).expect(201)).body;
    const client = new TokenClient(server, res.secret);
    await client.post(`${w}/issues`, { kind: 'bug', title: 'ok as member' }).expect(201);
    // demoted: the permission is still granted, but a viewer cannot write
    await owner.patch(`${w}/members/${membership.id}`, { role: 'viewer' }).expect(200);
    await client.post(`${w}/issues`, { kind: 'bug', title: 'nope' }).expect(403);
  });

  it('introspection: GET /auth/token works for custom tokens and lists permissions and limits', async () => {
    const { client } = await (async () => {
      const s = await setup();
      return s.mint({ permissions: ['search:read'], limits: { writesPerDay: 5 } });
    })();
    const me = (await client.get('/api/auth/token').expect(200)).body;
    expect(me.permissions).toEqual(['search:read']);
    expect(me.token.limits).toMatchObject({ writesPerDay: 5, writesPerMinute: 60, requestsPerMinute: 600 });
    expect(me.workspace.slug).toBeTruthy();
    // other non-workspace routes stay closed to custom tokens
    await client.get('/api/workspaces').expect(403);
    await client.get('/api/auth/me').expect(403);
  });

  it('rejects empty, unknown-only and mixed definitions', async () => {
    const { owner, w } = await setup();
    await owner.post(`${w}/tokens`, { name: 'a', scope: 'custom', permissions: [] }).expect(400);
    await owner.post(`${w}/tokens`, { name: 'a', permissions: ['bogus:read'] }).expect(400);
    await owner.post(`${w}/tokens`, { name: 'a', scope: 'read', permissions: ['issues:read'] }).expect(400);
    await owner.post(`${w}/tokens`, { name: 'a', permissions: ['issues:read'], limits: { writesPerDay: 10_000_000 } }).expect(400);
  });

  it('a custom token cannot escalate by minting tokens', async () => {
    const { mint, w } = await setup();
    const { client } = await mint({ permissions: ['tokens:write', 'issues:read'] });
    await client.post(`${w}/tokens`, { name: 'e1', scope: 'admin' }).expect(403);
    await client.post(`${w}/tokens`, { name: 'e2', permissions: ['issues:write'] }).expect(403);
    await client.post(`${w}/tokens`, { name: 'ok', permissions: ['issues:read'] }).expect(201);
  });

  it('decision verdicts need decisions:accept', async () => {
    const { owner, w, mint } = await setup();
    const decision = (await owner.post(`${w}/decisions`, { title: 'Use Rust', statement: 'Build the MCP server in Rust', status: 'proposed' }).expect(201)).body;
    const writer = await mint({ permissions: ['decisions:write'] });
    await writer.client.post(`${w}/decisions/${decision.id}/accept`).expect(403);
    const judge = await mint({ permissions: ['decisions:accept'] });
    await judge.client.post(`${w}/decisions/${decision.id}/accept`).expect(200);
  });

  it('enforces write and request caps with 429', async () => {
    const { w, mint } = await setup();
    const perMinute = await mint({ permissions: ['issues:write'], limits: { writesPerMinute: 2 } });
    await perMinute.client.post(`${w}/issues`, { kind: 'bug', title: 'one' }).expect(201);
    await perMinute.client.post(`${w}/issues`, { kind: 'bug', title: 'two' }).expect(201);
    const blocked = await perMinute.client.post(`${w}/issues`, { kind: 'bug', title: 'three' }).expect(429);
    expect(blocked.body.message).toMatch(/2 writes per minute/);
    await perMinute.client.get(`${w}/issues`).expect(200); // reads are not writes

    const perDay = await mint({ permissions: ['issues:write'], limits: { writesPerDay: 1 } });
    await perDay.client.post(`${w}/issues`, { kind: 'bug', title: 'a' }).expect(201);
    const day = await perDay.client.post(`${w}/issues`, { kind: 'bug', title: 'b' }).expect(429);
    expect(day.body.message).toMatch(/per day/);

    const reads = await mint({ permissions: ['issues:read'], limits: { requestsPerMinute: 2 } });
    await reads.client.get(`${w}/issues`).expect(200);
    await reads.client.get(`${w}/issues`).expect(200);
    await reads.client.get(`${w}/issues`).expect(429);
  });

  it('legacy scoped tokens still work and carry default limits', async () => {
    const { w, mint } = await setup();
    const { client, token } = await mint({ scope: 'write' });
    expect(token.limits).toEqual({ requestsPerMinute: 600, writesPerMinute: 60, writesPerDay: 2000 });
    expect(token.permissions).toBeUndefined();
    await client.post(`${w}/issues`, { kind: 'bug', title: 'legacy' }).expect(201);
  });

  it('nested artifact routes need artifacts:*, not the parent resource permission', async () => {
    const { owner, w, mint } = await setup();
    const issue = (await owner.post(`${w}/issues`, { kind: 'bug', title: 'Has artifacts' }).expect(201)).body;
    const body = { kind: 'document', title: 'Notes' };
    const issuesOnly = await mint({ permissions: ['issues:write'] });
    await issuesOnly.client.post(`${w}/issues/${issue.key}/artifacts`, body).expect(403);
    await issuesOnly.client.get(`${w}/issues/${issue.key}/artifacts`).expect(403);
    const artifactsOnly = await mint({ permissions: ['artifacts:write'] });
    await artifactsOnly.client.post(`${w}/issues/${issue.key}/artifacts`, body).expect(201);
    await artifactsOnly.client.get(`${w}/issues/${issue.key}/artifacts`).expect(200);
  });

  it('account-level routes are closed to workspace-bound API tokens', async () => {
    const { w, slug, mint } = await setup();
    const { client } = await mint({ scope: 'write' });
    await client.post('/api/workspaces', { name: 'Escape Hatch' }).expect(403);
    await client.post('/api/invites/nope/accept').expect(403);
    await client.get('/api/me/notification-settings').expect(403);
    await client.get('/api/me/push').expect(403);
    // listing only reveals the workspace the token belongs to
    const listed = (await client.get('/api/workspaces').expect(200)).body as { slug: string }[];
    expect(listed.map((x) => x.slug)).toEqual([slug]);
    const me = (await client.get('/api/auth/me').expect(200)).body as { workspaces: { slug: string }[] };
    expect(me.workspaces.map((x) => x.slug)).toEqual([slug]);
    await client.get(`${w}/issues`).expect(200);
  });
});
