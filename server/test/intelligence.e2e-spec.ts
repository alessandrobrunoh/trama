import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

interface Ev {
  type: string;
  data: { from?: string; to?: string };
  actor: { type: string };
}

describe('intelligence: status, attention, graph, search, context', () => {
  let app: INestApplication;
  let c: Client;
  let member: Client;
  let agent: TokenClient;
  let slug: string;
  let me: { id: string };
  let auth: { id: string };
  let infra: { id: string };
  const base = () => `/api/w/${slug}`;
  const get = async (url: string) => (await c.get(`${base()}${url}`).expect(200)).body;
  const ws = (idOrKey: string) => get(`/workstreams/${idOrKey}`);
  const mk = async (title: string, extra: object = {}, team = auth) =>
    (await c.post(`${base()}/workstreams`, { title, ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e', accountableUserId: me.id, ...extra }).expect(201)).body;

  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer();
    const u = await Client.signup(server, 'Intel Owner');
    c = u.client;
    me = u.user;
    slug = (await c.post('/api/workspaces', { name: 'Intel Co' }).expect(201)).body.slug;
    auth = (await c.post(`${base()}/teams`, { name: 'Identity', key: 'AUTH', memberIds: [me.id] }).expect(201)).body;
    infra = (await c.post(`${base()}/teams`, { name: 'Infra', key: 'INF' }).expect(201)).body;
    const m = await Client.signup(server, 'Plain Member');
    member = m.client;
    await c.post(`${base()}/members`, { email: m.email, role: 'member' }).expect(201);
    const a = (await c.post(`${base()}/agents`, { name: 'Claude', provider: 'claude_code' }).expect(201)).body;
    const tk = (await c.post(`${base()}/tokens`, { name: 'agent', agentId: a.id }).expect(201)).body;
    agent = new TokenClient(server, tk.secret);
  });
  afterAll(() => app.close());

  describe('status engine', () => {
    it('derives status through the lifecycle and records system events', async () => {
      const w = await mk('Rotate tokens');
      expect(w.status).toBe('draft');
      const withCriterion = (await c.post(`${base()}/workstreams/${w.key}/criteria`, { text: 'Sessions survive' }).expect(201)).body;
      expect((await ws(w.key)).status).toBe('planned');

      await c.post(`${base()}/artifacts`, { workstreamId: w.id, kind: 'build', title: 'auth-42 build' }).expect(201);
      expect((await ws(w.key)).status).toBe('working');

      const pr = (await c.post(`${base()}/artifacts`, { workstreamId: w.id, kind: 'pull_request', title: 'PR', externalId: '#1' }).expect(201)).body;
      expect((await ws(w.key)).status).toBe('in_review');
      await c.patch(`${base()}/artifacts/${pr.id}`, { ci: 'passing', review: 'approved' }).expect(200);
      expect((await ws(w.key)).status).toBe('ready_to_land');
      await c.patch(`${base()}/artifacts/${pr.id}`, { ci: 'failing' }).expect(200);
      expect((await ws(w.key)).status).toBe('blocked');
      await c.patch(`${base()}/artifacts/${pr.id}`, { ci: 'passing' }).expect(200);

      const ir = (await c.post(`${base()}/input-requests`, { workstreamId: w.id, question: 'Which TTL?' }).expect(201)).body;
      expect((await ws(w.key)).status).toBe('needs_input');
      await c.post(`${base()}/input-requests/${ir.id}/answer`, { answer: '30s' }).expect(200);
      expect((await ws(w.key)).status).toBe('ready_to_land');

      await c.patch(`${base()}/artifacts/${pr.id}`, { state: 'merged' }).expect(200);
      // Merged but the only criterion is open: the code landed, the outcome did not.
      expect(await ws(w.key)).toMatchObject({ status: 'working', delivery: 'merged', completion: { achieved: false, gaps: ['criteria_pending'] } });
      await c.patch(`${base()}/workstreams/${w.key}/criteria/${withCriterion.acceptanceCriteria[0].id}`, { state: 'met' }).expect(200);
      const shipped = await ws(w.key);
      expect(shipped.completion).toEqual({ achieved: true, gaps: [] });
      expect(shipped.status).toBe('shipped');
      expect(shipped.statusSource).toBe('derived');
      expect(shipped.shippedAt).toBeTruthy();
      // met without evidence: the historic report lists it, and nothing changes status
      const unproven = (await get('/insights/signals/shipped_without_proof')) as { items: { key: string; detail: string }[] };
      expect(unproven.items.find((i) => i.key === w.key)?.detail).toContain('without evidence');

      const evs = (await get(`/events?workstreamId=${w.id}&type=workstream.status&limit=50`)) as Ev[];
      expect(evs.every((e) => e.actor.type === 'system')).toBe(true);
      const path = evs.map((e) => e.data.to).reverse();
      expect(path).toEqual(['planned', 'working', 'in_review', 'ready_to_land', 'blocked', 'ready_to_land', 'needs_input', 'ready_to_land', 'working', 'shipped']);

      // override wins but derivedStatus follows reality
      await c.patch(`${base()}/workstreams/${w.key}`, { statusOverride: 'canceled' }).expect(200);
      expect(await ws(w.key)).toMatchObject({ status: 'canceled', derivedStatus: 'shipped', statusSource: 'override' });
    });

    it('re-derives dependents when the blocker ships', async () => {
      const blocker = await mk('Collector rollout', {}, infra);
      const waiting = await mk('Use collector');
      await c.post(`${base()}/workstreams/${blocker.key}/criteria`, { text: 'Collector runs in production', state: 'met' }).expect(201);
      await c.post(`${base()}/dependencies`, { fromType: 'workstream', fromId: blocker.id, toType: 'workstream', toId: waiting.id }).expect(201);
      expect((await ws(waiting.key)).status).toBe('blocked');
      await c.post(`${base()}/artifacts`, { workstreamId: blocker.id, kind: 'deployment', title: 'prod', state: 'healthy', environment: 'production' }).expect(201);
      expect((await ws(blocker.key)).status).toBe('shipped');
      expect((await ws(waiting.key)).status).toBe('draft');
    });

  });

  describe('attention', () => {
    let item: { id: string; state: string; since: string };
    let w: { id: string; key: string };

    beforeAll(async () => {
      w = await mk('Needs a human');
      await agent.post(`${base()}/input-requests`, { workstreamId: w.id, question: 'Use refresh rotation?' }).expect(201);
    });

    it('derives items for the accountable user, sorted by severity', async () => {
      const items = (await get('/attention')) as { id: string; kind: string; severity: string; workstreamId?: string; state: string; since: string }[];
      item = items.find((i) => i.kind === 'input_requested' && i.workstreamId === w.id)!;
      expect(item).toMatchObject({ severity: 'high', state: 'open' });
      expect(item.id).toMatch(/^input_requested:ir_/);
      const rank = { high: 0, medium: 1, low: 2 } as const;
      const order = items.map((i) => rank[i.severity as keyof typeof rank]);
      expect(order).toEqual(order.toSorted((a, b) => a - b));
      // also present in the snapshot
      expect(((await get('/snapshot')).attention as { id: string }[]).some((i) => i.id === item.id)).toBe(true);
    });

    it('dismiss, snooze and restore are per user', async () => {
      const enc = encodeURIComponent(item.id);
      const dismissed = (await c.post(`${base()}/attention/${enc}/dismiss`).expect(200)).body;
      expect(dismissed.state).toBe('dismissed');
      expect(((await get('/attention')) as { id: string; state: string }[]).find((i) => i.id === item.id)!.state).toBe('dismissed');
      expect(((await get('/attention?state=active')) as { id: string }[]).some((i) => i.id === item.id)).toBe(false);

      await c.post(`${base()}/attention/${enc}/snooze`, { until: new Date(Date.now() - 1000).toISOString() }).expect(400);
      const until = new Date(Date.now() + 3600_000).toISOString();
      const snoozed = (await c.post(`${base()}/attention/${enc}/snooze`, { until }).expect(200)).body;
      expect(snoozed).toMatchObject({ state: 'snoozed', snoozedUntil: until });

      const restored = (await c.post(`${base()}/attention/${enc}/restore`).expect(200)).body;
      expect(restored.state).toBe('open');
      await c.post(`${base()}/attention/nope:1/dismiss`).expect(404);
    });

    it('a dismissed item reappears when its `since` changes', async () => {
      const enc = encodeURIComponent(item.id);
      await c.post(`${base()}/attention/${enc}/dismiss`).expect(200);
      // change the underlying condition's `since`: a fresh request replaces the old one
      const reqs = (await get(`/input-requests?workstreamId=${w.id}&state=open`)) as { id: string }[];
      await c.post(`${base()}/input-requests/${reqs[0].id}/dismiss`).expect(200);
      await agent.post(`${base()}/input-requests`, { workstreamId: w.id, question: 'Use refresh rotation, take two?' }).expect(201);
      const items = (await get('/attention')) as { kind: string; workstreamId?: string; state: string }[];
      expect(items.filter((i) => i.kind === 'input_requested' && i.workstreamId === w.id)).toMatchObject([{ state: 'open' }]);
    });

    it('scope=all needs admin; agents get 403; non-assigned members do not see it', async () => {
      expect(Array.isArray(await get('/attention?scope=all'))).toBe(true);
      await member.get(`${base()}/attention?scope=all`).expect(403);
      await agent.get(`${base()}/attention`).expect(403);
      const mine = (await member.get(`${base()}/attention`).expect(200)).body as { workstreamId?: string }[];
      expect(mine.some((i) => i.workstreamId === w.id)).toBe(false);
    });
  });

  describe('graph, search, context', () => {
    let w: { id: string; key: string };

    beforeAll(async () => {
      const repo = (await c.post(`${base()}/repositories`, { provider: 'github', fullName: 'acme/auth-service' }).expect(201)).body;
      w = await mk('Graph subject', { objective: 'Users stay signed in when tokens rotate.', context: 'Sessions drop at 15 minutes.', repositoryIds: [repo.id], acceptanceCriteria: [{ text: 'Sessions survive rotation', state: 'met' }, { text: 'Replay is rejected', state: 'in_progress' }, { text: 'Metrics exposed' }] });
      await c.post(`${base()}/artifacts`, { workstreamId: w.id, repositoryId: repo.id, kind: 'pull_request', title: 'Rotate refresh tokens', externalId: '#182', review: 'requested' }).expect(201);
      const dec = (await c.post(`${base()}/decisions`, { title: 'Rotating refresh tokens', statement: 'Use rotating refresh tokens', rationale: 'Limits replay window', status: 'accepted', originWorkstreamId: w.id }).expect(201)).body;
      const old = (await c.post(`${base()}/decisions`, { title: 'Static tokens', statement: 'Static tokens', status: 'accepted', relatedWorkstreamIds: [w.id] }).expect(201)).body;
      await c.post(`${base()}/decisions/${old.key}/supersede`, { byId: dec.key }).expect(200);
      await c.post(`${base()}/comments`, { subject: { type: 'workstream', id: w.id }, body: 'Rotation service skeleton done' }).expect(201);
      await c.post(`${base()}/issues`, { kind: 'bug', title: 'Users logged out every 15m', teamId: auth.id }).then(async (r) =>
        c.post(`${base()}/issues/${r.body.key}/link`, { workstreamIds: [w.id] }).expect(200),
      );
    });

    it('graph: workspace, filtered and per workstream', async () => {
      const g = await get(`/workstreams/${w.key}/graph`);
      const types = new Set(g.nodes.map((n: { type: string }) => n.type));
      for (const t of ['workstream', 'artifact', 'team', 'repository']) expect(types).toContain(t);
      const kinds = new Set(g.edges.map((e: { kind: string }) => e.kind));
      for (const k of ['contains', 'targets']) expect(kinds).toContain(k);
      const ids = new Set(g.nodes.map((n: { id: string }) => n.id));
      for (const e of g.edges) {
        expect(ids.has(e.source)).toBe(true);
        expect(ids.has(e.target)).toBe(true);
      }
      expect(g.nodes.find((n: { id: string }) => n.id === w.id)).toMatchObject({ type: 'workstream', status: 'in_review', data: { key: w.key } });

      const slim = await get(`/graph?workstreamId=${w.id}&includeArtifacts=false&includeActors=false&includeRepositories=false`);
      expect(new Set(slim.nodes.map((n: { type: string }) => n.type))).toEqual(new Set(['workstream']));

      const all = await get('/graph');
      expect(all.nodes.length).toBeGreaterThan(g.nodes.length);
      const dep = all.edges.find((e: { kind: string }) => e.kind === 'depends_on');
      expect(dep).toBeTruthy();
      const teamOnly = await get(`/graph?teamId=${infra.id}`);
      expect(teamOnly.nodes.some((n: { data: { external?: boolean } }) => n.data.external)).toBe(true);
      await c.get(`${base()}/graph?workstreamId=wk_missing`).expect(404);
    });

    it('search ranks exact keys first and spans entity types', async () => {
      const byKey = (await get(`/search?q=${w.key.toLowerCase()}`)).results;
      expect(byKey[0]).toMatchObject({ type: 'workstream', id: w.id, key: w.key });
      expect(byKey[0].score).toBe(100);

      const r = (await get('/search?q=rotat')).results as { type: string; score: number; workstreamKey?: string }[];
      const found = new Set(r.map((x) => x.type));
      for (const t of ['workstream', 'decision', 'artifact']) expect(found).toContain(t);
      const scores = r.map((x) => x.score);
      expect(scores).toEqual(scores.toSorted((a, b) => b - a));
      expect(r.find((x) => x.type === 'artifact')!.workstreamKey).toBe(w.key);

      expect((await get('/search?q=%23182')).results[0]).toMatchObject({ type: 'artifact', key: '#182' });
      expect((await get('/search?q=auth-service&types=repository')).results.map((x: { type: string }) => x.type)).toEqual(['repository']);
      expect((await get('/search?q=logged&types=issue')).results[0]).toMatchObject({ type: 'issue', key: expect.stringMatching(/^BUG-/) });
      expect((await get('/search?q=identity&types=team')).results[0]).toMatchObject({ type: 'team', key: 'AUTH' });
      expect((await get('/search?q=%25_')).results).toEqual([]);
      expect((await get('/search?q=rotat&limit=2')).results).toHaveLength(2);
      await c.get(`${base()}/search?q=x&types=bogus`).expect(400);
      expect((await agent.get(`${base()}/search?q=rotat`).expect(200)).body.results.length).toBeGreaterThan(0);
    });

    it('agent context: markdown by default, JSON on request, readable by agent tokens', async () => {
      const res = await agent.get(`${base()}/workstreams/${w.key}/context`).expect(200);
      expect(res.headers['content-type']).toContain('text/markdown');
      const md = res.text;
      expect(md).toContain(`# ${w.key} — Graph subject`);
      expect(md).toContain('## Objective');
      expect(md).toContain('Users stay signed in when tokens rotate.');
      expect(md).toContain('- [x] Sessions survive rotation');
      expect(md).toContain('- [ ] Replay is rejected _(in progress)_');
      expect(md).toContain('- [ ] Metrics exposed');
      expect(md).toContain('## Context');
      expect(md).toContain('acme/auth-service');
      expect(md).toContain('default branch: main');
      expect(md).toContain('Owner: Identity (AUTH)');
      expect(md).toContain('Use rotating refresh tokens');
      expect(md).toContain('because Limits replay window');
      expect(md).toMatch(/Static tokens — superseded by ADR-\d+/);
      expect(md).toContain('## Related issues');
      expect(md).toContain('#182');
      expect(md).toContain('review requested');
      expect(md).toContain('Rotation service skeleton done');

      const json = (await agent.get(`${base()}/workstreams/${w.key}/context`).set('Accept', 'application/json').expect(200)).body;
      expect(json).toMatchObject({ key: w.key, status: 'in_review' });
      expect(json.acceptanceCriteria).toHaveLength(3);
      expect(json.repositories[0].fullName).toBe('acme/auth-service');
      expect(json.decisions.map((d: { status: string }) => d.status).sort()).toEqual(['accepted', 'superseded']);
      expect(json.recentProgress[0].text).toContain('skeleton');
      expect((await c.get(`${base()}/workstreams/${w.key}/context?format=json`).expect(200)).body.key).toBe(w.key);
      await c.get(`${base()}/workstreams/NOPE-1/context`).expect(404);
    });
  });
});
