import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

describe('favorites', () => {
  let app: INestApplication;
  let owner: Client;
  let slug: string;
  let teamId: string;
  const base = () => `/api/w/${slug}`;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Fav Owner');
    owner = u.client;
    slug = (await owner.post('/api/workspaces', { name: 'Favs Co' }).expect(201)).body.slug;
    teamId = (await owner.post(`${base()}/teams`, { name: 'Core', key: 'CORE', memberIds: [u.user.id] }).expect(201)).body.id;
  });
  afterAll(() => app.close());

  const list = async (c: Client = owner) => (await c.get(`${base()}/favorites`).expect(200)).body as { id: string; type: string; subjectId: string }[];

  it('pins and unpins every kind of entity, in the order they were pinned', async () => {
    const issue = (await owner.post(`${base()}/issues`, { title: 'Pinned issue', kind: 'bug' }).expect(201)).body;
    const ws = (await owner.post(`${base()}/workstreams`, { title: 'Pinned ws', ownerTeamId: teamId, deltaThreadUrl: 'https://delta.dev/t/fav' }).expect(201)).body;
    const decision = (await owner.post(`${base()}/decisions`, { title: 'Pinned decision', statement: 'We pin things.' }).expect(201)).body;
    const view = (await owner.post(`${base()}/views`, { name: 'Pinned view', entity: 'issue' }).expect(201)).body;

    const pins = [
      ['issue', issue.id],
      ['workstream', ws.id],
      ['decision', decision.id],
      ['team', teamId],
      ['view', view.id],
    ] as const;
    for (const [type, subjectId] of pins) {
      const fav = (await owner.post(`${base()}/favorites`, { type, subjectId }).expect(201)).body;
      expect(fav).toMatchObject({ type, subjectId });
      expect(fav.userId).toBeUndefined();
    }
    expect((await list()).map((f) => `${f.type}:${f.subjectId}`)).toEqual(pins.map(([t, id]) => `${t}:${id}`));

    // pinning again changes nothing
    const again = (await owner.post(`${base()}/favorites`, { type: 'issue', subjectId: issue.id }).expect(201)).body;
    expect(again.subjectId).toBe(issue.id);
    expect(await list()).toHaveLength(pins.length);

    // unpinning is idempotent
    await owner.delete(`${base()}/favorites/issue/${issue.id}`).expect(204);
    await owner.delete(`${base()}/favorites/issue/${issue.id}`).expect(204);
    expect((await list()).map((f) => f.type)).not.toContain('issue');
  });

  it('are private to their owner', async () => {
    const issue = (await owner.post(`${base()}/issues`, { title: 'Mine only', kind: 'feature' }).expect(201)).body;
    await owner.post(`${base()}/favorites`, { type: 'issue', subjectId: issue.id }).expect(201);

    const other = await Client.signup(app.getHttpServer(), 'Other');
    await owner.post(`${base()}/members`, { email: other.email, role: 'member' }).expect(201);
    expect(await list(other.client)).toEqual([]);
    await other.client.post(`${base()}/favorites`, { type: 'issue', subjectId: issue.id }).expect(201);
    await other.client.delete(`${base()}/favorites/issue/${issue.id}`).expect(204);
    expect((await list()).map((f) => f.subjectId)).toContain(issue.id); // the owner's one is untouched
  });

  it('refuses unknown subjects, foreign private views and bad input', async () => {
    await owner.post(`${base()}/favorites`, { type: 'issue', subjectId: 'iss_nope' }).expect(404);
    await owner.post(`${base()}/favorites`, { type: 'banana', subjectId: 'x' }).expect(400);
    await owner.post(`${base()}/favorites`, { type: 'issue' }).expect(400);
    await owner.delete(`${base()}/favorites/banana/x`).expect(400);

    const privateView = (await owner.post(`${base()}/views`, { name: 'Secret', entity: 'issue', shared: false }).expect(201)).body;
    const sharedView = (await owner.post(`${base()}/views`, { name: 'Open', entity: 'issue', shared: true }).expect(201)).body;
    const other = await Client.signup(app.getHttpServer(), 'Nosy');
    await owner.post(`${base()}/members`, { email: other.email, role: 'member' }).expect(201);
    await other.client.post(`${base()}/favorites`, { type: 'view', subjectId: privateView.id }).expect(404);
    await other.client.post(`${base()}/favorites`, { type: 'view', subjectId: sharedView.id }).expect(201);
  });

  it('forgets favorites whose subject was deleted', async () => {
    const issue = (await owner.post(`${base()}/issues`, { title: 'Short lived', kind: 'idea' }).expect(201)).body;
    await owner.post(`${base()}/favorites`, { type: 'issue', subjectId: issue.id }).expect(201);
    expect((await list()).map((f) => f.subjectId)).toContain(issue.id);
    await owner.delete(`${base()}/issues/${issue.key}`).expect(204);
    expect((await list()).map((f) => f.subjectId)).not.toContain(issue.id);
  });

  it('viewers can keep favorites; agents cannot', async () => {
    const viewer = await Client.signup(app.getHttpServer(), 'Viewer');
    await owner.post(`${base()}/members`, { email: viewer.email, role: 'viewer' }).expect(201);
    await viewer.client.post(`${base()}/favorites`, { type: 'team', subjectId: teamId }).expect(201);
    expect((await list(viewer.client)).map((f) => f.subjectId)).toEqual([teamId]);

    const agent = (await owner.post(`${base()}/agents`, { name: 'Bot', provider: 'claude_code' }).expect(201)).body;
    const token = (await owner.post(`${base()}/tokens`, { name: 'bot', agentId: agent.id }).expect(201)).body;
    const asAgent = new TokenClient(app.getHttpServer(), token.secret);
    await asAgent.get(`${base()}/favorites`).expect(403);
  });
});
