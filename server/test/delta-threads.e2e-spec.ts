import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('Delta threads setting', () => {
  let app: INestApplication;
  let owner: Client;
  let slug: string;
  let teamId: string;
  const base = () => `/api/w/${slug}`;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Thread Owner');
    owner = u.client;
    slug = (await owner.post('/api/workspaces', { name: 'Threads Co' }).expect(201)).body.slug;
    teamId = (await owner.post(`${base()}/teams`, { name: 'Core', key: 'CORE', memberIds: [u.user.id] }).expect(201)).body.id;
  });
  afterAll(() => app.close());

  it('is on by default, yet a workstream never needs a thread (a supplied link is validated)', async () => {
    const ws = (await owner.get(base()).expect(200)).body;
    expect(ws.settings.deltaThreads).toBe(true);

    const bare = await owner.post(`${base()}/workstreams`, { title: 'No thread', ownerTeamId: teamId }).expect(201);
    expect(bare.body.deltaThreadUrl ?? '').toBe('');
    await owner.post(`${base()}/workstreams`, { title: 'Bad thread', ownerTeamId: teamId, deltaThreadUrl: 'https://example.com/x' }).expect(400);
    await owner.post(`${base()}/workstreams`, { title: 'Draft', ownerTeamId: teamId, statusOverride: 'draft' }).expect(201);
    await owner.post(`${base()}/workstreams`, { title: 'With thread', ownerTeamId: teamId, deltaThreadUrl: 'https://delta.dev/t/ok' }).expect(201);
  });

  it('turned off, the thread stays optional (a supplied link is still validated)', async () => {
    await owner.patch(`${base()}/settings`, { deltaThreads: false }).expect(200);
    expect((await owner.get(base()).expect(200)).body.settings.deltaThreads).toBe(false);

    const bare = (await owner.post(`${base()}/workstreams`, { title: 'Bare', ownerTeamId: teamId }).expect(201)).body;
    expect(bare.deltaThreadUrl ?? '').toBe('');
    await owner.post(`${base()}/workstreams`, { title: 'Still validated', ownerTeamId: teamId, deltaThreadUrl: 'https://example.com/x' }).expect(400);
    const linked = (await owner.post(`${base()}/workstreams`, { title: 'Optional link', ownerTeamId: teamId, deltaThreadUrl: 'https://delta.dev/t/opt' }).expect(201)).body;
    expect(linked.deltaThreadUrl).toBe('https://delta.dev/t/opt');

    // creating one while linking an issue follows the same rule
    const issue = (await owner.post(`${base()}/issues`, { title: 'Needs a home', kind: 'bug' }).expect(201)).body;
    await owner.post(`${base()}/issues/${issue.key}/link`, { createWorkstream: { title: 'From issue', ownerTeamId: teamId } }).expect(200);

    // the briefing for agents leaves the section out
    const context = (await owner.get(`${base()}/workstreams/${bare.key}/context`).expect(200)).text as string;
    expect(context).not.toMatch(/Delta thread/);
  });

  it('turned back on, the thread is still optional; only admins can change it', async () => {
    await owner.patch(`${base()}/settings`, { deltaThreads: true }).expect(200);
    await owner.post(`${base()}/workstreams`, { title: 'Optional again', ownerTeamId: teamId }).expect(201);
    await owner.patch(`${base()}/settings`, { deltaThreads: 'yes' }).expect(400);

    const member = await Client.signup(app.getHttpServer(), 'Member');
    await owner.post(`${base()}/members`, { email: member.email, role: 'member' }).expect(201);
    await member.client.patch(`${base()}/settings`, { deltaThreads: false }).expect(403);
  });
});
