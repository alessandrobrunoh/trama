import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('projects', () => {
  let app: INestApplication;
  let c: Client;
  let slug: string;
  let team: { id: string };
  let repo: { id: string };
  let userId: string;
  const base = () => `/api/w/${slug}`;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Project Dev');
    c = u.client;
    userId = u.user.id;
    slug = (await c.post('/api/workspaces', { name: 'Project Co' }).expect(201)).body.slug;
    team = (await c.post(`${base()}/teams`, { name: 'Identity', key: 'AUTH', memberIds: [userId] }).expect(201)).body;
    repo = (await c.post(`${base()}/repositories`, { provider: 'github', fullName: 'acme/api' }).expect(201)).body;
  });
  afterAll(() => app.close());

  it('CRUD with teams, repositories and lead; snapshot and events', async () => {
    const p = (
      await c
        .post(`${base()}/projects`, { name: 'Checkout v2', summary: 'Faster checkout', teamIds: [team.id], repositoryIds: [repo.id], leadId: userId, priority: 'high' })
        .expect(201)
    ).body;
    expect(p.id).toMatch(/^pj_/);
    expect(p).toMatchObject({ status: 'backlog', priority: 'high', teamIds: [team.id], repositoryIds: [repo.id], leadId: userId });

    await c.post(`${base()}/projects`, { name: 'Bad repo', repositoryIds: ['rp_missing'] }).expect(400);
    await c.post(`${base()}/projects`, { name: 'Bad team', teamIds: ['tm_missing'] }).expect(400);
    await c.post(`${base()}/projects`, { name: 'Bad lead', leadId: 'us_missing' }).expect(400);
    await c.post(`${base()}/projects`, { name: 'Bad color', color: 'red' }).expect(400);

    const started = (await c.patch(`${base()}/projects/${p.id}`, { status: 'in_progress', targetDate: '2026-12-01T00:00:00.000Z', summary: null }).expect(200)).body;
    expect(started.status).toBe('in_progress');
    expect(started.summary).toBeUndefined();
    expect(started.completedAt).toBeUndefined();

    const done = (await c.patch(`${base()}/projects/${p.id}`, { status: 'completed' }).expect(200)).body;
    expect(done.completedAt).toBeTruthy();
    const reopened = (await c.patch(`${base()}/projects/${p.id}`, { status: 'in_progress' }).expect(200)).body;
    expect(reopened.completedAt).toBeUndefined();

    expect((await c.get(`${base()}/projects?repositoryId=${repo.id}`).expect(200)).body.map((x: { id: string }) => x.id)).toEqual([p.id]);
    expect((await c.get(`${base()}/projects?status=backlog`).expect(200)).body).toEqual([]);
    expect((await c.get(`${base()}/snapshot`).expect(200)).body.projects.map((x: { id: string }) => x.id)).toContain(p.id);

    await c.delete(`${base()}/projects/${p.id}`).expect(204);
    await c.get(`${base()}/projects/${p.id}`).expect(404);
    const types = ((await c.get(`${base()}/events`).expect(200)).body as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['project.created', 'project.updated', 'project.status_changed', 'project.deleted']));
  });
  it('workstreams of a project only use its repositories', async () => {
    const other = (await c.post(`${base()}/repositories`, { provider: 'github', fullName: 'acme/web' }).expect(201)).body;
    const p = (await c.post(`${base()}/projects`, { name: 'Scoped', repositoryIds: [repo.id] }).expect(201)).body;
    const mk = (extra: object) =>
      c.post(`${base()}/workstreams`, { title: 'WS', ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e', ...extra });

    // inherits the project's repositories when it names none
    const inherited = (await mk({ projectId: p.id }).expect(201)).body;
    expect(inherited.projectId).toBe(p.id);
    expect(inherited.repositoryIds).toEqual([repo.id]);

    await mk({ projectId: 'pj_missing' }).expect(400);
    await mk({ projectId: p.id, repositoryIds: [other.id] }).expect(400);

    // a loose workstream can join a project only when its repositories fit
    const loose = (await mk({ repositoryIds: [other.id] }).expect(201)).body;
    expect(loose.projectId).toBeUndefined();
    await c.patch(`${base()}/workstreams/${loose.id}`, { projectId: p.id }).expect(400);
    await c.patch(`${base()}/workstreams/${loose.id}`, { repositoryIds: [repo.id], projectId: p.id }).expect(200);
    await c.patch(`${base()}/workstreams/${loose.id}`, { repositoryIds: [other.id] }).expect(400);
    expect((await c.get(`${base()}/workstreams?projectId=${p.id}`).expect(200)).body).toHaveLength(2);

    // dropping a repository from the project drops it from its workstreams
    await c.patch(`${base()}/projects/${p.id}`, { repositoryIds: [] }).expect(200);
    expect((await c.get(`${base()}/workstreams/${inherited.id}`).expect(200)).body.repositoryIds).toEqual([]);

    // detaching and deleting
    const detached = (await c.patch(`${base()}/workstreams/${loose.id}`, { projectId: null }).expect(200)).body;
    expect(detached.projectId).toBeUndefined();
    await c.delete(`${base()}/projects/${p.id}`).expect(204);
    expect((await c.get(`${base()}/workstreams/${inherited.id}`).expect(200)).body.projectId).toBeUndefined();
  });
  it('projects are searchable, favoritable and commentable', async () => {
    const p = (await c.post(`${base()}/projects`, { name: 'Zebra rollout', summary: 'Quagga migration' }).expect(201)).body;

    const byName = (await c.get(`${base()}/search?q=zebra`).expect(200)).body.results as { type: string; id: string; title: string }[];
    expect(byName.find((r) => r.id === p.id)).toMatchObject({ type: 'project', title: 'Zebra rollout' });
    const bySummary = (await c.get(`${base()}/search?q=quagga&types=project`).expect(200)).body.results as { id: string }[];
    expect(bySummary.map((r) => r.id)).toEqual([p.id]);

    const fav = (await c.post(`${base()}/favorites`, { type: 'project', subjectId: p.id }).expect(201)).body;
    expect(fav).toMatchObject({ type: 'project', subjectId: p.id });
    await c.post(`${base()}/favorites`, { type: 'project', subjectId: 'pj_missing' }).expect(404);

    await c.post(`${base()}/comments`, { subject: { type: 'project', id: p.id }, body: 'Looks good' }).expect(201);
    expect((await c.get(`${base()}/comments?subjectType=project&subjectId=${p.id}`).expect(200)).body).toHaveLength(1);
  });
});
