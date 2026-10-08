import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

describe('domain', () => {
  let app: INestApplication;
  let c: Client;
  let slug: string;
  let auth: { id: string; key: string };
  let web: { id: string; key: string };
  const base = () => `/api/w/${slug}`;

  beforeAll(async () => {
    app = await createTestApp();
    const u = await Client.signup(app.getHttpServer(), 'Domain Dev');
    c = u.client;
    slug = (await c.post('/api/workspaces', { name: 'Domain Co' }).expect(201)).body.slug;
    auth = (await c.post(`${base()}/teams`, { name: 'Identity', key: 'AUTH', memberIds: [u.user.id] }).expect(201)).body;
    web = (await c.post(`${base()}/teams`, { name: 'Web', key: 'WEB' }).expect(201)).body;
  });
  afterAll(() => app.close());

  const events = async (q = '') => (await c.get(`${base()}/events?${q}`).expect(200)).body as Array<{ type: string; subject: { type: string; id: string }; workstreamId?: string; actor: { type: string } }>;

  it('numbers workstreams per owner team and finds them by id or key', async () => {
    const a1 = (await c.post(`${base()}/workstreams`, { title: 'One', ownerTeamId: auth.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    const a2 = (await c.post(`${base()}/workstreams`, { title: 'Two', ownerTeamId: auth.id, deltaThreadUrl: 'https://delta.dev/t/e2e', acceptanceCriteria: [{ text: 'Works' }] }).expect(201)).body;
    const w1 = (await c.post(`${base()}/workstreams`, { title: 'Web one', ownerTeamId: web.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    expect([a1.key, a2.key, w1.key]).toEqual(['AUTH-1', 'AUTH-2', 'WEB-1']);
    expect(a1.status).toBe('draft');
    expect(a2.status).toBe('planned');
    expect((await c.get(`${base()}/workstreams/auth-2`).expect(200)).body.id).toBe(a2.id);
    expect((await c.get(`${base()}/workstreams/${a2.id}`).expect(200)).body.key).toBe('AUTH-2');
    await c.get(`${base()}/workstreams/AUTH-99`).expect(404);

    // moving to another team keeps the key
    const moved = (await c.patch(`${base()}/workstreams/AUTH-1`, { ownerTeamId: web.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(200)).body;
    expect(moved.key).toBe('AUTH-1');
    expect(moved.ownerTeamId).toBe(web.id);
    // new numbering continues per team
    expect((await c.post(`${base()}/workstreams`, { title: 'Three', ownerTeamId: auth.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body.key).toBe('AUTH-3');
    auth = { ...auth };
  });

  it('records a domain event for every mutation and filters them', async () => {
    const ws = (await c.post(`${base()}/workstreams`, { title: 'Evented', ownerTeamId: auth.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    await c.patch(`${base()}/workstreams/${ws.key}`, { priority: 'urgent' }).expect(200);
    const crit = (await c.post(`${base()}/workstreams/${ws.key}/criteria`, { text: 'Ship it' }).expect(201)).body.acceptanceCriteria[0];
    await c.patch(`${base()}/workstreams/${ws.key}/criteria/${crit.id}`, { state: 'met' }).expect(200);
    await c.post(`${base()}/comments`, { subject: { type: 'workstream', id: ws.id }, body: 'Looks good' }).expect(201);

    const types = (await events(`workstreamId=${ws.id}`)).map((e) => e.type);
    for (const t of ['workstream.created', 'workstream.updated', 'criterion.updated', 'comment.created'])
      expect(types).toContain(t);
    expect((await events('type=comment.&limit=1')).length).toBe(1);
  });

  it('issues: per-kind numbering, link into a new workstream, many issues → one workstream', async () => {
    const bug = (await c.post(`${base()}/issues`, { kind: 'bug', title: 'Users get logged out' }).expect(201)).body;
    const bug2 = (await c.post(`${base()}/issues`, { kind: 'bug', title: 'Safari logs out' }).expect(201)).body;
    const feat = (await c.post(`${base()}/issues`, { kind: 'feature', title: 'SSO' }).expect(201)).body;
    expect([bug.key, bug2.key, feat.key]).toEqual(['BUG-1', 'BUG-2', 'FEAT-1']);
    expect(bug.status).toBe('backlog');

    const linked = (
      await c.post(`${base()}/issues/BUG-1/link`, { createWorkstream: { title: 'Fix session loss', objective: 'Sessions are stable', ownerTeamId: auth.id, deltaThreadUrl: 'https://delta.dev/t/fix-session' } }).expect(200)
    ).body;
    expect(linked.status).toBe('in_progress');
    expect(linked.workstreamIds).toHaveLength(1);
    const ws = (await c.get(`${base()}/workstreams/${linked.workstreamIds[0]}`).expect(200)).body;
    expect(ws.title).toBe('Fix session loss');
    expect(ws.key).toMatch(/^AUTH-\d+$/);

    const second = (await c.post(`${base()}/issues/${bug2.id}/link`, { workstreamIds: [ws.id] }).expect(200)).body;
    expect(second.workstreamIds).toEqual([ws.id]);
    expect((await c.get(`${base()}/issues?workstreamId=${ws.id}`).expect(200)).body).toHaveLength(2);

    await c.patch(`${base()}/issues/FEAT-1`, { duplicateOfId: 'FEAT-1' }).expect(400);
    const dup = (await c.patch(`${base()}/issues/FEAT-1`, { duplicateOfId: 'BUG-1' }).expect(200)).body;
    expect(dup).toMatchObject({ duplicateOfId: bug.id, status: 'canceled' });
    await c.post(`${base()}/issues/BUG-1/link`, { workstreamIds: ['wk_missing'] }).expect(400);
    await c.post(`${base()}/issues/FEAT-1/link`, { workstreamIds: [ws.id] }).expect(400);

    const types = (await events(`workstreamId=${ws.id}`)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['workstream.created', 'issue.linked']));
  });

  it('input requests: open, answer, dismiss, 409 when already closed', async () => {
    const ws = (await c.post(`${base()}/workstreams`, { title: 'Needs answers', ownerTeamId: auth.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    const ir = (await c.post(`${base()}/input-requests`, { workstreamId: ws.id, question: 'Refresh token TTL?', options: ['7d', '30d'] }).expect(201)).body;
    expect(ir).toMatchObject({ state: 'open', workstreamId: ws.id });
    const answered = (await c.post(`${base()}/input-requests/${ir.id}/answer`, { answer: '30d' }).expect(200)).body;
    expect(answered).toMatchObject({ state: 'answered', answer: '30d' });
    await c.post(`${base()}/input-requests/${ir.id}/answer`, { answer: 'x' }).expect(409);
    const ir2 = (await c.post(`${base()}/input-requests`, { workstreamId: ws.id, question: 'Another?' }).expect(201)).body;
    expect((await c.post(`${base()}/input-requests/${ir2.id}/dismiss`).expect(200)).body.state).toBe('dismissed');
  });

  it('dependencies reject cycles and duplicates', async () => {
    const mk = async (title: string) => (await c.post(`${base()}/workstreams`, { title, ownerTeamId: web.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    const [a, b, d] = [await mk('A'), await mk('B'), await mk('C')];
    const dep = (await c.post(`${base()}/dependencies`, { fromType: 'workstream', fromId: a.id, toType: 'workstream', toId: b.id }).expect(201)).body;
    await c.post(`${base()}/dependencies`, { fromType: 'workstream', fromId: b.id, toType: 'workstream', toId: d.id }).expect(201);
    await c.post(`${base()}/dependencies`, { fromType: 'workstream', fromId: a.id, toType: 'workstream', toId: b.id }).expect(409);
    await c.post(`${base()}/dependencies`, { fromType: 'workstream', fromId: d.id, toType: 'workstream', toId: a.id }).expect(409);
    await c.post(`${base()}/dependencies`, { fromType: 'workstream', fromId: a.id, toType: 'workstream', toId: a.id }).expect(400);
    await c.delete(`${base()}/dependencies/${dep.id}`).expect(204);
  });

  it('decisions: ADR numbering, accept (people only), supersede chain', async () => {
    const ws = (await c.post(`${base()}/workstreams`, { title: 'Decide', ownerTeamId: auth.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    const d1 = (await c.post(`${base()}/decisions`, { title: 'Use JWT', statement: 'JWT it is', originWorkstreamId: ws.id }).expect(201)).body;
    const d2 = (await c.post(`${base()}/decisions`, { title: 'Rotate tokens', statement: 'Rotate' }).expect(201)).body;
    expect([d1.key, d2.key]).toEqual(['ADR-1', 'ADR-2']);
    expect(d1.status).toBe('proposed');

    // agents may propose but not accept
    const agent = (await c.post(`${base()}/agents`, { name: 'Claude', provider: 'claude_code' }).expect(201)).body;
    const tk = (await c.post(`${base()}/tokens`, { name: 'agent', agentId: agent.id }).expect(201)).body;
    const bot = new TokenClient(app.getHttpServer(), tk.secret);
    const proposed = (await bot.post(`${base()}/decisions`, { title: 'Agent idea', statement: 'x' }).expect(201)).body;
    expect(proposed.proposedBy).toEqual({ type: 'agent', id: agent.id });
    await bot.post(`${base()}/decisions/${proposed.key}/accept`).expect(403);

    expect((await c.post(`${base()}/decisions/ADR-1/accept`).expect(200)).body).toMatchObject({ status: 'accepted' });
    await c.post(`${base()}/decisions/ADR-1/accept`).expect(409);
    await c.post(`${base()}/decisions/ADR-2/accept`).expect(200);
    const sup = (await c.post(`${base()}/decisions/ADR-1/supersede`, { byId: 'ADR-2' }).expect(200)).body;
    expect(sup).toMatchObject({ status: 'superseded', supersededById: d2.id });
    await c.post(`${base()}/decisions/ADR-2/supersede`, { byId: 'ADR-1' }).expect(409);
    // agent writes are attributed to the agent
    const created = (await events(`subject=decision:${proposed.id}`))[0];
    expect(created.actor).toEqual({ type: 'agent', id: agent.id });
  });

  it('artifacts, views (shared vs private) and the snapshot', async () => {
    const ws = (await c.post(`${base()}/workstreams`, { title: 'With PR', ownerTeamId: web.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    const pr = (await c.post(`${base()}/artifacts`, { workstreamId: ws.id, kind: 'pull_request', title: 'Add thing', externalId: '#1', review: 'requested' }).expect(201)).body;
    expect(pr).toMatchObject({ provider: 'github', state: 'open', ci: 'pending', hasConflicts: false });
    const updated = (await c.patch(`${base()}/artifacts/${pr.id}`, { ci: 'failing', hasConflicts: true }).expect(200)).body;
    expect(updated).toMatchObject({ ci: 'failing', hasConflicts: true });
    expect((await events(`workstreamId=${ws.id}`)).map((e) => e.type)).toEqual(expect.arrayContaining(['artifact.attached', 'artifact.updated', 'review.requested']));

    // saved views: private to the owner, shared visible to everyone in the workspace
    const other = await Client.signup(app.getHttpServer(), 'Other');
    await c.post(`${base()}/members`, { email: other.email, role: 'member' }).expect(201);
    const priv = (await c.post(`${base()}/views`, { name: 'Mine', entity: 'workstream' }).expect(201)).body;
    const shared = (await c.post(`${base()}/views`, { name: 'Ours', entity: 'workstream', shared: true, filters: [{ field: 'status', op: 'is', value: 'blocked' }] }).expect(201)).body;
    const seen = (await other.client.get(`${base()}/views`).expect(200)).body.map((v: { id: string }) => v.id);
    expect(seen).toContain(shared.id);
    expect(seen).not.toContain(priv.id);
    await other.client.get(`${base()}/views/${priv.id}`).expect(404);
    await other.client.patch(`${base()}/views/${shared.id}`, { name: 'Hijack' }).expect(403);
    expect(shared.filters).toEqual([{ field: 'status', op: 'is', value: 'blocked' }]);

    const snap = (await c.get(`${base()}/snapshot`).expect(200)).body;
    expect(snap.workspace.slug).toBe(slug);
    expect(snap.myRole).toBe('owner');
    expect(snap.me.passwordHash).toBeUndefined();
    expect(snap.users.every((u: { passwordHash?: string }) => u.passwordHash === undefined)).toBe(true);
    expect(snap.workstreams.length).toBeGreaterThan(5);
    expect(snap.workstreams[0].deltaThreadUrl).toMatch(/^https:\/\/delta\.dev\//);
    expect(snap.executions).toBeUndefined();
    expect(Array.isArray(snap.attention)).toBe(true);
    expect(Array.isArray((await c.get(`${base()}/attention`).expect(200)).body)).toBe(true);
  });

  it('fires WorkstreamTouched for every workstream-related change', async () => {
    const { WorkstreamBus } = await import('../src/events/workstream-bus.js');
    const bus = app.get(WorkstreamBus);
    const touched: string[] = [];
    const off = bus.onTouched((e) => void touched.push(`${e.reason}`));
    const ws = (await c.post(`${base()}/workstreams`, { title: 'Hooked', ownerTeamId: web.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    await c.post(`${base()}/input-requests`, { workstreamId: ws.id, question: 'q?' }).expect(201);
    await c.post(`${base()}/artifacts`, { workstreamId: ws.id, kind: 'document', title: 'b' }).expect(201);
    await c.post(`${base()}/decisions`, { title: 'd', statement: 's', originWorkstreamId: ws.id }).expect(201);
    off();
    expect(touched).toEqual(
      expect.arrayContaining(['workstream.created', 'input.requested', 'artifact.attached', 'decision.created']),
    );
  });

  it('deleting a team that owns workstreams is a 409; deleting a workstream cleans up', async () => {
    await c.delete(`${base()}/teams/AUTH`).expect(409);
    const ws = (await c.post(`${base()}/workstreams`, { title: 'Temp', ownerTeamId: web.id, deltaThreadUrl: 'https://delta.dev/t/e2e' }).expect(201)).body;
    await c.post(`${base()}/artifacts`, { workstreamId: ws.id, kind: 'document', title: 'Notes' }).expect(201);
    await c.delete(`${base()}/workstreams/${ws.key}`).expect(204);
    await c.get(`${base()}/workstreams/${ws.key}`).expect(404);
    expect((await c.get(`${base()}/artifacts?workstreamId=${ws.id}`).expect(200)).body).toEqual([]);
  });
});
