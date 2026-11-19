import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('project repository', () => {
  let app: INestApplication;
  let c: Client;
  let slug: string;
  const base = () => `/api/w/${slug}`;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Repo Dev');
    c = u.client;
    slug = (await c.post('/api/workspaces', { name: 'Repo Co' }).expect(201)).body.slug;
  });
  afterAll(() => app.close());

  it('stores one optional repository string and clears it with null', async () => {
    const p = (await c.post(`${base()}/projects`, { name: 'Has repo', repository: '  acme/web  ' }).expect(201)).body;
    expect(p.repository).toBe('acme/web');
    expect(p).not.toHaveProperty('repositoryIds');
    expect(p).not.toHaveProperty('teamIds');

    const cleared = (await c.patch(`${base()}/projects/${p.id}`, { repository: null }).expect(200)).body;
    expect(cleared.repository ?? null).toBeNull();
    expect((await c.get(`${base()}/projects/${p.id}`).expect(200)).body.repository ?? null).toBeNull();
  });

  it('rejects an over-long repository', async () => {
    await c.post(`${base()}/projects`, { name: 'Too long', repository: 'x'.repeat(2049) }).expect(400);
  });
});
