import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

describe('workspaces, RBAC and tenancy', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  async function setup() {
    const owner = await Client.signup(app.getHttpServer(), 'Olivia Owner');
    const ws = (await owner.client.post('/api/workspaces', { name: 'RBAC Co' }).expect(201)).body;
    const slug: string = ws.slug;
    const roles = {} as Record<'admin' | 'member' | 'viewer', Client>;
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const u = await Client.signup(app.getHttpServer(), role);
      await owner.client.post(`/api/w/${slug}/members`, { email: u.email, role }).expect(201);
      roles[role] = u.client;
    }
    const team = (await owner.client.post(`/api/w/${slug}/teams`, { name: 'Core', key: 'CORE' }).expect(201)).body;
    return { owner, ws, slug, team, ...roles, ownerUserId: owner.user.id };
  }

  it('creator becomes owner; workspaces list shows my role', async () => {
    const { owner, slug } = await setup();
    const mine = (await owner.client.get('/api/workspaces').expect(200)).body;
    expect(mine.find((w: { slug: string }) => w.slug === slug).role).toBe('owner');
  });

  it('viewer is read-only (403 on writes, 200 on reads)', async () => {
    const { viewer, slug, team } = await setup();
    await viewer.get(`/api/w/${slug}/snapshot`).expect(200);
    await viewer.get(`/api/w/${slug}/workstreams`).expect(200);
    await viewer.post(`/api/w/${slug}/workstreams`, { title: 'Nope', ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(403);
    await viewer.post(`/api/w/${slug}/comments`, { subject: { type: 'team', id: team.id }, body: 'hi' }).expect(403);
  });

  it('member writes domain entities but cannot manage teams, repositories, agents or members', async () => {
    const { member, slug, team } = await setup();
    await member.post(`/api/w/${slug}/workstreams`, { title: 'Ok', ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201);
    await member.post(`/api/w/${slug}/teams`, { name: 'X', key: 'XX' }).expect(403);
    await member.post(`/api/w/${slug}/repositories`, { provider: 'github', fullName: 'a/b' }).expect(403);
    await member.post(`/api/w/${slug}/agents`, { name: 'Bot', provider: 'codex' }).expect(403);
    await member.post(`/api/w/${slug}/members`, { email: 'x@y.dev', role: 'viewer' }).expect(403);
    await member.patch(`/api/w/${slug}`, { name: 'Renamed' }).expect(403);
  });

  it('admin manages teams/repos/agents/members but cannot delete the workspace; only owner can', async () => {
    const { admin, owner, slug } = await setup();
    await admin.post(`/api/w/${slug}/teams`, { name: 'Second', key: 'SEC' }).expect(201);
    await admin.post(`/api/w/${slug}/repositories`, { provider: 'github', fullName: 'acme/api' }).expect(201);
    await admin.post(`/api/w/${slug}/agents`, { name: 'Bot', provider: 'codex' }).expect(201);
    await admin.patch(`/api/w/${slug}`, { name: 'Renamed' }).expect(200);
    await admin.delete(`/api/w/${slug}`).expect(403);
    await owner.client.delete(`/api/w/${slug}`).expect(204);
    await owner.client.get(`/api/w/${slug}`).expect(404);
  });

  it('isolates workspaces: other tenants get 404 on everything, ids do not leak across', async () => {
    const a = await setup();
    const b = await setup();
    const wsA = (await a.owner.client.post(`/api/w/${a.slug}/workstreams`, { title: 'Secret', ownerTeamId: a.team.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    await b.owner.client.get(`/api/w/${a.slug}/snapshot`).expect(404);
    await b.owner.client.get(`/api/w/${a.slug}/workstreams`).expect(404);
    await b.owner.client.post(`/api/w/${a.slug}/workstreams`, { title: 'x', ownerTeamId: a.team.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(404);
    // addressing A's workstream through B's slug must not find it
    await b.owner.client.get(`/api/w/${b.slug}/workstreams/${wsA.id}`).expect(404);
    await b.owner.client.get(`/api/w/${b.slug}/workstreams/${wsA.key}`).expect(404);
    // ... and cannot be referenced from B's entities
    await b.owner.client.post(`/api/w/${b.slug}/workstreams`, { title: 'x', ownerTeamId: a.team.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(400);
    // a token of workspace B does not open workspace A either
    const tk = (await b.owner.client.post(`/api/w/${b.slug}/tokens`, { name: 't' }).expect(201)).body;
    await new TokenClient(app.getHttpServer(), tk.secret).get(`/api/w/${a.slug}/snapshot`).expect(404);
  });

  it('members: role changes, cannot remove or demote the last owner', async () => {
    const { owner, admin, member, slug, ownerUserId } = await setup();
    const members = (await owner.client.get(`/api/w/${slug}/members`).expect(200)).body;
    const ownerMembership = members.find((m: { userId: string }) => m.userId === ownerUserId);
    const memberMembership = members.find((m: { role: string }) => m.role === 'member');
    expect(members[0].user.email).toBeDefined();
    expect(members[0].user.passwordHash).toBeUndefined();

    await owner.client.patch(`/api/w/${slug}/members/${memberMembership.id}`, { role: 'admin' }).expect(200);
    await owner.client.patch(`/api/w/${slug}/members/${ownerMembership.id}`, { role: 'admin' }).expect(409);
    await owner.client.delete(`/api/w/${slug}/members/${ownerMembership.id}`).expect(409);
    // admin cannot grant owner or touch the owner
    await admin.patch(`/api/w/${slug}/members/${memberMembership.id}`, { role: 'owner' }).expect(403);
    await admin.delete(`/api/w/${slug}/members/${ownerMembership.id}`).expect(403);
    // existing users only
    await owner.client.post(`/api/w/${slug}/members`, { email: 'nobody@nowhere.dev', role: 'member' }).expect(404);
    await owner.client.post(`/api/w/${slug}/members`, { email: members[1].user.email, role: 'member' }).expect(409);
    // promote a second owner, then the first can step down
    await owner.client.patch(`/api/w/${slug}/members/${memberMembership.id}`, { role: 'owner' }).expect(200);
    await owner.client.patch(`/api/w/${slug}/members/${ownerMembership.id}`, { role: 'admin' }).expect(200);
    expect(member).toBeDefined();
  });
});
