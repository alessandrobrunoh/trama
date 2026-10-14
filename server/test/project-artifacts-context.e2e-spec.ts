import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

describe('Issue artifacts and project context', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  async function setup() {
    const owner = await Client.signup(server, 'Context Owner');
    const workspace = (await owner.client.post('/api/workspaces', { name: 'Context Co' }).expect(201)).body;
    const base = `/api/w/${workspace.slug}`;
    const project = (await owner.client.post(`${base}/projects`, { name: 'Auth refresh' }).expect(201)).body;
    const issue = (await owner.client.post(`${base}/issues`, {
      kind: 'bug',
      title: 'Refresh tokens expire early',
      projectId: project.id,
    }).expect(201)).body;
    return { owner, base, project, issue };
  }

  it('attaches artifacts to Issues, lists them by Issue, and prevents orphan artifacts', async () => {
    const { owner, base, issue, project } = await setup();
    const artifact = (await owner.client.post(`${base}/issues/${issue.key}/artifacts`, {
      kind: 'pull_request',
      title: 'Fix token refresh',
      externalId: '#42',
    }).expect(201)).body;
    expect(artifact).toMatchObject({ issueId: issue.id, kind: 'pull_request', title: 'Fix token refresh' });
    expect((await owner.client.get(`${base}/issues/${issue.id}/artifacts`).expect(200)).body).toEqual([artifact]);
    expect((await owner.client.get(`${base}/artifacts?issueId=${issue.id}`).expect(200)).body).toEqual([artifact]);
    await owner.client.post(`${base}/artifacts`, { kind: 'document', title: 'Orphan' }).expect(400);

    const projectArtifact = (await owner.client.post(`${base}/projects/${project.id}/artifacts`, {
      kind: 'document',
      title: 'Design notes',
    }).expect(201)).body;
    expect(projectArtifact.projectId).toBe(project.id);
    await owner.client.delete(`${base}/issues/${issue.key}`).expect(204);
    await owner.client.get(`${base}/artifacts/${artifact.id}`).expect(404);
    expect((await owner.client.get(`${base}/artifacts/${projectArtifact.id}`).expect(200)).body.projectId).toBe(project.id);
  });

  it('builds project context from direct Issues, their artifacts, open Questions and Decisions', async () => {
    const { owner, base, project, issue } = await setup();
    const artifact = (await owner.client.post(`${base}/artifacts`, {
      issueId: issue.id,
      kind: 'document',
      title: 'Refresh design',
    }).expect(201)).body;
    const question = (await owner.client.post(`${base}/input-requests`, {
      issueId: issue.id,
      question: 'Should refresh tokens rotate?',
      options: ['Yes', 'No'],
    }).expect(201)).body;
    const decision = (await owner.client.post(`${base}/decisions`, {
      title: 'Rotate refresh tokens',
      statement: 'Use rotating refresh tokens',
      originIssueId: issue.id,
    }).expect(201)).body;

    const context = (await owner.client.get(`${base}/projects/${project.id}/context`).expect(200)).body;
    expect(context.issues.map((item: { id: string }) => item.id)).toEqual([issue.id]);
    expect(context.artifacts).toEqual([
      { artifact, path: [{ type: 'project', id: project.id }, { type: 'issue', id: issue.id }] },
    ]);
    expect(context.inputRequests.map((item: { id: string }) => item.id)).toEqual([question.id]);
    expect(context.decisions.map((item: { id: string }) => item.id)).toEqual([decision.id]);

    const markdown = await owner.client.get(`${base}/projects/${project.id}/context.md`).expect(200);
    expect(markdown.headers['content-type']).toMatch(/^text\/markdown/);
    expect(markdown.text).toContain('Refresh design');
    expect(markdown.text).toContain('Should refresh tokens rotate?');
    expect(markdown.text).toContain('Rotate refresh tokens');
  });

  it('allows read-only members to read context and artifacts, but not mutate them', async () => {
    const { owner, base, project, issue } = await setup();
    const artifact = (await owner.client.post(`${base}/issues/${issue.key}/artifacts`, {
      kind: 'document',
      title: 'Private design',
    }).expect(201)).body;
    const viewer = await Client.signup(server, 'Context Viewer');
    await owner.client.post(`${base}/members`, { email: viewer.email, role: 'viewer' }).expect(201);

    await viewer.client.get(`${base}/projects/${project.id}/context`).expect(200);
    await viewer.client.get(`${base}/issues/${issue.key}/artifacts`).expect(200);
    await viewer.client.patch(`${base}/artifacts/${artifact.id}`, { title: 'Changed' }).expect(403);
    await viewer.client.delete(`${base}/artifacts/${artifact.id}`).expect(403);

    const token = (await owner.client.post(`${base}/tokens`, { name: 'context reader', scope: 'read' }).expect(201)).body;
    const reader = new TokenClient(server, token.secret);
    await reader.get(`${base}/projects/${project.id}/context`).expect(200);
    await reader.post(`${base}/issues/${issue.key}/artifacts`, { kind: 'document', title: 'Denied' }).expect(403);
  });
});
