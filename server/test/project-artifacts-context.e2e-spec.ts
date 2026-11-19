import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ArtifactEntity } from '../src/database/entities/index.js';
import type { ActorRef } from '../src/contracts/domain.js';
import { Client, TokenClient, createTestApp, uniq } from './app.js';
import request from 'supertest';

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
    const workspace = (
      await owner.client
        .post('/api/workspaces', { name: 'Context Co' })
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

  it('attaches artifacts to Issues, lists them by Issue, and prevents orphan artifacts', async () => {
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

    const projectArtifact = (
      await owner.client
        .post(`${base}/projects/${project.id}/artifacts`, {
          kind: 'document',
          title: 'Design notes',
        })
        .expect(201)
    ).body;
    expect(projectArtifact.projectId).toBe(project.id);
    await owner.client.delete(`${base}/tasks/${issue.key}`).expect(204);
    await owner.client.get(`${base}/artifacts/${artifact.id}`).expect(404);
    expect(
      (
        await owner.client
          .get(`${base}/artifacts/${projectArtifact.id}`)
          .expect(200)
      ).body.projectId,
    ).toBe(project.id);
  });

  it('builds project context from direct Issues and their artifacts', async () => {
    const { owner, base, project, issue } = await setup();
    const artifact = (
      await owner.client
        .post(`${base}/artifacts`, {
          issueId: issue.id,
          kind: 'document',
          title: 'Refresh design',
        })
        .expect(201)
    ).body;

    const context = (
      await owner.client
        .get(`${base}/projects/${project.id}/context`)
        .expect(200)
    ).body;
    expect(context.issues.map((item: { id: string }) => item.id)).toEqual([
      issue.id,
    ]);
    expect(context.artifacts).toEqual([
      {
        artifact,
        path: [
          { type: 'project', id: project.id },
          { type: 'issue', id: issue.id },
        ],
      },
    ]);
    expect(context).not.toHaveProperty('inputRequests');
    expect(context).not.toHaveProperty('decisions');

    const markdown = await owner.client
      .get(`${base}/projects/${project.id}/context.md`)
      .expect(200);
    expect(markdown.headers['content-type']).toMatch(/^text\/markdown/);
    expect(markdown.text).toContain('Refresh design');
  });

  it('allows read-only members to read context and artifacts, but not mutate them', async () => {
    const { owner, base, project, issue } = await setup();
    const artifact = (
      await owner.client
        .post(`${base}/tasks/${issue.key}/artifacts`, {
          kind: 'document',
          title: 'Private design',
        })
        .expect(201)
    ).body;
    const viewer = await Client.signup(server, 'Context Viewer');
    await owner.client
      .post(`${base}/members`, { email: viewer.email, role: 'viewer' })
      .expect(201);

    await viewer.client
      .get(`${base}/projects/${project.id}/context`)
      .expect(200);
    await viewer.client
      .get(`${base}/tasks/${issue.key}/artifacts`)
      .expect(200);
    await viewer.client
      .patch(`${base}/artifacts/${artifact.id}`, { title: 'Changed' })
      .expect(403);
    await viewer.client.delete(`${base}/artifacts/${artifact.id}`).expect(403);

    const token = (
      await owner.client
        .post(`${base}/tokens`, { name: 'context reader', scope: 'read' })
        .expect(201)
    ).body;
    const reader = new TokenClient(server, token.secret);
    await reader.get(`${base}/projects/${project.id}/context`).expect(200);
    await reader
      .post(`${base}/tasks/${issue.key}/artifacts`, {
        kind: 'document',
        title: 'Denied',
      })
      .expect(403);
  });

  it('bounds markdown queries and counts records attached beyond the issue cap', async () => {
    const { owner, base, workspace, project } = await setup();
    const laterIssues: { id: string; key: string }[] = [];
    for (let i = 0; i < 44; i++) {
      const created = (
        await owner.client
          .post(`${base}/tasks`, {
            kind: 'feature',
            title: `Later issue ${i}`,
            projectId: project.id,
          })
          .expect(201)
      ).body;
      laterIssues.push(created);
    }
    const lastIssue = laterIssues[laterIssues.length - 1];
    const ds = app.get(DataSource);
    const workspaceId = workspace.id;
    const actor: ActorRef = { type: 'user', id: owner.user.id };
    await ds.getRepository(ArtifactEntity).save(
      Array.from({ length: 45 }, (_, i) =>
        ds.getRepository(ArtifactEntity).create({
          id: uniq('ctx-artifact-'),
          workspaceId,
          projectId: null,
          issueId: lastIssue.id,
          legacyWorkstreamKey: null,
          repository: null,
          description: null,
          kind: 'document',
          title: `Late artifact ${i}`,
          url: null,
          documentId: null,
          uploadId: null,
          externalId: null,
          state: 'open',
          ci: null,
          review: null,
          hasConflicts: null,
          environment: null,
          authorRef: actor,
        }),
      ),
    );
    const markdown = await owner.client
      .get(`${base}/projects/${project.id}/context.md`)
      .expect(200);
    const openIssues = markdown.text.split('## Artifacts')[0] ?? '';
    const artifacts =
      markdown.text.split('## Artifacts')[1]?.split('## Decisions')[0] ?? '';
    expect(openIssues).toContain('… 5 more');
    expect(artifacts).toContain('… 5 more');

    await request(server)
      .get(`${base}/projects/${project.id}/context.md`)
      .expect(401);
  }, 120_000);
});
