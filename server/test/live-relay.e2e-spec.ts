import type { INestApplication } from '@nestjs/common';
import { filter, firstValueFrom, timeout } from 'rxjs';
import { Client, createTestApp } from './app.js';
import { EventsService } from '../src/events/events.service.js';

describe('live events between API instances', () => {
  let a: INestApplication;
  let b: INestApplication;
  beforeAll(async () => {
    a = await createTestApp();
    b = await createTestApp();
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  it('reach the streams of another instance through Postgres', async () => {
    const { client } = await Client.signup(a.getHttpServer(), 'Relay Dev');
    const slug = (await client.post('/api/workspaces', { name: 'Relay Co' }).expect(201)).body.slug;
    const workspaceId = (await client.get(`/api/w/${slug}`).expect(200)).body.id as string;

    // Instance B has its own bus; it only hears about instance A's work through the database.
    const heard = firstValueFrom(
      b
        .get(EventsService)
        .stream$.pipe(
          filter((e) => e.workspaceId === workspaceId && e.event.entity === 'issue' && e.event.type === 'created'),
          timeout(8_000),
        ),
    );
    // The listener connects shortly after boot: keep creating issues until one is relayed.
    let n = 0;
    const keepWorking = setInterval(() => {
      // supertest requests are lazy: nothing is sent until `then` is called
      void client.post(`/api/w/${slug}/issues`, { title: `Relay ${n++}`, kind: 'bug' }).then(() => undefined, () => undefined);
    }, 150);
    try {
      const got = await heard;
      expect(got.event).toMatchObject({ type: 'created', entity: 'issue' });
      expect(got.event.id).toMatch(/^in_/);
    } finally {
      clearInterval(keepWorking);
    }
  });

  it('still reach this instance’s own streams exactly once', async () => {
    const { client } = await Client.signup(a.getHttpServer(), 'Echo Dev');
    const slug = (await client.post('/api/workspaces', { name: 'Echo Co' }).expect(201)).body.slug;
    const workspaceId = (await client.get(`/api/w/${slug}`).expect(200)).body.id as string;
    const seen: string[] = [];
    const sub = a
      .get(EventsService)
      .stream$.pipe(filter((e) => e.workspaceId === workspaceId && e.event.entity === 'issue'))
      .subscribe((e) => seen.push(`${e.event.type}:${e.event.id}`));
    await new Promise((r) => setTimeout(r, 500)); // let the listener come up
    const issue = (await client.post(`/api/w/${slug}/issues`, { title: 'Once', kind: 'bug' }).expect(201)).body;
    await new Promise((r) => setTimeout(r, 400));
    sub.unsubscribe();
    expect(seen.filter((s) => s === `created:${issue.id}`)).toHaveLength(1);
  });
});
