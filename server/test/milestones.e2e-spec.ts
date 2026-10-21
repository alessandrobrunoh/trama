import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('milestones, estimates, issue facts and re-keying', () => {
  let app: INestApplication;
  let c: Client;
  let me: string;
  let slug: string;
  const base = () => `/api/w/${slug}`;
  const mkProject = async (name: string) => (await c.post(`${base()}/projects`, { name }).expect(201)).body;
  const mkIssue = async (kind: string, title: string, extra: object = {}) =>
    (await c.post(`${base()}/issues`, { kind, title, ...extra }).expect(201)).body;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Milestone Dev');
    c = u.client;
    me = u.user.id;
    slug = (await c.post('/api/workspaces', { name: 'Milestone Co' }).expect(201)).body.slug;
  });
  afterAll(() => app.close());

  it('milestone CRUD, ordering, snapshot and events', async () => {
    const project = await mkProject('With milestones');
    const m1 = (await c.post(`${base()}/milestones`, { projectId: project.id, name: 'Alpha', targetDate: '2026-12-01T00:00:00.000Z' }).expect(201)).body;
    const m2 = (await c.post(`${base()}/milestones`, { projectId: project.id, name: 'Beta', description: 'second' }).expect(201)).body;
    const m3 = (await c.post(`${base()}/milestones`, { projectId: project.id, name: 'GA' }).expect(201)).body;
    expect(m1.id).toMatch(/^ms_/);
    expect(m1.projectId).toBe(project.id);
    expect([m1.sortOrder, m2.sortOrder, m3.sortOrder]).toEqual([0, 1, 2]);
    await c.post(`${base()}/milestones`, { projectId: 'pj_missing', name: 'x' }).expect(400);

    const renamed = (await c.patch(`${base()}/milestones/${m2.id}`, { name: 'Beta 2', targetDate: '2026-12-15T00:00:00.000Z', description: null }).expect(200)).body;
    expect(renamed.name).toBe('Beta 2');
    expect(renamed.description).toBeUndefined();

    const ordered = (await c.post(`${base()}/milestones/reorder`, { projectId: project.id, ids: [m3.id, m1.id, m2.id] }).expect(200)).body;
    expect(ordered.map((m: { id: string }) => m.id)).toEqual([m3.id, m1.id, m2.id]);
    await c.post(`${base()}/milestones/reorder`, { projectId: project.id, ids: [m3.id, 'ms_nope'] }).expect(400);
    expect((await c.get(`${base()}/milestones?projectId=${project.id}`).expect(200)).body.map((m: { id: string }) => m.id)).toEqual([m3.id, m1.id, m2.id]);

    const snap = (await c.get(`${base()}/snapshot`).expect(200)).body;
    expect(snap.milestones.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([m1.id, m2.id, m3.id]));

    await c.delete(`${base()}/milestones/${m3.id}`).expect(204);
    await c.get(`${base()}/milestones/${m3.id}`).expect(404);
    const types = ((await c.get(`${base()}/events`).expect(200)).body as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['milestone.created', 'milestone.updated', 'milestone.deleted']));
  });

  it('issues: a project of their own gives access to its milestones, filters, and is cleared with the project', async () => {
    const pA = await mkProject('Direct A');
    const pB = await mkProject('Direct B');
    const a1 = (await c.post(`${base()}/milestones`, { projectId: pA.id, name: 'A1' }).expect(201)).body;
    const b1 = (await c.post(`${base()}/milestones`, { projectId: pB.id, name: 'B1' }).expect(201)).body;
    const issue = await mkIssue('feature', 'Direct project', { projectId: pA.id });
    expect(issue.projectId).toBe(pA.id);
    await c.post(`${base()}/issues`, { kind: 'bug', title: 'Ghost', projectId: 'pj_missing' }).expect(400);
    await c.patch(`${base()}/issues/${issue.key}`, { projectId: 'pj_missing' }).expect(400);

    // milestones of its own project; other projects stay out of reach
    await c.patch(`${base()}/issues/${issue.key}`, { milestoneIds: [b1.id] }).expect(400);
    expect((await c.patch(`${base()}/issues/${issue.key}`, { milestoneIds: [a1.id] }).expect(200)).body.milestoneIds).toEqual([a1.id]);
    expect((await c.get(`${base()}/issues?projectId=${pA.id}`).expect(200)).body.map((i: { key: string }) => i.key)).toEqual([issue.key]);
    expect((await c.get(`${base()}/issues?projectId=${pB.id}`).expect(200)).body).toEqual([]);

    // clearing its project removes access to the project's milestone
    const cleared = (await c.patch(`${base()}/issues/${issue.key}`, { projectId: null }).expect(200)).body;
    expect(cleared.projectId).toBeUndefined();
    expect(cleared.milestoneIds).toEqual([]);
    expect((await c.get(`${base()}/issues/${issue.key}`).expect(200)).body.milestoneIds).toEqual([]);

    // moving to another project drops the old project's milestone
    await c.patch(`${base()}/issues/${issue.key}`, { projectId: pA.id }).expect(200);
    await c.patch(`${base()}/issues/${issue.key}`, { milestoneIds: [a1.id] }).expect(200);
    const moved = (await c.patch(`${base()}/issues/${issue.key}`, { projectId: pB.id }).expect(200)).body;
    expect(moved.projectId).toBe(pB.id);
    expect(moved.milestoneIds).toEqual([]);

    // deleting the project detaches its issues
    await c.delete(`${base()}/projects/${pB.id}`).expect(204);
    expect((await c.get(`${base()}/issues/${issue.key}`).expect(200)).body.projectId).toBeUndefined();
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

    // A new Issue starts in backlog; moving it explicitly starts the work clock.
    const linked = await mkIssue('bug', 'Linked');
    expect(linked.status).toBe('backlog');
    expect(linked.startedAt).toBeFalsy();
    expect(linked.assigneeId).toBeFalsy();
    const started2 = (await c.patch(`${base()}/issues/${linked.key}`, { status: 'in_progress' }).expect(200)).body;
    expect(started2.status).toBe('in_progress');
    expect(started2.startedAt).toBeTruthy();
    expect(started2.assigneeId).toBe(me);

    // created straight into done
    const finished = await mkIssue('idea', 'Already done', { status: 'done' });
    expect(finished.completedAt).toBeTruthy();
  });

  it('assigns the user who moves an unassigned issue to in_progress', async () => {
    const filed = await mkIssue('bug', 'Filed only');
    expect(filed.assigneeId).toBeUndefined();

    const started = (await c.patch(`${base()}/issues/${filed.key}`, { status: 'in_progress' }).expect(200)).body;
    expect(started.assigneeId).toBe(me);
    const review = (await c.patch(`${base()}/issues/${filed.key}`, { status: 'in_review' }).expect(200)).body;
    expect(review.assigneeId).toBe(me);

    const kept = await mkIssue('bug', 'Already owned', { assigneeId: me, status: 'todo' });
    const moved = (await c.patch(`${base()}/issues/${kept.key}`, { status: 'in_progress' }).expect(200)).body;
    expect(moved.assigneeId).toBe(me);

    const declined = await mkIssue('bug', 'Leave empty');
    const empty = (await c.patch(`${base()}/issues/${declined.key}`, { status: 'in_progress', assigneeId: null }).expect(200)).body;
    expect(empty.assigneeId).toBeUndefined();

    const born = await mkIssue('bug', 'Born started', { status: 'in_progress' });
    expect(born.assigneeId).toBe(me);

    const evs = (await c.get(`${base()}/events?type=issue.updated`).expect(200)).body as {
      subject: { id: string };
      data: { fields: string[]; assignee?: { to: string } };
    }[];
    expect(evs.some((e) => e.subject.id === filed.id && e.data.fields.includes('assigneeId') && e.data.assignee?.to === me)).toBe(true);
  });

  it('changing the kind re-keys the issue and keeps the old key working', async () => {
    const bug = await mkIssue('bug', 'Actually a feature');
    const feat0 = await mkIssue('feature', 'Existing feature');
    const rekeyed = (await c.patch(`${base()}/issues/${bug.key}`, { kind: 'feature', title: 'Now a feature' }).expect(200)).body;
    expect(rekeyed.id).toBe(bug.id);
    expect(rekeyed.kind).toBe('feature');
    expect(rekeyed.key).toBe(`FEAT-${feat0.number + 1}`);
    expect(rekeyed.number).toBe(feat0.number + 1);
    expect(rekeyed.aliases).toEqual([bug.key]);
    expect(rekeyed.title).toBe('Now a feature');

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
    const issue = await mkIssue('bug', 'Artifacts');
    for (const kind of ['commit', 'branch'])
      await c.post(`${base()}/artifacts`, { issueId: issue.id, kind, title: 'x' }).expect(400);
    const artifact = await c.post(`${base()}/artifacts`, {
      issueId: issue.id,
      kind: 'pull_request',
      title: 'PR',
    });
    expect(artifact.status, JSON.stringify(artifact.body)).toBe(201);
  });
});
