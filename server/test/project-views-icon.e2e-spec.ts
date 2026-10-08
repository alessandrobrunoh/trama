import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('project icon, project views and the project issue filter', () => {
  let app: INestApplication;
  let c: Client;
  let viewer: Client;
  let w: string;
  let teamId: string;
  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer();
    const owner = await Client.signup(server, 'Olivia Owner');
    c = owner.client;
    const ws = (await c.post('/api/workspaces', { name: 'Views Co' }).expect(201)).body;
    w = `/api/w/${ws.slug}`;
    teamId = (await c.post(`${w}/teams`, { name: 'Core', key: 'CORE', memberIds: [owner.user.id] }).expect(201)).body.id;
    const v = await Client.signup(server, 'Vic Viewer');
    await c.post(`${w}/members`, { email: v.email, role: 'viewer' }).expect(201);
    viewer = v.client;
  });
  afterAll(() => app.close());

  const mkProject = async (name: string, extra: object = {}) => (await c.post(`${w}/projects`, { name, ...extra }).expect(201)).body;
  const mkWs = async (title: string, projectId?: string) =>
    (await c.post(`${w}/workstreams`, { title, ownerTeamId: teamId, deltaThreadUrl: 'https://delta.dev/t/e2e', projectId }).expect(201)).body;
  const mkIssue = async (title: string, extra: object = {}) => (await c.post(`${w}/issues`, { kind: 'bug', title, ...extra }).expect(201)).body;

  describe('project icon', () => {
    it('accepts lucide names and emoji on create and patch, and null clears it', async () => {
      const p = await mkProject('Iconic', { icon: 'rocket' });
      expect(p.icon).toBe('rocket');
      for (const icon of ['bar-chart-3', 'rocket', '🚀', '👩‍💻', '🇮🇹']) {
        expect((await c.patch(`${w}/projects/${p.id}`, { icon }).expect(200)).body.icon).toBe(icon);
      }
      const cleared = (await c.patch(`${w}/projects/${p.id}`, { icon: null }).expect(200)).body;
      expect(cleared.icon ?? null).toBeNull();
      expect((await c.get(`${w}/projects/${p.id}`).expect(200)).body.icon ?? null).toBeNull();
    });

    it('rejects anything else', async () => {
      const p = await mkProject('Strict', { icon: '🎯' });
      const bad = ['Rocket', 'two words', 'rocket-', '-rocket', '1rocket', '<script>', '🚀🚀', '🚀 ', 'javascript:alert(1)', '', 'a'.repeat(49), '../x'];
      for (const icon of bad) await c.patch(`${w}/projects/${p.id}`, { icon }).expect(400);
      for (const icon of ['Rocket', '🚀🚀', '<script>']) await c.post(`${w}/projects`, { name: 'Nope', icon }).expect(400);
      await c.patch(`${w}/projects/${p.id}`, { icon: 42 }).expect(400);
      expect((await c.get(`${w}/projects/${p.id}`).expect(200)).body.icon).toBe('🎯');
    });

    it('needs manageProjects (viewer refused)', async () => {
      const p = await mkProject('Guarded');
      await viewer.patch(`${w}/projects/${p.id}`, { icon: 'rocket' }).expect(403);
    });
  });

  describe('views: project entity and timeline layout', () => {
    it('accepts the project entity and the timeline layout for project and workstream views', async () => {
      const v = (await c.post(`${w}/views`, { name: 'Roadmap', entity: 'project', layout: 'timeline' }).expect(201)).body;
      expect(v).toMatchObject({ entity: 'project', layout: 'timeline' });
      await c.post(`${w}/views`, { name: 'Projects list', entity: 'project' }).expect(201);
      await c.post(`${w}/views`, { name: 'Projects board', entity: 'project', layout: 'board', filters: [{ field: 'status', op: 'is', value: 'started' }] }).expect(201);
      await c.post(`${w}/views`, { name: 'Streams gantt', entity: 'workstream', layout: 'timeline' }).expect(201);
      expect((await c.get(`${w}/views/${v.id}`).expect(200)).body.layout).toBe('timeline');
    });

    it('refuses the timeline layout on issue and decision views (create and patch)', async () => {
      for (const entity of ['issue', 'decision']) {
        const res = await c.post(`${w}/views`, { name: `${entity} gantt`, entity, layout: 'timeline' }).expect(400);
        expect(res.body.message).toMatch(/timeline/);
      }
      const list = (await c.post(`${w}/views`, { name: 'Issues', entity: 'issue' }).expect(201)).body;
      await c.patch(`${w}/views/${list.id}`, { layout: 'timeline' }).expect(400);
      const gantt = (await c.post(`${w}/views`, { name: 'Gantt', entity: 'project', layout: 'timeline' }).expect(201)).body;
      // switching the entity under an existing timeline layout is refused too
      await c.patch(`${w}/views/${gantt.id}`, { entity: 'issue' }).expect(400);
      await c.patch(`${w}/views/${gantt.id}`, { entity: 'decision', layout: 'list' }).expect(200);
      expect((await c.get(`${w}/views/${list.id}`).expect(200)).body.layout).toBe('list');
    });

    it('rejects unknown entities and layouts; viewers cannot share', async () => {
      await c.post(`${w}/views`, { name: 'x', entity: 'milestone' }).expect(400);
      await c.post(`${w}/views`, { name: 'x', entity: 'project', layout: 'calendar' }).expect(400);
      await viewer.post(`${w}/views`, { name: 'x', entity: 'project', shared: true }).expect(403);
    });
  });

  describe('GET /issues?projectId=', () => {
    it('includes issues linked to the project\'s workstreams, once each, and nothing else', async () => {
      const P = await mkProject('Filtered');
      const Q = await mkProject('Other');
      const wp = await mkWs('Project stream', P.id);
      const wq = await mkWs('Other stream', Q.id);
      const direct = await mkIssue('direct', { projectId: P.id });
      const viaWs = await mkIssue('via workstream');
      const both = await mkIssue('both', { projectId: P.id });
      const twoStreams = await mkIssue('two streams');
      const wp2 = await mkWs('Second project stream', P.id);
      const foreign = await mkIssue('foreign');
      const plain = await mkIssue('plain');
      const mixed = await mkIssue('mixed', { projectId: Q.id });

      await c.post(`${w}/issues/${viaWs.key}/link`, { workstreamIds: [wp.id] }).expect(200);
      await c.post(`${w}/issues/${both.key}/link`, { workstreamIds: [wp.id] }).expect(200);
      await c.post(`${w}/issues/${twoStreams.key}/link`, { workstreamIds: [wp.id, wp2.id] }).expect(200);
      await c.post(`${w}/issues/${foreign.key}/link`, { workstreamIds: [wq.id] }).expect(200);
      await c.post(`${w}/issues/${mixed.key}/link`, { workstreamIds: [wq.id] }).expect(200);

      const keys = async (q: string) => ((await c.get(`${w}/issues?${q}`).expect(200)).body as { key: string }[]).map((i) => i.key).sort();
      expect(await keys(`projectId=${P.id}`)).toEqual([direct.key, viaWs.key, both.key, twoStreams.key].sort());
      expect(await keys(`projectId=${Q.id}`)).toEqual([foreign.key, mixed.key].sort());

      // composes with the other filters
      expect(await keys(`projectId=${P.id}&workstreamId=${wp2.id}`)).toEqual([twoStreams.key]);
      await c.patch(`${w}/issues/${viaWs.key}`, { status: 'done' }).expect(200);
      expect(await keys(`projectId=${P.id}&open=true`)).toEqual([direct.key, both.key, twoStreams.key].sort());

      // unlinking takes the issue out; unknown projects match nothing
      await c.patch(`${w}/issues/${twoStreams.key}`, { workstreamIds: [] }).expect(200);
      expect(await keys(`projectId=${P.id}&open=true`)).toEqual([direct.key, both.key].sort());
      expect(await keys('projectId=pj_missing')).toEqual([]);
      expect(await keys('')).toContain(plain.key);
    });

    it('does not leak issues across workspaces', async () => {
      const P = await mkProject('Mine');
      await mkIssue('mine', { projectId: P.id });
      const other = await Client.signup(app.getHttpServer(), 'Other Owner');
      const ws = (await other.client.post('/api/workspaces', { name: 'Elsewhere' }).expect(201)).body;
      await other.client.post(`/api/w/${ws.slug}/issues`, { kind: 'bug', title: 'theirs' }).expect(201);
      expect((await other.client.get(`/api/w/${ws.slug}/issues?projectId=${P.id}`).expect(200)).body).toEqual([]);
      await other.client.get(`${w}/issues?projectId=${P.id}`).expect(404);
    });
  });
});
