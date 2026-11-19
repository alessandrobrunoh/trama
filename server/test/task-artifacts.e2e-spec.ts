import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

describe('Task artifacts', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  async function setup() {
    const owner = await Client.signup(server, 'Artifact Owner');
    const workspace = (
      await owner.client
        .post('/api/workspaces', { name: 'Artifact Co' })
        .expect(201)
    ).body;
    const base = `/api/w/${workspace.slug}`;
    const project = (
      await owner.client
        .post(`${base}/projects`, { name: 'Auth refresh' })
        .expect(201)
    ).body;
    const issue = (
      await owner.client
        .post(`${base}/tasks`, {
          kind: 'bug',
          title: 'Refresh tokens expire early',
          projectId: project.id,
        })
        .expect(201)
    ).body;
    return { owner, base, workspace, project, issue };
  }

  it('attaches artifacts to tasks, lists them by task, and prevents orphan artifacts', async () => {
    const { owner, base, issue, project } = await setup();
    const artifact = (
      await owner.client
        .post(`${base}/tasks/${issue.key}/artifacts`, {
          kind: 'pull_request',
          title: 'Fix token refresh',
          externalId: '#42',
        })
        .expect(201)
    ).body;
    expect(artifact).toMatchObject({
      issueId: issue.id,
      kind: 'pull_request',
      title: 'Fix token refresh',
    });
    expect(artifact).not.toHaveProperty('projectId');
    expect(
      (
        await owner.client
          .get(`${base}/tasks/${issue.id}/artifacts`)
          .expect(200)
      ).body,
    ).toEqual([artifact]);
    expect(
      (
        await owner.client
          .get(`${base}/artifacts?issueId=${issue.id}`)
          .expect(200)
      ).body,
    ).toEqual([artifact]);
    await owner.client
      .post(`${base}/artifacts`, { kind: 'document', title: 'Orphan' })
      .expect(400);
    // Projects no longer own artifacts or expose a context.
    await owner.client
      .post(`${base}/projects/${project.id}/artifacts`, {
        kind: 'document',
        title: 'Design notes',
      })
      .expect(404);
    await owner.client.get(`${base}/projects/${project.id}/context`).expect(404);
    await owner.client.get(`${base}/projects/${project.id}/updates`).expect(404);
    await owner.client.get(`${base}/documents`).expect(404);

    await owner.client.delete(`${base}/tasks/${issue.key}`).expect(204);
    await owner.client.get(`${base}/artifacts/${artifact.id}`).expect(404);
  });

  it('allows read-only members to read artifacts, but not mutate them', async () => {
    const { owner, base, issue } = await setup();
    const artifact = (
      await owner.client
        .post(`${base}/tasks/${issue.key}/artifacts`, {
          kind: 'document',
          title: 'Private design',
        })
        .expect(201)
    ).body;
    const viewer = await Client.signup(server, 'Artifact Viewer');
    await owner.client
      .post(`${base}/members`, { email: viewer.email, role: 'viewer' })
      .expect(201);

    await viewer.client
      .get(`${base}/tasks/${issue.key}/artifacts`)
      .expect(200);
    await viewer.client
      .patch(`${base}/artifacts/${artifact.id}`, { title: 'Changed' })
      .expect(403);
    await viewer.client.delete(`${base}/artifacts/${artifact.id}`).expect(403);

    const token = (
      await owner.client
        .post(`${base}/tokens`, { name: 'artifact reader', scope: 'read' })
        .expect(201)
    ).body;
    const reader = new TokenClient(server, token.secret);
    await reader.get(`${base}/tasks/${issue.key}/artifacts`).expect(200);
    await reader
      .post(`${base}/tasks/${issue.key}/artifacts`, {
        kind: 'document',
        title: 'Denied',
      })
      .expect(403);
  });

  it('keeps `goal` out of tasks', async () => {
    const { owner, base, project } = await setup();
    const created = (
      await owner.client
        .post(`${base}/tasks`, {
          kind: 'feature',
          title: 'No goal field',
          projectId: project.id,
        })
        .expect(201)
    ).body;
    expect(created).not.toHaveProperty('goal');
  });
});
