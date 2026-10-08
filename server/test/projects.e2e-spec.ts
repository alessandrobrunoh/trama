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
});
