import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';
import {
  HttpClient,
  type HttpRequest,
  type HttpResponse,
} from '../src/integrations/http-client.js';

/** Stands in for LunaGest. Never opens a socket; records every request so writes can be ruled out. */
class FakeLunaGest extends HttpClient {
  readonly calls: HttpRequest[] = [];
  projects = [
    { id: 'lp_a', name: 'Alpha', description: 'The first one' },
    { id: 'lp_b', name: 'Beta', description: null },
    { id: 'lp_c', name: 'Gamma', description: 'Tasks fail' },
  ];
  tasks: Record<string, { id: string; title: string; description?: string }[]> = {
    lp_a: [
      { id: 'lt_1', title: 'Fix login', description: 'Remote text' },
      { id: 'lt_2', title: 'Add invoices', description: 'Monthly' },
    ],
    lp_b: [{ id: 'lt_3', title: 'Plan launch' }],
    lp_c: [],
  };

  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const url = new URL(req.url);
    const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, json });
    if (url.pathname === '/auth/v1/token') return ok({ access_token: 'tok_test' });
    if (url.pathname === '/functions/v1/pm' && req.method === 'GET') {
      const resource = url.searchParams.get('resource');
      if (resource === 'projects') return ok(this.projects);
      if (resource === 'tasks') {
        const projectId = url.searchParams.get('project_id') ?? '';
        if (projectId === 'lp_c') return { status: 500, headers: {}, json: null };
        return ok(this.tasks[projectId] ?? []);
      }
    }
    return { status: 404, headers: {}, json: null };
  }

  get writes() {
    return this.calls.filter(
      (c) => (c.method ?? 'GET') !== 'GET' && !c.url.includes('/auth/v1/token'),
    );
  }
}

describe('LunaGest import', () => {
  let app: INestApplication;
  let c: Client;
  let member: Client;
  let w: string;
  const luna = new FakeLunaGest();

  beforeAll(async () => {
    app = await createTestApp((b) => b.overrideProvider(HttpClient).useValue(luna));
    c = (await Client.signup(app.getHttpServer(), 'Luna Import Owner')).client;
    const workspace = (await c.post('/api/workspaces', { name: 'Luna Import Workspace' }).expect(201)).body;
    w = `/api/w/${workspace.slug}`;
    member = (await Client.signup(app.getHttpServer(), 'Luna Import Viewer')).client;
  });

  afterAll(() => app.close());

  it('needs a saved connection first', async () => {
    await c.get(`${w}/lunagest/import/projects`).expect(400);
    await c.post(`${w}/lunagest/import`, { remoteProjectIds: ['lp_a'] }).expect(400);
    await c.put(`${w}/lunagest/connection`, { username: 'ada@example.com', password: 'pw-not-returned' }).expect(200);
  });

  it('lists remote projects with their task counts', async () => {
    const res = (await c.get(`${w}/lunagest/import/projects`).expect(200)).body;
    expect(JSON.stringify(res)).not.toContain('pw-not-returned');
    expect(res.projects).toEqual([
      expect.objectContaining({ id: 'lp_a', name: 'Alpha', taskCount: 2, imported: false, projectId: null, linkedTaskCount: 0 }),
      expect.objectContaining({ id: 'lp_b', name: 'Beta', taskCount: 1, imported: false }),
      expect.objectContaining({ id: 'lp_c', name: 'Gamma', taskCount: null, imported: false }),
    ]);
  });

  it('imports projects and tasks, links instead of duplicating, and is idempotent', async () => {
    // A same-named unbound project with a same-titled task: both are linked, not duplicated.
    const alpha = (await c.post(`${w}/projects`, { name: 'Alpha' }).expect(201)).body;
    const fix = (await c.post(`${w}/tasks`, { kind: 'bug', title: 'Fix login', projectId: alpha.id }).expect(201)).body;
    await c.post(`${w}/tasks`, { kind: 'bug', title: 'Unrelated local task', projectId: alpha.id }).expect(201);
    luna.calls.length = 0;

    await c.post(`${w}/lunagest/import`, { remoteProjectIds: [] }).expect(400);
    await c.post(`${w}/lunagest/import`, { remoteProjectIds: ['lp_nope'] }).expect(400);
    await c.post(`${w}/lunagest/import`, { remoteProjectIds: [''] }).expect(400);

    const first = (await c.post(`${w}/lunagest/import`, { remoteProjectIds: ['lp_a', 'lp_b', 'lp_c'] }).expect(201)).body;
    const [a, b, g] = first.projects;
    expect(a).toMatchObject({ remoteProjectId: 'lp_a', project: 'linked', projectId: alpha.id, tasks: { created: 1, linked: 1, existing: 0 } });
    expect(b).toMatchObject({ remoteProjectId: 'lp_b', project: 'created', tasks: { created: 1, linked: 0, existing: 0 } });
    expect(b.projectKey).toMatch(/^[A-Z][A-Z0-9]{0,3}$/);
    // One project failing does not stop the others.
    expect(g).toMatchObject({ remoteProjectId: 'lp_c', project: 'failed', error: expect.any(String) });

    const alphaTasks = (await c.get(`${w}/tasks?projectId=${alpha.id}`).expect(200)).body as { id: string; title: string; body?: string }[];
    expect(alphaTasks.map((t) => t.title).sort()).toEqual(['Add invoices', 'Fix login', 'Unrelated local task']);
    expect(alphaTasks.find((t) => t.id === fix.id)?.body).toBeUndefined();
    const added = alphaTasks.find((t) => t.title === 'Add invoices');
    expect(added?.body).toBe('Monthly');

    const betaProject = (await c.get(`${w}/projects/${b.projectId}`).expect(200)).body;
    expect(betaProject.name).toBe('Beta');
    expect((await c.get(`${w}/projects/${b.projectId}/lunagest`).expect(200)).body).toMatchObject({
      state: 'linked',
      remoteProjectId: 'lp_b',
    });
    expect((await c.get(`${w}/tasks/${added!.id}/lunagest`).expect(200)).body).toMatchObject({
      applicable: true,
      state: 'linked',
      remoteTaskId: 'lt_2',
    });
    expect((await c.get(`${w}/tasks/${fix.id}/lunagest`).expect(200)).body).toMatchObject({ remoteTaskId: 'lt_1' });

    // Importing again creates nothing.
    const again = (await c.post(`${w}/lunagest/import`, { remoteProjectIds: ['lp_a', 'lp_b'] }).expect(201)).body;
    expect(again.projects[0]).toMatchObject({ project: 'existing', projectId: alpha.id, tasks: { created: 0, linked: 0, existing: 2 } });
    expect(again.projects[1]).toMatchObject({ project: 'existing', projectId: b.projectId, tasks: { created: 0, linked: 0, existing: 1 } });
    expect(((await c.get(`${w}/tasks?projectId=${alpha.id}`).expect(200)).body as unknown[]).length).toBe(3);
    expect((await c.get(`${w}/projects`).expect(200)).body.filter((p: { name: string }) => p.name === 'Alpha')).toHaveLength(1);

    const listed = (await c.get(`${w}/lunagest/import/projects`).expect(200)).body.projects;
    expect(listed[0]).toMatchObject({ id: 'lp_a', imported: true, projectId: alpha.id, projectName: 'Alpha', linkedTaskCount: 2 });
    expect(listed[1]).toMatchObject({ id: 'lp_b', imported: true, linkedTaskCount: 1 });

    // Import only reads from LunaGest: no task or project was written there.
    expect(luna.writes).toEqual([]);
  });

  it('is limited to people who may manage projects', async () => {
    await member.get(`${w}/lunagest/import/projects`).expect(404);
    await member.post(`${w}/lunagest/import`, { remoteProjectIds: ['lp_a'] }).expect(404);
  });
});
