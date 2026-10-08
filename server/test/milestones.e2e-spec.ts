import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('milestones, estimates, issue facts and re-keying', () => {
  let app: INestApplication;
  let c: Client;
  let slug: string;
  let team: { id: string };
  const base = () => `/api/w/${slug}`;
  const mkWs = async (title: string) =>
    (await c.post(`${base()}/workstreams`, { title, ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
  const mkIssue = async (kind: string, title: string, extra: object = {}) =>
    (await c.post(`${base()}/issues`, { kind, title, ...extra }).expect(201)).body;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Milestone Dev');
    c = u.client;
    slug = (await c.post('/api/workspaces', { name: 'Milestone Co' }).expect(201)).body.slug;
    team = (await c.post(`${base()}/teams`, { name: 'Identity', key: 'AUTH', memberIds: [u.user.id] }).expect(201)).body;
  });
  afterAll(() => app.close());

  it('milestone CRUD, ordering, snapshot and events', async () => {
    const ws = await mkWs('With milestones');
    const m1 = (await c.post(`${base()}/milestones`, { workstreamId: ws.id, name: 'Alpha', targetDate: '2026-12-01T00:00:00.000Z' }).expect(201)).body;
    const m2 = (await c.post(`${base()}/milestones`, { workstreamId: ws.id, name: 'Beta', description: 'second' }).expect(201)).body;
    const m3 = (await c.post(`${base()}/milestones`, { workstreamId: ws.id, name: 'GA' }).expect(201)).body;
    expect(m1.id).toMatch(/^ms_/);
    expect([m1.sortOrder, m2.sortOrder, m3.sortOrder]).toEqual([0, 1, 2]);
    await c.post(`${base()}/milestones`, { workstreamId: 'wk_missing', name: 'x' }).expect(400);

    const renamed = (await c.patch(`${base()}/milestones/${m2.id}`, { name: 'Beta 2', targetDate: '2026-12-15T00:00:00.000Z', description: null }).expect(200)).body;
    expect(renamed.name).toBe('Beta 2');
    expect(renamed.description).toBeUndefined();

    const ordered = (await c.post(`${base()}/milestones/reorder`, { workstreamId: ws.id, ids: [m3.id, m1.id, m2.id] }).expect(200)).body;
    expect(ordered.map((m: { id: string }) => m.id)).toEqual([m3.id, m1.id, m2.id]);
    await c.post(`${base()}/milestones/reorder`, { workstreamId: ws.id, ids: [m3.id, 'ms_nope'] }).expect(400);
    expect((await c.get(`${base()}/milestones?workstreamId=${ws.id}`).expect(200)).body.map((m: { id: string }) => m.id)).toEqual([m3.id, m1.id, m2.id]);

    const snap = (await c.get(`${base()}/snapshot`).expect(200)).body;
    expect(snap.milestones.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([m1.id, m2.id, m3.id]));

    await c.delete(`${base()}/milestones/${m3.id}`).expect(204);
    await c.get(`${base()}/milestones/${m3.id}`).expect(404);
    const types = ((await c.get(`${base()}/events?workstreamId=${ws.id}`).expect(200)).body as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['milestone.created', 'milestone.updated', 'milestone.deleted']));
  });

  it('issues: one milestone per linked workstream; unlinking drops it; deleting cleans issues', async () => {
    const wsA = await mkWs('A');
    const wsB = await mkWs('B');
    const a1 = (await c.post(`${base()}/milestones`, { workstreamId: wsA.id, name: 'A1' }).expect(201)).body;
    const a2 = (await c.post(`${base()}/milestones`, { workstreamId: wsA.id, name: 'A2' }).expect(201)).body;
    const b1 = (await c.post(`${base()}/milestones`, { workstreamId: wsB.id, name: 'B1' }).expect(201)).body;
    const issue = await mkIssue('bug', 'Milestoned');
    expect(issue.milestoneIds).toEqual([]);
    expect(issue.aliases).toEqual([]);

    // not linked yet
    await c.patch(`${base()}/issues/${issue.key}`, { milestoneIds: [a1.id] }).expect(400);
    await c.patch(`${base()}/issues/${issue.key}`, { workstreamIds: [wsA.id, wsB.id] }).expect(200);
    // two milestones of the same workstream
    await c.patch(`${base()}/issues/${issue.key}`, { milestoneIds: [a1.id, a2.id] }).expect(400);
    await c.patch(`${base()}/issues/${issue.key}`, { milestoneIds: ['ms_missing'] }).expect(400);
    const set = (await c.patch(`${base()}/issues/${issue.key}`, { milestoneIds: [a1.id, b1.id] }).expect(200)).body;
    expect(set.milestoneIds).toEqual([a1.id, b1.id]);
    expect((await c.get(`${base()}/issues?milestoneId=${a1.id}`).expect(200)).body).toHaveLength(1);

    // unlinking workstream B removes B's milestone only
    const unlinked = (await c.patch(`${base()}/issues/${issue.key}`, { workstreamIds: [wsA.id] }).expect(200)).body;
    expect(unlinked.milestoneIds).toEqual([a1.id]);

    // deleting the milestone removes it from the issue
    await c.delete(`${base()}/milestones/${a1.id}`).expect(204);
    expect((await c.get(`${base()}/issues/${issue.key}`).expect(200)).body.milestoneIds).toEqual([]);

    // deleting the workstream cascades its milestones
    await c.patch(`${base()}/issues/${issue.key}`, { milestoneIds: [a2.id] }).expect(200);
    await c.delete(`${base()}/workstreams/${wsA.key}`).expect(204);
    await c.get(`${base()}/milestones/${a2.id}`).expect(404);
    expect((await c.get(`${base()}/issues/${issue.key}`).expect(200)).body.milestoneIds).toEqual([]);
  });

  it('workstream startDate', async () => {
    const ws = (await c.post(`${base()}/workstreams`, { title: 'Dated', ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e', startDate: '2026-10-01T00:00:00.000Z' }).expect(201)).body;
    expect(ws.startDate).toBe('2026-10-01T00:00:00.000Z');
    expect((await c.patch(`${base()}/workstreams/${ws.key}`, { startDate: null }).expect(200)).body.startDate).toBeUndefined();
  });

  it('estimate: validated, nullable, recorded in issue.updated', async () => {
    const issue = await mkIssue('feature', 'Estimated', { estimate: 3 });
    expect(issue.estimate).toBe(3);
    await c.patch(`${base()}/issues/${issue.key}`, { estimate: -1 }).expect(400);
    await c.patch(`${base()}/issues/${issue.key}`, { estimate: 'big' }).expect(400);
    expect((await c.patch(`${base()}/issues/${issue.key}`, { estimate: 0 }).expect(200)).body.estimate).toBe(0);
    expect((await c.patch(`${base()}/issues/${issue.key}`, { estimate: 8.5 }).expect(200)).body.estimate).toBe(8.5);
    expect((await c.patch(`${base()}/issues/${issue.key}`, { estimate: null }).expect(200)).body.estimate).toBeUndefined();
    const evs = (await c.get(`${base()}/events?type=issue.updated`).expect(200)).body as { subject: { id: string }; data: { fields: string[] } }[];
    expect(evs.some((e) => e.subject.id === issue.id && e.data.fields.includes('estimate'))).toBe(true);
  });

  it('startedAt / completedAt follow the status', async () => {
    const issue = await mkIssue('bug', 'Timed');
    expect(issue.startedAt).toBeUndefined();
    const todo = (await c.patch(`${base()}/issues/${issue.key}`, { status: 'todo' }).expect(200)).body;
    expect(todo.startedAt).toBeUndefined();
    const started = (await c.patch(`${base()}/issues/${issue.key}`, { status: 'in_progress' }).expect(200)).body;
    expect(started.startedAt).toBeTruthy();
    const back = (await c.patch(`${base()}/issues/${issue.key}`, { status: 'backlog' }).expect(200)).body;
    expect(back.startedAt).toBe(started.startedAt); // first start is kept
    const review = (await c.patch(`${base()}/issues/${issue.key}`, { status: 'in_review' }).expect(200)).body;
    expect(review.startedAt).toBe(started.startedAt);
    const done = (await c.patch(`${base()}/issues/${issue.key}`, { status: 'done' }).expect(200)).body;
    expect(done.completedAt).toBeTruthy();
    const reopened = (await c.patch(`${base()}/issues/${issue.key}`, { status: 'in_progress' }).expect(200)).body;
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.startedAt).toBe(started.startedAt);
    const canceled = (await c.patch(`${base()}/issues/${issue.key}`, { status: 'canceled' }).expect(200)).body;
    expect(canceled.completedAt).toBeTruthy();

    // linking moves backlog -> in_progress and starts the clock
    const linked = await mkIssue('bug', 'Linked');
    const ws = await mkWs('Link target');
    const afterLink = (await c.post(`${base()}/issues/${linked.key}/link`, { workstreamIds: [ws.id] }).expect(200)).body;
    expect(afterLink.status).toBe('in_progress');
    expect(afterLink.startedAt).toBeTruthy();

    // created straight into done
    const finished = await mkIssue('idea', 'Already done', { status: 'done' });
    expect(finished.completedAt).toBeTruthy();
  });

  it('changing the kind re-keys the issue and keeps the old key working', async () => {
    const bug = await mkIssue('bug', 'Actually a feature');
    const feat0 = await mkIssue('feature', 'Existing feature');
    const ws = await mkWs('Rekey');
    await c.patch(`${base()}/issues/${bug.key}`, { workstreamIds: [ws.id] }).expect(200);

    const rekeyed = (await c.patch(`${base()}/issues/${bug.key}`, { kind: 'feature', title: 'Now a feature' }).expect(200)).body;
    expect(rekeyed.id).toBe(bug.id);
    expect(rekeyed.kind).toBe('feature');
    expect(rekeyed.key).toBe(`FEAT-${feat0.number + 1}`);
    expect(rekeyed.number).toBe(feat0.number + 1);
    expect(rekeyed.aliases).toEqual([bug.key]);
    expect(rekeyed.title).toBe('Now a feature');
    expect(rekeyed.workstreamIds).toEqual([ws.id]);

    // old key (any case) and new key both resolve; the new key is what comes back
    expect((await c.get(`${base()}/issues/${bug.key}`).expect(200)).body.key).toBe(rekeyed.key);
    expect((await c.get(`${base()}/issues/${bug.key.toLowerCase()}`).expect(200)).body.id).toBe(bug.id);
    expect((await c.get(`${base()}/issues/${rekeyed.key}`).expect(200)).body.id).toBe(bug.id);
    expect((await c.get(`${base()}/issues?q=${bug.key}`).expect(200)).body.map((i: { id: string }) => i.id)).toContain(bug.id);

    // PATCH through the old key works too; same kind is a no-op for the key
    const same = (await c.patch(`${base()}/issues/${bug.key}`, { kind: 'feature', priority: 'high' }).expect(200)).body;
    expect(same.key).toBe(rekeyed.key);
    expect(same.aliases).toEqual([bug.key]);

    // new bugs never reuse the old number, and going back adds another alias
    const next = await mkIssue('bug', 'Next bug');
    expect(next.number).toBe(bug.number + 1);
    const back = (await c.patch(`${base()}/issues/${rekeyed.key}`, { kind: 'bug' }).expect(200)).body;
    expect(back.key).toBe(`BUG-${next.number + 1}`);
    expect(back.aliases).toEqual([bug.key, rekeyed.key]);

    const evs = (await c.get(`${base()}/events?type=issue.rekeyed`).expect(200)).body as { subject: { id: string }; data: { from: string; to: string } }[];
    const mine = evs.filter((e) => e.subject.id === bug.id);
    expect(mine.map((e) => `${e.data.from}>${e.data.to}`).sort((x, y) => x.localeCompare(y))).toEqual([`${bug.key}>${rekeyed.key}`, `${rekeyed.key}>${back.key}`].sort((x, y) => x.localeCompare(y)));
    await c.patch(`${base()}/issues/${bug.key}`, { kind: 'nonsense' }).expect(400);
    await c.get(`${base()}/issues/BUG-9999`).expect(404);
  });

  it('commit and branch artifacts are no longer accepted', async () => {
    const ws = await mkWs('Artifacts');
    for (const kind of ['commit', 'branch'])
      await c.post(`${base()}/artifacts`, { workstreamId: ws.id, kind, title: 'x' }).expect(400);
    await c.post(`${base()}/artifacts`, { workstreamId: ws.id, kind: 'pull_request', title: 'PR' }).expect(201);
  });
});
