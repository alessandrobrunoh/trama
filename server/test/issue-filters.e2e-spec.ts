import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('issue list filters: priority and open', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  it('filters by one or several priorities and by open status', async () => {
    const owner = await Client.signup(server, 'Olivia');
    const slug = (await owner.client.post('/api/workspaces', { name: 'Filters Co' }).expect(201)).body.slug as string;
    const w = `/api/w/${slug}/issues`;
    const make = (title: string, priority: string, status: string) =>
      owner.client.post(w, { kind: 'bug', title, priority, status }).expect(201);
    await make('urgent open', 'urgent', 'todo');
    await make('high open', 'high', 'in_progress');
    await make('high done', 'high', 'done');
    await make('low open', 'low', 'backlog');
    await make('high canceled', 'high', 'canceled');

    const titles = async (query: string) =>
      ((await owner.client.get(`${w}${query}`).expect(200)).body as { title: string }[]).map((i) => i.title).sort();

    expect(await titles('?priority=high')).toEqual(['high canceled', 'high done', 'high open']);
    expect(await titles('?priority=high,urgent&open=true')).toEqual(['high open', 'urgent open']);
    expect(await titles('?open=true')).toEqual(['high open', 'low open', 'urgent open']);
    expect(await titles('?open=false&priority=low')).toEqual(['low open']);
    expect(await titles('')).toHaveLength(5);
    expect(await titles('?limit=2')).toHaveLength(2);
    await owner.client.get(`${w}?limit=0`).expect(400);
    await owner.client.get(`${w}?priority=bogus`).expect(400);
    await owner.client.get(`${w}?open=maybe`).expect(400);
  });
});
