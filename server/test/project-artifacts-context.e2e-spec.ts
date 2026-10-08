import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

interface ArtifactBody {
  id: string;
  kind: string;
  title: string;
  url?: string;
  workstreamId?: string | null;
  projectId?: string | null;
  issueId?: string | null;
}

/** Owner ids as the API returns them: an unset owner is omitted from the JSON. */
const owners = (a: { projectId?: string | null; workstreamId?: string | null; issueId?: string | null }) => ({
  projectId: a.projectId ?? null,
  workstreamId: a.workstreamId ?? null,
  issueId: a.issueId ?? null,
});

describe('artifacts with several owners, project context and project AI risks', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  /** A workspace (owner, member, viewer, team) with helpers to create projects, workstreams and issues. */
  async function setup() {
    const owner = await Client.signup(server, 'Olivia Owner');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Context Co' }).expect(201)).body;
    const w = `/api/w/${ws.slug}`;
    const join = async (role: 'member' | 'viewer', name: string) => {
      const u = await Client.signup(server, name);
      await owner.client.post(`${w}/members`, { email: u.email, role }).expect(201);
      return u;
    };
    const member = await join('member', 'Max Member');
    const viewer = await join('viewer', 'Vic Viewer');
    const team = (await owner.client.post(`${w}/teams`, { name: 'Core', key: 'CORE', memberIds: [owner.user.id] }).expect(201)).body;
    const c = owner.client;
    const mkProject = async (name: string, extra: object = {}) => (await c.post(`${w}/projects`, { name, ...extra }).expect(201)).body;
    const mkWs = async (title: string, projectId?: string) =>
      (await c.post(`${w}/workstreams`, { title, ownerTeamId: team.id, deltaThreadUrl: 'https://delta.dev/t/e2e', projectId }).expect(201)).body;
    const mkIssue = async (title: string, extra: object = {}) => (await c.post(`${w}/issues`, { kind: 'bug', title, ...extra }).expect(201)).body;
    const mkArtifact = async (body: object) => (await c.post(`${w}/artifacts`, body).expect(201)).body as ArtifactBody;
    const token = async (body: object) => {
      const res = (await c.post(`${w}/tokens`, { name: 'k', ...body }).expect(201)).body;
      return new TokenClient(server, res.secret);
    };
    return { owner, c, member, viewer, team, ws, w, mkProject, mkWs, mkIssue, mkArtifact, token };
  }

  // ───────────────────────────── artifacts ─────────────────────────────

  describe('artifact owners', () => {
    it('needs at least one owner; accepts any combination of workstream, project and issue', async () => {
      const { c, w, mkProject, mkWs, mkIssue } = await setup();
      const project = await mkProject('P');
      const stream = await mkWs('W', project.id);
      const issue = await mkIssue('I');

      await c.post(`${w}/artifacts`, { kind: 'document', title: 'Orphan' }).expect(400);
      await c.post(`${w}/artifacts`, { kind: 'document', title: 'Orphan', workstreamId: null }).expect(400);

      const onProject = (await c.post(`${w}/artifacts`, { kind: 'document', title: 'Spec', projectId: project.id }).expect(201)).body as ArtifactBody;
      expect(owners(onProject)).toEqual({ projectId: project.id, workstreamId: null, issueId: null });
      const onIssue = (await c.post(`${w}/artifacts`, { kind: 'document', title: 'Notes', issueId: issue.id }).expect(201)).body as ArtifactBody;
      expect(owners(onIssue)).toEqual({ projectId: null, workstreamId: null, issueId: issue.id });
      const all = (
        await c.post(`${w}/artifacts`, { kind: 'pull_request', title: 'Big PR', projectId: project.id, workstreamId: stream.id, issueId: issue.id }).expect(201)
      ).body as ArtifactBody;
      expect(owners(all)).toEqual({ projectId: project.id, workstreamId: stream.id, issueId: issue.id });

      // it shows up under every owner
      const ids = async (url: string) => ((await c.get(url).expect(200)).body as ArtifactBody[]).map((a) => a.id);
      expect(await ids(`${w}/projects/${project.id}/artifacts`)).toEqual(expect.arrayContaining([onProject.id, all.id]));
      expect(await ids(`${w}/workstreams/${stream.key}/artifacts`)).toEqual([all.id]);
      expect(await ids(`${w}/issues/${issue.key}/artifacts`)).toEqual(expect.arrayContaining([onIssue.id, all.id]));
      expect(await ids(`${w}/artifacts?issueId=${issue.id}`)).toHaveLength(2);
    });

    it('nested routes fill their own owner, resolve keys/aliases and let the route win over the body', async () => {
      const { c, w, mkProject, mkWs, mkIssue } = await setup();
      const project = await mkProject('P');
      const other = await mkProject('Other');
      const stream = await mkWs('W');
      const issue = await mkIssue('I');

      const a = (await c.post(`${w}/projects/${project.id}/artifacts`, { kind: 'document', title: 'A', projectId: other.id }).expect(201)).body as ArtifactBody;
      expect(a.projectId).toBe(project.id);
      const b = (await c.post(`${w}/workstreams/${stream.key.toLowerCase()}/artifacts`, { kind: 'document', title: 'B' }).expect(201)).body as ArtifactBody;
      expect(b.workstreamId).toBe(stream.id);
      const cc = (await c.post(`${w}/issues/${issue.key}/artifacts`, { kind: 'document', title: 'C' }).expect(201)).body as ArtifactBody;
      expect(cc.issueId).toBe(issue.id);
      const d = (await c.post(`${w}/issues/${issue.id}/artifacts`, { kind: 'document', title: 'D', projectId: project.id }).expect(201)).body as ArtifactBody;
      expect(d).toMatchObject({ issueId: issue.id, projectId: project.id });

      expect(((await c.get(`${w}/projects/${project.id}/artifacts?kind=document`).expect(200)).body as ArtifactBody[]).map((x) => x.id).sort()).toEqual([a.id, d.id].sort());
      await c.get(`${w}/projects/${project.id}/artifacts?kind=nope`).expect(400);
      await c.get(`${w}/projects/pj_missing/artifacts`).expect(404);
      await c.get(`${w}/workstreams/CORE-999/artifacts`).expect(404);
      await c.get(`${w}/issues/BUG-999/artifacts`).expect(404);
      await c.post(`${w}/projects/pj_missing/artifacts`, { kind: 'document', title: 'x' }).expect(404);
      await c.post(`${w}/issues/BUG-999/artifacts`, { kind: 'document', title: 'x' }).expect(404);
    });

    it('rejects unknown owner ids', async () => {
      const { c, w, mkProject } = await setup();
      const project = await mkProject('P');
      await c.post(`${w}/artifacts`, { kind: 'document', title: 'x', projectId: 'pj_missing' }).expect(400);
      await c.post(`${w}/artifacts`, { kind: 'document', title: 'x', issueId: 'iss_missing' }).expect(400);
      await c.post(`${w}/artifacts`, { kind: 'document', title: 'x', projectId: project.id, workstreamId: 'wk_missing' }).expect(400);
    });

    it('PATCH attaches and detaches owners, but never the last one', async () => {
      const { c, w, mkProject, mkWs, mkIssue, mkArtifact } = await setup();
      const project = await mkProject('P');
      const stream = await mkWs('W');
      const issue = await mkIssue('I');
      const a = await mkArtifact({ kind: 'document', title: 'Spec', projectId: project.id });

      const two = (await c.patch(`${w}/artifacts/${a.id}`, { workstreamId: stream.id }).expect(200)).body as ArtifactBody;
      expect(owners(two)).toEqual({ projectId: project.id, workstreamId: stream.id, issueId: null });
      const three = (await c.patch(`${w}/artifacts/${a.id}`, { issueId: issue.id }).expect(200)).body as ArtifactBody;
      expect(three.issueId).toBe(issue.id);

      const detached = (await c.patch(`${w}/artifacts/${a.id}`, { projectId: null, workstreamId: null }).expect(200)).body as ArtifactBody;
      expect(owners(detached)).toEqual({ projectId: null, workstreamId: null, issueId: issue.id });
      // the last owner stays
      const refused = await c.patch(`${w}/artifacts/${a.id}`, { issueId: null }).expect(400);
      expect(refused.body.message).toMatch(/at least one owner/);
      expect((await c.get(`${w}/artifacts/${a.id}`).expect(200)).body.issueId).toBe(issue.id);

      // moving: attach a new owner and detach the old one in one patch
      const moved = (await c.patch(`${w}/artifacts/${a.id}`, { issueId: null, projectId: project.id }).expect(200)).body as ArtifactBody;
      expect(owners(moved)).toEqual({ projectId: project.id, workstreamId: null, issueId: null });
      await c.patch(`${w}/artifacts/${a.id}`, { projectId: 'pj_missing' }).expect(400);
    });

    it('deleting the last owner removes the artifact; another owner keeps it alive', async () => {
      const { c, w, mkProject, mkWs, mkIssue, mkArtifact } = await setup();
      const project = await mkProject('P');
      const stream = await mkWs('W', project.id);
      const issue = await mkIssue('I');
      const shared = await mkArtifact({ kind: 'document', title: 'Shared', workstreamId: stream.id, issueId: issue.id });
      const solo = await mkArtifact({ kind: 'document', title: 'Solo', issueId: issue.id });
      const viaProject = await mkArtifact({ kind: 'document', title: 'Via project', projectId: project.id, issueId: issue.id });

      await c.delete(`${w}/workstreams/${stream.key}`).expect(204);
      const afterWs = (await c.get(`${w}/artifacts/${shared.id}`).expect(200)).body as ArtifactBody;
      expect(owners(afterWs)).toEqual({ projectId: null, workstreamId: null, issueId: issue.id });

      await c.delete(`${w}/issues/${issue.key}`).expect(204);
      await c.get(`${w}/artifacts/${shared.id}`).expect(404);
      await c.get(`${w}/artifacts/${solo.id}`).expect(404);
      // still owned by the project
      expect(owners((await c.get(`${w}/artifacts/${viaProject.id}`).expect(200)).body as ArtifactBody)).toEqual({ projectId: project.id, workstreamId: null, issueId: null });

      await c.delete(`${w}/projects/${project.id}`).expect(204);
      await c.get(`${w}/artifacts/${viaProject.id}`).expect(404);
    });

    it('deleting the artifact itself works and 404s afterwards', async () => {
      const { c, w, mkProject, mkArtifact } = await setup();
      const p = await mkProject('P');
      const a = await mkArtifact({ kind: 'document', title: 'Tmp', projectId: p.id });
      await c.delete(`${w}/artifacts/${a.id}`).expect(204);
      await c.get(`${w}/artifacts/${a.id}`).expect(404);
      await c.delete(`${w}/artifacts/${a.id}`).expect(404);
    });
  });

  describe('artifact url validation', () => {
    it('a link needs an http(s) url; javascript:, data:, ftp: and garbage are refused everywhere', async () => {
      const { c, w, mkProject, mkArtifact } = await setup();
      const p = await mkProject('P');
      const base = { projectId: p.id };
      await c.post(`${w}/artifacts`, { ...base, kind: 'link', title: 'No url' }).expect(400);
      for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'ftp://example.com/x', 'file:///etc/passwd', 'not a url', '//example.com'])
        await c.post(`${w}/artifacts`, { ...base, kind: 'link', title: 'Bad', url }).expect(400);
      // other kinds may omit the url, but never carry an unsafe one
      await c.post(`${w}/artifacts`, { ...base, kind: 'document', title: 'Doc', url: 'javascript:alert(1)' }).expect(400);
      await c.post(`${w}/projects/${p.id}/artifacts`, { kind: 'design', title: 'Fig', url: 'javascript:alert(1)' }).expect(400);

      const ok = await mkArtifact({ ...base, kind: 'link', title: 'Docs', url: 'https://example.com/docs' });
      expect(ok.url).toBe('https://example.com/docs');
      await mkArtifact({ ...base, kind: 'link', title: 'Local', url: 'http://localhost:3000/x' });
      await mkArtifact({ ...base, kind: 'document', title: 'No url' });

      // PATCH cannot sneak a bad url in, nor clear a link's url
      await c.patch(`${w}/artifacts/${ok.id}`, { url: 'javascript:alert(1)' }).expect(400);
      await c.patch(`${w}/artifacts/${ok.id}`, { url: null }).expect(400);
      expect((await c.get(`${w}/artifacts/${ok.id}`).expect(200)).body.url).toBe('https://example.com/docs');
      await c.patch(`${w}/artifacts/${ok.id}`, { url: 'https://example.com/new' }).expect(200);
    });

    it('rejects an unknown kind or an empty title', async () => {
      const { c, w, mkProject } = await setup();
      const p = await mkProject('P');
      await c.post(`${w}/artifacts`, { projectId: p.id, kind: 'spaceship', title: 'x' }).expect(400);
      await c.post(`${w}/artifacts`, { projectId: p.id, kind: 'document', title: '' }).expect(400);
      await c.post(`${w}/artifacts`, { projectId: p.id, kind: 'document' }).expect(400);
    });
  });

  describe('artifact authorization and isolation', () => {
    it('a viewer cannot create, edit or delete; a read token cannot write', async () => {
      const { c, w, viewer, member, mkProject, mkArtifact, token } = await setup();
      const p = await mkProject('P');
      const a = await mkArtifact({ kind: 'document', title: 'Spec', projectId: p.id });
      await viewer.client.post(`${w}/artifacts`, { kind: 'document', title: 'x', projectId: p.id }).expect(403);
      await viewer.client.post(`${w}/projects/${p.id}/artifacts`, { kind: 'document', title: 'x' }).expect(403);
      await viewer.client.patch(`${w}/artifacts/${a.id}`, { title: 'y' }).expect(403);
      await viewer.client.delete(`${w}/artifacts/${a.id}`).expect(403);
      await viewer.client.get(`${w}/projects/${p.id}/artifacts`).expect(200);
      await member.client.post(`${w}/projects/${p.id}/artifacts`, { kind: 'document', title: 'by member' }).expect(201);

      const reader = await token({ scope: 'read' });
      await reader.get(`${w}/projects/${p.id}/artifacts`).expect(200);
      await reader.get(`${w}/projects/${p.id}/context`).expect(200);
      await reader.post(`${w}/projects/${p.id}/artifacts`, { kind: 'document', title: 'x' }).expect(403);
      await reader.post(`${w}/artifacts`, { kind: 'document', title: 'x', projectId: p.id }).expect(403);
      await reader.patch(`${w}/artifacts/${a.id}`, { title: 'y' }).expect(403);
      await reader.delete(`${w}/artifacts/${a.id}`).expect(403);
      expect((await c.get(`${w}/artifacts/${a.id}`).expect(200)).body.title).toBe('Spec');
      // a write token can
      const writer = await token({ scope: 'write' });
      await writer.post(`${w}/projects/${p.id}/artifacts`, { kind: 'link', title: 'L', url: 'https://example.com' }).expect(201);
    });

    it('another workspace gets 404 on artifacts and cannot attach to foreign owners', async () => {
      const a = await setup();
      const b = await setup();
      const pa = await a.mkProject('A project');
      const wsa = await a.mkWs('A stream');
      const ia = await a.mkIssue('A issue');
      const art = await a.mkArtifact({ kind: 'document', title: 'Secret', projectId: pa.id });

      // A's slug is closed to B's owner
      await b.c.get(`${a.w}/artifacts/${art.id}`).expect(404);
      await b.c.get(`${a.w}/projects/${pa.id}/artifacts`).expect(404);
      await b.c.post(`${a.w}/projects/${pa.id}/artifacts`, { kind: 'document', title: 'x' }).expect(404);
      // A's ids through B's slug
      await b.c.get(`${b.w}/artifacts/${art.id}`).expect(404);
      await b.c.patch(`${b.w}/artifacts/${art.id}`, { title: 'leak' }).expect(404);
      await b.c.delete(`${b.w}/artifacts/${art.id}`).expect(404);
      await b.c.get(`${b.w}/projects/${pa.id}/artifacts`).expect(404);
      await b.c.post(`${b.w}/projects/${pa.id}/artifacts`, { kind: 'document', title: 'x' }).expect(404);
      await b.c.get(`${b.w}/workstreams/${wsa.id}/artifacts`).expect(404);
      await b.c.get(`${b.w}/issues/${ia.id}/artifacts`).expect(404);
      await b.c.get(`${b.w}/issues/${ia.key}/artifacts`).expect(404);
      // foreign owners cannot be referenced from a body
      await b.c.post(`${b.w}/artifacts`, { kind: 'document', title: 'x', projectId: pa.id }).expect(400);
      await b.c.post(`${b.w}/artifacts`, { kind: 'document', title: 'x', workstreamId: wsa.id }).expect(400);
      await b.c.post(`${b.w}/artifacts`, { kind: 'document', title: 'x', issueId: ia.id }).expect(400);
      const pb = await b.mkProject('B project');
      const own = await b.mkArtifact({ kind: 'document', title: 'Mine', projectId: pb.id });
      await b.c.patch(`${b.w}/artifacts/${own.id}`, { projectId: pa.id }).expect(400);
      await b.c.patch(`${b.w}/artifacts/${own.id}`, { issueId: ia.id }).expect(400);
      // the filters do not leak either
      expect((await b.c.get(`${b.w}/artifacts?projectId=${pa.id}`).expect(200)).body).toEqual([]);

      expect((await a.c.get(`${a.w}/artifacts/${art.id}`).expect(200)).body.title).toBe('Secret');
    });
  });

  // ───────────────────────────── project context ─────────────────────────────

  describe('GET /projects/:id/context', () => {
    async function tree() {
      const s = await setup();
      const { c, w, mkProject, mkWs, mkIssue, mkArtifact } = s;
      const P = await mkProject('Mega');
      const other = await mkProject('Other');
      const W1 = await mkWs('Project stream', P.id);
      const W2 = await mkWs('Other stream', other.id);
      const loose = await mkWs('Loose stream');
      const direct = await mkIssue('Direct issue', { projectId: P.id });
      const viaWs = await mkIssue('Via workstream');
      await c.post(`${w}/issues/${viaWs.key}/link`, { workstreamIds: [W1.id] }).expect(200);
      const unrelated = await mkIssue('Unrelated');
      await c.post(`${w}/issues/${unrelated.key}/link`, { workstreamIds: [W2.id] }).expect(200);
      const both = await mkIssue('Both', { projectId: P.id });
      await c.post(`${w}/issues/${both.key}/link`, { workstreamIds: [W1.id] }).expect(200);

      const aProject = await mkArtifact({ kind: 'document', title: 'On project', projectId: P.id });
      const aWs = await mkArtifact({ kind: 'document', title: 'On workstream', workstreamId: W1.id });
      const aViaWsIssue = await mkArtifact({ kind: 'pull_request', title: 'On linked issue', issueId: viaWs.id });
      const aDirectIssue = await mkArtifact({ kind: 'document', title: 'On direct issue', issueId: direct.id });
      const aMulti = await mkArtifact({ kind: 'document', title: 'Many owners', projectId: P.id, workstreamId: W1.id, issueId: viaWs.id });
      const aWsAndIssue = await mkArtifact({ kind: 'document', title: 'Ws and issue', workstreamId: W1.id, issueId: viaWs.id });
      const aOther = await mkArtifact({ kind: 'document', title: 'Other project', workstreamId: W2.id });
      const aUnrelated = await mkArtifact({ kind: 'document', title: 'Unrelated issue', issueId: unrelated.id });
      const aLoose = await mkArtifact({ kind: 'document', title: 'Loose', workstreamId: loose.id });
      return { ...s, P, other, W1, W2, direct, viaWs, unrelated, both, aProject, aWs, aViaWsIssue, aDirectIssue, aMulti, aWsAndIssue, aOther, aUnrelated, aLoose };
    }

    type Ref = { type: string; id: string };
    type Ctx = {
      project: { id: string };
      workstreams: { id: string }[];
      issues: { id: string }[];
      artifacts: { artifact: ArtifactBody; path: Ref[] }[];
      updates: { id: string }[];
    };

    it('returns workstreams, issues and artifacts reachable from the project, each artifact once with its path', async () => {
      const t = await tree();
      const ctx = (await t.c.get(`${t.w}/projects/${t.P.id}/context`).expect(200)).body as Ctx;
      expect(ctx.project.id).toBe(t.P.id);
      expect(ctx.workstreams.map((x) => x.id)).toEqual([t.W1.id]);
      // issues with projectId OR in a workstream of the project; no duplicates for "both"
      expect(ctx.issues.map((x) => x.id).sort()).toEqual([t.direct.id, t.viaWs.id, t.both.id].sort());

      const byId = new Map(ctx.artifacts.map((a) => [a.artifact.id, a.path]));
      expect(ctx.artifacts).toHaveLength(byId.size); // deduplicated
      expect([...byId.keys()].sort()).toEqual([t.aProject.id, t.aWs.id, t.aViaWsIssue.id, t.aDirectIssue.id, t.aMulti.id, t.aWsAndIssue.id].sort());
      for (const excluded of [t.aOther.id, t.aUnrelated.id, t.aLoose.id]) expect(byId.has(excluded)).toBe(false);

      const P: Ref = { type: 'project', id: t.P.id };
      expect(byId.get(t.aProject.id)).toEqual([P]);
      expect(byId.get(t.aWs.id)).toEqual([P, { type: 'workstream', id: t.W1.id }]);
      expect(byId.get(t.aViaWsIssue.id)).toEqual([P, { type: 'workstream', id: t.W1.id }, { type: 'issue', id: t.viaWs.id }]);
      expect(byId.get(t.aDirectIssue.id)).toEqual([P, { type: 'issue', id: t.direct.id }]);
      // the highest owner wins: project > workstream > issue
      expect(byId.get(t.aMulti.id)).toEqual([P]);
      expect(byId.get(t.aWsAndIssue.id)).toEqual([P, { type: 'workstream', id: t.W1.id }]);
    });

    it('reflects detaching and deleting owners', async () => {
      const t = await tree();
      const paths = async () =>
        new Map(((await t.c.get(`${t.w}/projects/${t.P.id}/context`).expect(200)).body as Ctx).artifacts.map((a) => [a.artifact.id, a.path.length]));
      expect((await paths()).get(t.aMulti.id)).toBe(1);
      await t.c.patch(`${t.w}/artifacts/${t.aMulti.id}`, { projectId: null }).expect(200);
      expect((await paths()).get(t.aMulti.id)).toBe(2); // now under the workstream
      await t.c.patch(`${t.w}/artifacts/${t.aMulti.id}`, { workstreamId: null }).expect(200);
      expect((await paths()).get(t.aMulti.id)).toBe(3); // now under the linked issue
      await t.c.patch(`${t.w}/artifacts/${t.aMulti.id}`, { issueId: t.unrelated.id }).expect(200);
      expect((await paths()).has(t.aMulti.id)).toBe(false); // left the project's tree
    });

    it('includes updates and a fresh project is an empty tree', async () => {
      const t = await tree();
      await t.c.post(`${t.w}/projects/${t.P.id}/updates`, { health: 'at_risk', body: 'Heads up' }).expect(201);
      const ctx = (await t.c.get(`${t.w}/projects/${t.P.id}/context`).expect(200)).body as Ctx;
      expect(ctx.updates).toHaveLength(1);

      const empty = await t.mkProject('Empty');
      const e = (await t.c.get(`${t.w}/projects/${empty.id}/context`).expect(200)).body as Ctx;
      expect(e.workstreams).toEqual([]);
      expect(e.issues).toEqual([]);
      expect(e.artifacts).toEqual([]);
    });

    it('context.md is markdown with the project, its artifacts grouped by path and no foreign items', async () => {
      const t = await tree();
      await t.c.post(`${t.w}/projects/${t.P.id}/updates`, { health: 'on_track', body: 'Going well' }).expect(201);
      const res = await t.c.get(`${t.w}/projects/${t.P.id}/context.md`).expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/markdown/);
      const md = res.text;
      expect(md).toMatch(/^# Project — Mega/);
      expect(md).toContain('## Artifacts');
      expect(md).toContain('## Recent updates');
      expect(md).toContain('Going well');
      expect(md).toContain('On linked issue');
      expect(md).toContain(`### Mega › ${t.W1.key} › ${t.viaWs.key}`);
      expect(md).toContain(t.direct.key);
      for (const hidden of ['Other project', 'Unrelated issue', 'Loose', t.unrelated.key, t.W2.key]) expect(md).not.toContain(hidden);
      // many owners → listed once
      expect(md.split('Many owners')).toHaveLength(2);
    });

    it('is readable by viewers and read tokens, and isolated per workspace', async () => {
      const t = await tree();
      await t.viewer.client.get(`${t.w}/projects/${t.P.id}/context`).expect(200);
      await t.viewer.client.get(`${t.w}/projects/${t.P.id}/context.md`).expect(200);
      const reader = await t.token({ scope: 'read' });
      await reader.get(`${t.w}/projects/${t.P.id}/context.md`).expect(200);

      await t.c.get(`${t.w}/projects/pj_missing/context`).expect(404);
      await t.c.get(`${t.w}/projects/pj_missing/context.md`).expect(404);
      const b = await setup();
      await b.c.get(`${b.w}/projects/${t.P.id}/context`).expect(404);
      await b.c.get(`${b.w}/projects/${t.P.id}/context.md`).expect(404);
      await b.c.get(`${t.w}/projects/${t.P.id}/context`).expect(404);
    });
  });

  // ───────────────────────────── project AI risks ─────────────────────────────

  describe('POST /projects/:id/ai/risks', () => {
    it('works without AI configured (deterministic fallback) for a session user', async () => {
      const { c, w, mkProject, mkWs } = await setup();
      const p = await mkProject('Risky');
      await mkWs('Stream', p.id);
      const res = (await c.post(`${w}/projects/${p.id}/ai/risks`).expect(200)).body as { kind: string; health: string; risks: unknown[] };
      expect(res.kind).toBe('risks');
      expect(['on_track', 'at_risk', 'off_track']).toContain(res.health);
      expect(Array.isArray(res.risks)).toBe(true);
    });

    it('is a proposal only: it never writes a project update or changes the project', async () => {
      const { c, w, mkProject } = await setup();
      const p = await mkProject('Read only');
      await c.post(`${w}/projects/${p.id}/ai/risks`).expect(200);
      expect((await c.get(`${w}/projects/${p.id}/updates`).expect(200)).body).toEqual([]);
      expect((await c.get(`${w}/projects/${p.id}`).expect(200)).body.health ?? null).toBeNull();
    });

    it('refuses API tokens (even write/admin scope) with 403', async () => {
      const { w, mkProject, token } = await setup();
      const p = await mkProject('P');
      for (const scope of ['read', 'write', 'admin']) {
        const t = await token({ scope });
        await t.post(`${w}/projects/${p.id}/ai/risks`).expect(403);
      }
      const custom = await token({ permissions: ['projects:write'] });
      await custom.post(`${w}/projects/${p.id}/ai/risks`).expect(403);
    });

    it('unknown kind is 400, unknown project is 404', async () => {
      const { c, w, mkProject } = await setup();
      const p = await mkProject('P');
      await c.post(`${w}/projects/${p.id}/ai/nonsense`).expect(400);
      await c.post(`${w}/projects/pj_missing/ai/risks`).expect(404);
    });

    it('needs manageProjects or being the lead; viewers are refused', async () => {
      const { c, w, member, viewer, mkProject } = await setup();
      const p = await mkProject('P', { leadId: member.user.id });
      await viewer.client.post(`${w}/projects/${p.id}/ai/risks`).expect(403);
      await member.client.post(`${w}/projects/${p.id}/ai/risks`).expect(200);

      await c.patch(`${w}/settings`, { permissions: { manageProjects: 'admin' } }).expect(200);
      const notLead = await mkProject('Someone else leads');
      await member.client.post(`${w}/projects/${notLead.id}/ai/risks`).expect(403);
      await member.client.post(`${w}/projects/${p.id}/ai/risks`).expect(200); // the lead keeps access
      await c.post(`${w}/projects/${notLead.id}/ai/risks`).expect(200);
    });

    it('is isolated per workspace', async () => {
      const a = await setup();
      const b = await setup();
      const p = await a.mkProject('A');
      await b.c.post(`${b.w}/projects/${p.id}/ai/risks`).expect(404);
      await b.c.post(`${a.w}/projects/${p.id}/ai/risks`).expect(404);
    });
  });
});
