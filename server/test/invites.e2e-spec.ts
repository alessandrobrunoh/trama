import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Client, createTestApp, uniq } from './app.js';

const tokenOf = (url: string): string => url.split('/invite/')[1];

describe('invitations', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  async function workspace() {
    const { client, user } = await Client.signup(app.getHttpServer(), 'Owner');
    const ws = (await client.post('/api/workspaces', { name: 'Invites Inc' }).expect(201)).body;
    return { owner: client, ownerId: user.id, slug: ws.slug as string };
  }

  it('invites someone who has no account yet, who signs up and joins through the link', async () => {
    const { owner, slug } = await workspace();
    const email = `${uniq('new')}@test.dev`;

    const created = (await owner.post(`/api/w/${slug}/invites`, { email, role: 'member' }).expect(201)).body;
    expect(created.invite).toMatchObject({ email, role: 'member' });
    expect(created.invite.tokenHash).toBeUndefined();
    expect(created.url).toMatch(/\/invite\/[\w-]{40,}$/);
    expect(created.emailed).toBe(false); // no SMTP in tests
    const token = tokenOf(created.url);

    // anyone with the link sees what it is for, without signing in
    const preview = (await request(app.getHttpServer()).get(`/api/invites/${token}`).expect(200)).body;
    expect(preview).toMatchObject({ workspaceName: 'Invites Inc', role: 'member', email, invitedByName: 'Owner' });

    const list = (await owner.get(`/api/w/${slug}/invites`).expect(200)).body;
    expect(list.map((i: { email: string }) => i.email)).toContain(email);

    // the invited person registers with that address and accepts
    const signup = await request(app.getHttpServer())
      .post('/api/auth/signup')
      .set('X-Requested-With', 'test')
      .send({ name: 'Newcomer', email, password: 'password123' })
      .expect(201);
    const cookie = (signup.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const newcomer = new Client(app.getHttpServer(), cookie);
    const joined = (await newcomer.post(`/api/invites/${token}/accept`).expect(200)).body;
    expect(joined).toMatchObject({ workspace: { slug }, role: 'member' });

    const members = (await owner.get(`/api/w/${slug}/members`).expect(200)).body;
    expect(members.map((m: { user: { email: string } }) => m.user.email)).toContain(email);
    expect((await newcomer.get(`/api/w/${slug}`).expect(200)).body.role).toBe('member');

    // the link is single use, and no longer listed
    await request(app.getHttpServer()).get(`/api/invites/${token}`).expect(404);
    await newcomer.post(`/api/invites/${token}/accept`).expect(404);
    const after = (await owner.get(`/api/w/${slug}/invites`).expect(200)).body;
    expect(after.map((i: { email: string }) => i.email)).not.toContain(email);
  });

  it('only the invited address can accept', async () => {
    const { owner, slug } = await workspace();
    const email = `${uniq('target')}@test.dev`;
    const { url } = (await owner.post(`/api/w/${slug}/invites`, { email, role: 'viewer' }).expect(201)).body;
    const token = tokenOf(url);

    const { client: stranger } = await Client.signup(app.getHttpServer(), 'Stranger');
    const res = await stranger.post(`/api/invites/${token}/accept`).expect(403);
    expect(res.body.message).toMatch(/was sent to t\*\*\*@test\.dev/);
    await stranger.get(`/api/w/${slug}`).expect(404); // still not a member

    await request(app.getHttpServer()).post(`/api/invites/${token}/accept`).expect(401); // not signed in
    await request(app.getHttpServer()).get('/api/invites/not-a-real-token').expect(404);
  });

  it('inviting the same address again refreshes the invitation and invalidates the old link', async () => {
    const { owner, slug } = await workspace();
    const email = `${uniq('again')}@test.dev`;
    const first = (await owner.post(`/api/w/${slug}/invites`, { email, role: 'viewer' }).expect(201)).body;
    const second = (await owner.post(`/api/w/${slug}/invites`, { email, role: 'admin' }).expect(201)).body;
    expect(second.invite.id).toBe(first.invite.id);
    expect(second.invite.role).toBe('admin');
    expect(second.url).not.toBe(first.url);
    await request(app.getHttpServer()).get(`/api/invites/${tokenOf(first.url)}`).expect(404);
    await request(app.getHttpServer()).get(`/api/invites/${tokenOf(second.url)}`).expect(200);

    const resent = (await owner.post(`/api/w/${slug}/invites/${first.invite.id}/resend`).expect(200)).body;
    expect(resent.url).not.toBe(second.url);
    await request(app.getHttpServer()).get(`/api/invites/${tokenOf(second.url)}`).expect(404);
  });

  it('revoked and expired invitations stop working, and expired ones can be resent', async () => {
    const { owner, slug } = await workspace();
    const a = (await owner.post(`/api/w/${slug}/invites`, { email: `${uniq('rev')}@test.dev`, role: 'member' }).expect(201)).body;
    await owner.delete(`/api/w/${slug}/invites/${a.invite.id}`).expect(204);
    await request(app.getHttpServer()).get(`/api/invites/${tokenOf(a.url)}`).expect(404);
    await owner.delete(`/api/w/${slug}/invites/${a.invite.id}`).expect(404);

    const b = (await owner.post(`/api/w/${slug}/invites`, { email: `${uniq('exp')}@test.dev`, role: 'member' }).expect(201)).body;
    await app.get(DataSource).query(`UPDATE invites SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [b.invite.id]);
    await request(app.getHttpServer()).get(`/api/invites/${tokenOf(b.url)}`).expect(404);
    const listed = (await owner.get(`/api/w/${slug}/invites`).expect(200)).body;
    expect(listed.map((i: { id: string }) => i.id)).toContain(b.invite.id); // still listed so it can be resent
    const resent = (await owner.post(`/api/w/${slug}/invites/${b.invite.id}/resend`).expect(200)).body;
    await request(app.getHttpServer()).get(`/api/invites/${tokenOf(resent.url)}`).expect(200);
  });

  it('enforces who may invite and which roles they may grant', async () => {
    const { owner, slug } = await workspace();
    // a plain member (default policy: admins invite)
    const memberSignup = await Client.signup(app.getHttpServer(), 'Member');
    await owner.post(`/api/w/${slug}/members`, { email: memberSignup.email, role: 'member' }).expect(201);
    await memberSignup.client.post(`/api/w/${slug}/invites`, { email: `${uniq('x')}@test.dev`, role: 'viewer' }).expect(403);
    await memberSignup.client.get(`/api/w/${slug}/invites`).expect(403);

    // an admin cannot hand out owner
    const adminSignup = await Client.signup(app.getHttpServer(), 'Admin');
    await owner.post(`/api/w/${slug}/members`, { email: adminSignup.email, role: 'admin' }).expect(201);
    await adminSignup.client.post(`/api/w/${slug}/invites`, { email: `${uniq('o')}@test.dev`, role: 'owner' }).expect(403);
    await adminSignup.client.post(`/api/w/${slug}/invites`, { email: `${uniq('a')}@test.dev`, role: 'admin' }).expect(201);

    // bad input and people who are already in
    await owner.post(`/api/w/${slug}/invites`, { email: 'not-an-email', role: 'member' }).expect(400);
    await owner.post(`/api/w/${slug}/invites`, { email: `${uniq('r')}@test.dev`, role: 'god' }).expect(400);
    await owner.post(`/api/w/${slug}/invites`, { email: memberSignup.email, role: 'member' }).expect(409);
  });

  it('an invited person who already belongs to the workspace is not added twice', async () => {
    const { owner, slug } = await workspace();
    const invitee = await Client.signup(app.getHttpServer(), 'Invitee');
    const { url } = (await owner.post(`/api/w/${slug}/invites`, { email: invitee.email, role: 'viewer' }).expect(201)).body;
    // added directly in the meantime, with a higher role
    await owner.post(`/api/w/${slug}/members`, { email: invitee.email, role: 'admin' }).expect(201);
    const res = (await invitee.client.post(`/api/invites/${tokenOf(url)}/accept`).expect(200)).body;
    expect(res.role).toBe('admin');
    const members = (await owner.get(`/api/w/${slug}/members`).expect(200)).body;
    expect(members.filter((m: { user: { email: string } }) => m.user.email === invitee.email)).toHaveLength(1);
  });
});
