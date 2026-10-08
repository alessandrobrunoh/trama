import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('projects and repositories', () => {
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

  it('deleting a repository removes it from the projects that listed it', async () => {
    const repo = (await c.post(`${base()}/repositories`, { provider: 'github', fullName: 'acme/web' }).expect(201)).body;
    const p = (await c.post(`${base()}/projects`, { name: 'Has repo', repositoryIds: [repo.id] }).expect(201)).body;
    await c.delete(`${base()}/repositories/${repo.id}`).expect(204);
    expect((await c.get(`${base()}/projects/${p.id}`).expect(200)).body.repositoryIds).toEqual([]);
  });
});
