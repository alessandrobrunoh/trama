import type { INestApplication } from '@nestjs/common';
import webpush from 'web-push';
import { Client, createTestApp } from './app.js';

const SUB = (endpoint: string) => ({ endpoint, keys: { p256dh: 'BPlaceholderKeyForTests', auth: 'authsecret' } });

describe('push notifications', () => {
  let app: INestApplication;
  let owner: Client;
  let dev: Client;
  let devId: string;
  let slug: string;
  const base = () => `/api/w/${slug}`;
  const sent = vi.spyOn(webpush, 'sendNotification');

  beforeAll(async () => {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:test@example.com';
    app = await createTestApp();
    const o = await Client.signup(app.getHttpServer(), 'Pia Owner');
    owner = o.client;
    slug = (await owner.post('/api/workspaces', { name: 'Push Co' }).expect(201)).body.slug;
    const d = await Client.signup(app.getHttpServer(), 'Dev Dario');
    dev = d.client;
    devId = d.user.id;
    await owner.post(`${base()}/members`, { email: d.email, role: 'member' }).expect(201);
  });
  afterAll(async () => {
    await app.close();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    delete process.env.VAPID_SUBJECT;
  });
  beforeEach(() => {
    sent.mockReset();
  });

  it('exposes the public key, registers a device idempotently and forgets it', async () => {
    const status = (await dev.get('/api/me/push').expect(200)).body;
    expect(status.enabled).toBe(true);
    expect(status.publicKey).toBe(process.env.VAPID_PUBLIC_KEY);

    await dev.put('/api/me/push/subscription').send(SUB('http://insecure.example/x')).expect(400);
    await dev.put('/api/me/push/subscription').send({ endpoint: 'https://push.example/a', keys: { p256dh: 'x' } }).expect(400);
    await dev.put('/api/me/push/subscription').send(SUB('https://push.example/a')).expect(200);
    await dev.put('/api/me/push/subscription').send(SUB('https://push.example/a')).expect(200);
    await dev.delete('/api/me/push/subscription').send({ endpoint: 'https://push.example/a' }).expect(204);
    await dev.delete('/api/me/push/subscription').send({ endpoint: 'https://push.example/a' }).expect(204);
  });

  it('sends a system notification to the assignee’s devices when push is on', async () => {
    sent.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await dev.put('/api/me/push/subscription').send(SUB('https://push.example/dev-phone')).expect(200);
    const issue = (await owner.post(`${base()}/issues`, { title: 'Pager duty', kind: 'bug', assigneeId: devId }).expect(201)).body;
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1), { timeout: 3000 });

    const [subscription, payload] = sent.mock.calls[0]!;
    expect(subscription.endpoint).toBe('https://push.example/dev-phone');
    const { notification } = JSON.parse(String(payload));
    expect(notification.title).toBe(`Pia Owner assigned you ${issue.key}: Pager duty`);
    expect(notification.data.onActionClick.default).toEqual({ operation: 'navigateLastFocusedOrOpen', url: `/${slug}/issues/${issue.key}` });
  });

  it('respects the per-kind push switch and drops dead subscriptions', async () => {
    await dev.patch('/api/me/notification-settings').send({ settings: { assigned: { push: false } } }).expect(200);
    await owner.post(`${base()}/issues`, { title: 'Quiet one', kind: 'bug', assigneeId: devId }).expect(201);
    await new Promise((r) => setTimeout(r, 400));
    expect(sent).not.toHaveBeenCalled();

    await dev.patch('/api/me/notification-settings').send({ settings: { assigned: { push: true } } }).expect(200);
    sent.mockRejectedValue(Object.assign(new Error('gone'), { statusCode: 410 }));
    await owner.post(`${base()}/issues`, { title: 'Dead device', kind: 'bug', assigneeId: devId }).expect(201);
    await vi.waitFor(() => expect(sent).toHaveBeenCalled(), { timeout: 3000 });
    sent.mockReset();
    sent.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    await new Promise((r) => setTimeout(r, 200)); // the 410 removes the subscription
    await owner.post(`${base()}/issues`, { title: 'After the 410', kind: 'bug', assigneeId: devId }).expect(201);
    await new Promise((r) => setTimeout(r, 400));
    expect(sent).not.toHaveBeenCalled();
  });
});
