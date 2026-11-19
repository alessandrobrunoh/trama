import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('projects', () => {
  let app: INestApplication;
  let c: Client;
  let slug: string;
  let userId: string;
  const base = () => `/api/w/${slug}`;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Project Dev');
    c = u.client;
    userId = u.user.id;
    slug = (await c.post('/api/workspaces', { name: 'Project Co' }).expect(201)).body.slug;  });
  afterAll(() => app.close());

  it('CRUD with repository and lead; snapshot and events', async () => {
    const p = (
      await c
        .post(`${base()}/projects`, { name: 'Checkout v2', summary: 'Faster checkout', repository: 'acme/api', leadId: userId, priority: 'high' })
        .expect(201)
    ).body;
    expect(p.id).toMatch(/^pj_/);
    expect(p).toMatchObject({ status: 'backlog', priority: 'high', repository: 'acme/api', leadId: userId });

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

    expect((await c.get(`${base()}/projects?status=backlog`).expect(200)).body).toEqual([]);
    expect((await c.get(`${base()}/snapshot`).expect(200)).body.projects.map((x: { id: string }) => x.id)).toContain(p.id);

    await c.delete(`${base()}/projects/${p.id}`).expect(204);
    await c.get(`${base()}/projects/${p.id}`).expect(404);
    const types = ((await c.get(`${base()}/events`).expect(200)).body as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['project.created', 'project.updated', 'project.status_changed', 'project.deleted']));
  });
  it('health is a manual field: set on create, PATCH, clear, filter, validated, and emitted as an event', async () => {
    const p = (await c.post(`${base()}/projects`, { name: 'Health demo', health: 'at_risk' }).expect(201)).body;
    expect(p.health).toBe('at_risk');
    const plain = (await c.post(`${base()}/projects`, { name: 'No health yet' }).expect(201)).body;
    expect(plain.health).toBeUndefined();

    await c.post(`${base()}/projects`, { name: 'Bad health', health: 'great' }).expect(400);
    await c.patch(`${base()}/projects/${p.id}`, { health: 'great' }).expect(400);
    await c.patch(`${base()}/projects/${p.id}`, { health: 42 }).expect(400);

    const off = (await c.patch(`${base()}/projects/${p.id}`, { health: 'off_track' }).expect(200)).body;
    expect(off.health).toBe('off_track');
    // Unrelated edits keep it.
    expect((await c.patch(`${base()}/projects/${p.id}`, { summary: 'Still off track' }).expect(200)).body.health).toBe('off_track');

    const filtered = (await c.get(`${base()}/projects?health=off_track`).expect(200)).body as { id: string }[];
    expect(filtered.map((x) => x.id)).toEqual([p.id]);
    expect((await c.get(`${base()}/snapshot`).expect(200)).body.projects.find((x: { id: string }) => x.id === p.id).health).toBe('off_track');

    await c
      .post(`${base()}/views`, { name: 'Off track', entity: 'project', filters: [{ field: 'health', op: 'is', value: 'off_track' }], groupBy: 'health' })
      .expect(201);

    const cleared = (await c.patch(`${base()}/projects/${p.id}`, { health: null }).expect(200)).body;
    expect(cleared.health).toBeUndefined();

    const events = (await c.get(`${base()}/events`).expect(200)).body as { type: string; subject: { id: string }; data: { from?: string | null; to?: string | null } }[];
    const changes = events.filter((e) => e.type === 'project.health_changed' && e.subject.id === p.id);
    const pairs = changes.map((e) => `${e.data.from ?? 'none'}>${e.data.to ?? 'none'}`);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(expect.arrayContaining(['at_risk>off_track', 'off_track>none']));
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
