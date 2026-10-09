import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { HttpClient, type HttpRequest, type HttpResponse } from '../src/integrations/http-client.js';
import { OutgoingWebhooksService } from '../src/outgoing-webhooks/outgoing-webhooks.service.js';
import { verifySignature } from '../src/outgoing-webhooks/signature.js';
import { Client } from './app.js';

/** Records outgoing webhook calls; answers per URL path (`/ok`, `/fail`, `/flaky`, `/slow`, `/down`). */
class MockHttp extends HttpClient {
  calls: HttpRequest[] = [];
  private flaky = 0;
  request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const path = new URL(req.url).pathname;
    if (path === '/down') return Promise.reject(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    if (path === '/slow') return Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }));
    if (path === '/fail') return Promise.resolve({ status: 500, headers: {}, json: null });
    if (path === '/gone') return Promise.resolve({ status: 410, headers: {}, json: null });
    if (path === '/flaky') return Promise.resolve({ status: this.flaky++ === 0 ? 503 : 200, headers: {}, json: null });
    return Promise.resolve({ status: 200, headers: {}, json: null });
  }
  to(path: string) {
    return this.calls.filter((c) => new URL(c.url).pathname === path);
  }
}

describe('outgoing webhooks (custom integrations)', () => {
  let app: INestApplication;
  let http: MockHttp;
  let svc: OutgoingWebhooksService;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    http = new MockHttp();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(HttpClient).useValue(http).compile();
    app = moduleRef.createNestApplication({ logger: ['error', 'warn'] });
    configureApp(app);
    await app.init();
    server = app.getHttpServer();
    svc = app.get(OutgoingWebhooksService);
    svc.retryDelayMs = 10;
  });
  afterAll(() => app.close());

  async function setup() {
    http.calls = [];
    const owner = await Client.signup(server, 'Olivia');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Hook Co' }).expect(201)).body;
    const member = await Client.signup(server, 'Mia');
    await owner.client.post(`/api/w/${ws.slug}/members`, { email: member.email, role: 'member' }).expect(201);
    return { owner: owner.client, member: member.client, w: `/api/w/${ws.slug}/outgoing-webhooks`, base: `/api/w/${ws.slug}` };
  }

  async function create(owner: Client, w: string, path: string, events: string[] = ['issue.*']) {
    const res = (await owner.post(w, { name: `hook ${path}`, url: `https://hooks.example.com${path}`, events }).expect(201)).body;
    return res as { webhook: { id: string }; secret: string };
  }

  it('creates a webhook, shows the secret once and never lists it', async () => {
    const { owner, w } = await setup();
    const { webhook, secret } = await create(owner, w, '/ok');
    expect(secret).toMatch(/^whsec_/);
    expect(webhook).toMatchObject({ enabled: true, events: ['issue.*'], url: 'https://hooks.example.com/ok' });
    expect(JSON.stringify((await owner.get(w).expect(200)).body)).not.toContain(secret);
    expect(JSON.stringify((await owner.get(`${w}/${webhook.id}`).expect(200)).body)).not.toContain('secret');
  });

  it('is admin-only by default and validates the URL and events', async () => {
    const { owner, member, w } = await setup();
    await member.get(w).expect(403);
    await member.post(w, { name: 'x', url: 'https://a.example.com', events: ['*'] }).expect(403);
    await owner.post(w, { name: 'x', url: 'ftp://a.example.com', events: ['*'] }).expect(400);
    await owner.post(w, { name: 'x', url: 'https://u:p@a.example.com', events: ['*'] }).expect(400);
    await owner.post(w, { name: 'x', url: 'http://169.254.169.254/latest/meta-data', events: ['*'] }).expect(400);
    await owner.post(w, { name: 'x', url: 'http://localhost:3000/hook', events: ['*'] }).expect(400);
    await owner.post(w, { name: 'x', url: 'https://a.example.com', events: [] }).expect(400);
    await owner.post(w, { name: 'x', url: 'https://a.example.com', events: ['Issue Created'] }).expect(400);
    await owner.post(w, { name: 'x', url: 'https://a.example.com', events: ['issue.created', 'team.*', '*'] }).expect(201);
  });

  it('delivers matching events with a verifiable HMAC signature; other events are not sent', async () => {
    const { owner, base, w } = await setup();
    const { webhook, secret } = await create(owner, w, '/ok', ['issue.*']);
    const issue = (await owner.post(`${base}/issues`, { kind: 'bug', title: 'Login fails' }).expect(201)).body;
    await owner.post(`${base}/teams`, { name: 'Core', key: 'CORE' }).expect(201); // team.created: not subscribed
    await svc.idle();

    const calls = http.to('/ok');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe('POST');
    expect(call.timeoutMs).toBeLessThanOrEqual(5000);
    const body = JSON.parse(call.rawBody!);
    expect(body).toMatchObject({ event: 'issue.created', subject: { type: 'issue', id: issue.id }, actor: { type: 'user' } });
    expect(body.id).toMatch(/^ev_/);
    expect(call.headers!['X-Nabla-Event']).toBe('issue.created');
    expect(call.headers!['X-Nabla-Delivery']).toBe(body.id);
    expect(verifySignature(secret, call.rawBody!, call.headers!['X-Nabla-Signature'])).toBe(true);
    expect(verifySignature('whsec_wrong', call.rawBody!, call.headers!['X-Nabla-Signature'])).toBe(false);

    const log = (await owner.get(`${w}/${webhook.id}/deliveries`).expect(200)).body;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ event: 'issue.created', status: 200, ok: true, attempt: 1 });
    expect(typeof log[0].durationMs).toBe('number');
    const hook = (await owner.get(`${w}/${webhook.id}`).expect(200)).body;
    expect(hook).toMatchObject({ lastStatus: 200 });
    expect(hook.lastDeliveryAt).toBeTruthy();
  });

  it('wildcard * receives everything; disabled webhooks receive nothing; re-enabling resumes', async () => {
    const { owner, base, w } = await setup();
    const { webhook } = await create(owner, w, '/ok', ['*']);
    await owner.post(`${base}/teams`, { name: 'Core', key: 'CORE' }).expect(201);
    await svc.idle();
    expect(http.to('/ok').map((c) => c.headers!['X-Nabla-Event'])).toEqual(['team.created']);

    await owner.patch(`${w}/${webhook.id}`, { enabled: false }).expect(200);
    await owner.post(`${base}/teams`, { name: 'Two', key: 'TWO' }).expect(201);
    await svc.idle();
    expect(http.to('/ok')).toHaveLength(1);

    await owner.patch(`${w}/${webhook.id}`, { enabled: true, events: ['team.deleted'] }).expect(200);
    await owner.delete(`${base}/teams/TWO`).expect(204);
    await svc.idle();
    expect(http.to('/ok').map((c) => c.headers!['X-Nabla-Event'])).toEqual(['team.created', 'team.deleted']);
  });

  it('retries once on 5xx / network errors / timeouts, never on 4xx, and records every attempt', async () => {
    const { owner, base, w } = await setup();
    const fail = await create(owner, w, '/fail');
    const flaky = await create(owner, w, '/flaky');
    const down = await create(owner, w, '/down');
    const slow = await create(owner, w, '/slow');
    const gone = await create(owner, w, '/gone');
    await owner.post(`${base}/issues`, { kind: 'bug', title: 'Retry me' }).expect(201);
    await svc.idle();

    expect(http.to('/fail')).toHaveLength(2); // exactly one retry, no storm
    expect(http.to('/flaky')).toHaveLength(2);
    expect(http.to('/down')).toHaveLength(2);
    expect(http.to('/slow')).toHaveLength(2);
    expect(http.to('/gone')).toHaveLength(1);

    const logs = async (id: string) => (await owner.get(`${w}/${id}/deliveries`).expect(200)).body as Array<{ status: number; ok: boolean; attempt: number; error?: string }>;
    const failLog = await logs(fail.webhook.id);
    expect(failLog.map((l) => [l.attempt, l.status, l.ok])).toEqual([[2, 500, false], [1, 500, false]]);
    expect(failLog[0].error).toBe('HTTP 500');
    const flakyLog = await logs(flaky.webhook.id);
    expect(flakyLog.map((l) => [l.attempt, l.status, l.ok])).toEqual([[2, 200, true], [1, 503, false]]);
    expect((await logs(down.webhook.id))[0]).toMatchObject({ status: 0, ok: false, error: expect.stringContaining('ECONNREFUSED') });
    expect((await logs(slow.webhook.id))[0].error).toMatch(/Timed out/);
    expect((await owner.get(`${w}/${fail.webhook.id}`)).body.lastStatus).toBe(500);
  });

  it('POST /:id/test sends a signed ping (even when disabled) and returns the delivery', async () => {
    const { owner, w } = await setup();
    const { webhook, secret } = await create(owner, w, '/ok', ['issue.created']);
    await owner.patch(`${w}/${webhook.id}`, { enabled: false }).expect(200);
    const res = (await owner.post(`${w}/${webhook.id}/test`).expect(200)).body;
    expect(res).toMatchObject({ event: 'ping', status: 200, ok: true, attempt: 1 });
    const call = http.to('/ok')[0];
    expect(JSON.parse(call.rawBody!).event).toBe('ping');
    expect(call.headers!['X-Nabla-Event']).toBe('ping');
    expect(verifySignature(secret, call.rawBody!, call.headers!['X-Nabla-Signature'])).toBe(true);

    const bad = await create(owner, w, '/fail');
    const failed = (await owner.post(`${w}/${bad.webhook.id}/test`).expect(200)).body;
    expect(failed).toMatchObject({ status: 500, ok: false, error: 'HTTP 500' });
    expect(http.to('/fail')).toHaveLength(1); // a test never retries
  });

  it('rotating the secret invalidates the old one; PATCH and DELETE work; cross-workspace access is 404', async () => {
    const { owner, base, w } = await setup();
    const { webhook, secret } = await create(owner, w, '/ok');
    const rotated = (await owner.post(`${w}/${webhook.id}/rotate-secret`).expect(200)).body;
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(secret);
    await owner.post(`${base}/issues`, { kind: 'bug', title: 'After rotation' }).expect(201);
    await svc.idle();
    const call = http.to('/ok').at(-1)!;
    expect(verifySignature(rotated.secret, call.rawBody!, call.headers!['X-Nabla-Signature'])).toBe(true);
    expect(verifySignature(secret, call.rawBody!, call.headers!['X-Nabla-Signature'])).toBe(false);

    const patched = (await owner.patch(`${w}/${webhook.id}`, { name: 'Renamed', url: 'https://hooks.example.com/other' }).expect(200)).body;
    expect(patched).toMatchObject({ name: 'Renamed', url: 'https://hooks.example.com/other' });
    await owner.patch(`${w}/${webhook.id}`, { url: 'javascript:alert(1)' }).expect(400);

    const other = await setup();
    await other.owner.get(`${other.w}/${webhook.id}`).expect(404);
    await other.owner.post(`${other.w}/${webhook.id}/test`).expect(404);

    await owner.delete(`${w}/${webhook.id}`).expect(204);
    await owner.get(`${w}/${webhook.id}`).expect(404);
    await owner.get(w).expect(200);
  });

  it('keeps only the latest deliveries per webhook', async () => {
    const { owner, w } = await setup();
    const { webhook } = await create(owner, w, '/ok');
    for (let i = 0; i < 25; i++) await owner.post(`${w}/${webhook.id}/test`).expect(200);
    expect((await owner.get(`${w}/${webhook.id}/deliveries`).expect(200)).body).toHaveLength(20);
    expect((await owner.get(`${w}/${webhook.id}/deliveries?limit=5`).expect(200)).body).toHaveLength(5);
  });
});
