import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

type Notification = { id: string; kind: string; title: string; body?: string; link: string; readAt?: string };

/** Notifications are produced after the request returns, so poll instead of asserting at once. */
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let last!: T;
  for (let i = 0; i < 40; i++) {
    last = await read();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
}

describe('notifications', () => {
  let app: INestApplication;
  let owner: Client;
  let dev: Client;
  let devId: string;
  let slug: string;
  let teamId: string;
  const base = () => `/api/w/${slug}`;
  const inbox = async (c: Client) => (await c.get(`${base()}/notifications`).expect(200)).body as { items: Notification[]; unread: number };

  beforeAll(async () => {
    app = await createTestApp();
    const o = await Client.signup(app.getHttpServer(), 'Olivia Owner');
    owner = o.client;
    slug = (await owner.post('/api/workspaces', { name: 'Notify Co' }).expect(201)).body.slug;
    teamId = (await owner.post(`${base()}/teams`, { name: 'Core', key: 'CORE', memberIds: [o.user.id] }).expect(201)).body.id;
    const d = await Client.signup(app.getHttpServer(), 'Dev Dana');
    dev = d.client;
    devId = d.user.id;
    await owner.post(`${base()}/members`, { email: d.email, role: 'member' }).expect(201);
  });
  afterAll(() => app.close());

  it('tells someone an issue was assigned to them, and only them', async () => {
    const issue = (await owner.post(`${base()}/issues`, { title: 'Session expires', kind: 'bug', assigneeId: devId }).expect(201)).body;
    const { items, unread } = await eventually(() => inbox(dev), (v) => v.items.length > 0, 'the assignment');
    expect(unread).toBe(1);
    expect(items[0]).toMatchObject({ kind: 'assigned', link: `issues/${issue.key}`, title: `Olivia Owner assigned you ${issue.key}: Session expires` });
    expect(items[0].readAt).toBeUndefined();
    expect((await inbox(owner)).items).toEqual([]); // the person who acted is not told
  });

  it('notifies a new assignee on update, but not when nothing changed', async () => {
    const issue = (await owner.post(`${base()}/issues`, { title: 'Reassign me', kind: 'feature' }).expect(201)).body;
    await owner.patch(`${base()}/issues/${issue.key}`, { title: 'Reassign me please' }).expect(200);
    await owner.patch(`${base()}/issues/${issue.key}`, { assigneeId: devId }).expect(200);
    await eventually(() => inbox(dev), (v) => v.items.some((n) => n.title.includes('Reassign me please')), 'the reassignment');
    await owner.patch(`${base()}/issues/${issue.key}`, { assigneeId: devId }).expect(200); // same assignee again
    await new Promise((r) => setTimeout(r, 300));
    const mine = (await inbox(dev)).items.filter((n) => n.kind === 'assigned' && n.title.includes('Reassign me'));
    expect(mine).toHaveLength(1);
  });

  it('comments notify the assignee; marking read lowers the unread count', async () => {
    const issue = (await owner.post(`${base()}/issues`, { title: 'Needs eyes', kind: 'bug', assigneeId: devId }).expect(201)).body;
    await owner.post(`${base()}/comments`, { subject: { type: 'issue', id: issue.id }, body: 'Looks like a race condition in the refresh path.' }).expect(201);
    const after = await eventually(() => inbox(dev), (v) => v.items.some((n) => n.kind === 'comment'), 'the comment');
    const comment = after.items.find((n) => n.kind === 'comment')!;
    expect(comment).toMatchObject({ link: `issues/${issue.key}`, body: 'Looks like a race condition in the refresh path.' });

    const unreadBefore = after.unread;
    const res = (await dev.post(`${base()}/notifications/read`, { ids: [comment.id] }).expect(200)).body;
    expect(res.unread).toBe(unreadBefore - 1);
    expect((await inbox(dev)).items.find((n) => n.id === comment.id)?.readAt).toBeTruthy();
    expect((await dev.get(`${base()}/notifications?unread=true`).expect(200)).body.items.map((n: Notification) => n.id)).not.toContain(comment.id);

    expect((await dev.post(`${base()}/notifications/read`, {}).expect(200)).body.unread).toBe(0); // no ids: everything
  });

  it('routes questions, review requests and failing CI to the right person', async () => {
    const ws = (
      await owner
        .post(`${base()}/workstreams`, { title: 'Harden auth', ownerTeamId: teamId, deltaThreadUrl: 'https://delta.dev/t/n', accountableUserId: devId })
        .expect(201)
    ).body;
    await owner.post(`${base()}/input-requests`, { workstreamId: ws.id, question: 'Keep the polyfill?' }).expect(201);
    const pr = (
      await owner.post(`${base()}/artifacts`, { workstreamId: ws.id, kind: 'pull_request', title: 'PR #7', state: 'open', ci: 'pending', review: 'none' }).expect(201)
    ).body;
    await owner.patch(`${base()}/artifacts/${pr.id}`, { review: 'requested' }).expect(200);
    await owner.patch(`${base()}/artifacts/${pr.id}`, { ci: 'failing' }).expect(200);

    const { items } = await eventually(
      () => inbox(dev),
      (v) => ['input_requested', 'review_requested', 'ci_failed'].every((k) => v.items.some((n) => n.kind === k)),
      'the three workstream notifications',
    );
    const by = (kind: string) => items.find((n) => n.kind === kind)!;
    expect(by('input_requested')).toMatchObject({ body: 'Keep the polyfill?', link: `workstreams/${ws.key}` });
    expect(by('review_requested').title).toBe('Review requested: PR #7');
    expect(by('ci_failed').title).toBe('Checks are failing: PR #7');
  });

  it('respects the settings: a muted kind produces nothing', async () => {
    const before = (await dev.get('/api/me/notification-settings').expect(200)).body;
    expect(before.settings.assigned).toEqual({ inApp: true, email: false });
    expect(before.emailAvailable).toBe(false);

    const updated = (await dev.patch('/api/me/notification-settings', { settings: { assigned: { inApp: false } } }).expect(200)).body;
    expect(updated.settings.assigned).toEqual({ inApp: false, email: false });
    expect(updated.settings.comment).toEqual({ inApp: true, email: false }); // untouched

    const count = (await inbox(dev)).items.length;
    await owner.post(`${base()}/issues`, { title: 'Muted assignment', kind: 'bug', assigneeId: devId }).expect(201);
    await new Promise((r) => setTimeout(r, 400));
    expect((await inbox(dev)).items).toHaveLength(count);

    await dev.patch('/api/me/notification-settings', { settings: { assigned: { inApp: true } } }).expect(200);
    await dev.patch('/api/me/notification-settings', { settings: { nonsense: { inApp: true } } }).expect(400);
    await dev.patch('/api/me/notification-settings', { settings: { assigned: { sms: true } } }).expect(400);
    await dev.patch('/api/me/notification-settings', { settings: { assigned: { inApp: 'yes' } } }).expect(400);
  });

  it('keeps notifications private, and out of agents’ reach', async () => {
    expect((await inbox(owner)).items.map((n) => n.title).join('\n')).not.toMatch(/assigned you/);
    const agent = (await owner.post(`${base()}/agents`, { name: 'Bot', provider: 'claude_code' }).expect(201)).body;
    const token = (await owner.post(`${base()}/tokens`, { name: 'bot', agentId: agent.id }).expect(201)).body;
    const asAgent = new TokenClient(app.getHttpServer(), token.secret);
    await asAgent.get(`${base()}/notifications`).expect(403);
  });
});
