import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ArtifactEntity,
  DecisionEntity,
  InputRequestEntity,
} from '../src/database/entities/index.js';
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
        .post(`${base}/issues`, {
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
        .post(`${base}/issues/${issue.key}/artifacts`, {
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
          .get(`${base}/issues/${issue.id}/artifacts`)
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
    await owner.client.delete(`${base}/issues/${issue.key}`).expect(204);
    await owner.client.get(`${base}/artifacts/${artifact.id}`).expect(404);
    expect(
      (
        await owner.client
          .get(`${base}/artifacts/${projectArtifact.id}`)
          .expect(200)
      ).body.projectId,
    ).toBe(project.id);
  });

  it('builds project context from direct Issues, their artifacts, open Questions and Decisions', async () => {
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
    const question = (
      await owner.client
        .post(`${base}/input-requests`, {
          issueId: issue.id,
          question: 'Should refresh tokens rotate?',
          options: ['Yes', 'No'],
        })
        .expect(201)
    ).body;
    const decision = (
      await owner.client
        .post(`${base}/decisions`, {
          title: 'Rotate refresh tokens',
          statement: 'Use rotating refresh tokens',
          originIssueId: issue.id,
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
    expect(
      context.inputRequests.map((item: { id: string }) => item.id),
    ).toEqual([question.id]);
    expect(context.decisions.map((item: { id: string }) => item.id)).toEqual([
      decision.id,
    ]);

    const markdown = await owner.client
      .get(`${base}/projects/${project.id}/context.md`)
      .expect(200);
    expect(markdown.headers['content-type']).toMatch(/^text\/markdown/);
    expect(markdown.text).toContain('Refresh design');
    expect(markdown.text).toContain('Should refresh tokens rotate?');
    expect(markdown.text).toContain('Rotate refresh tokens');
  });

  it('allows read-only members to read context and artifacts, but not mutate them', async () => {
    const { owner, base, project, issue } = await setup();
    const artifact = (
      await owner.client
        .post(`${base}/issues/${issue.key}/artifacts`, {
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
      .get(`${base}/issues/${issue.key}/artifacts`)
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
      .post(`${base}/issues/${issue.key}/artifacts`, {
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
          .post(`${base}/issues`, {
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
          repositoryId: null,
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
    await ds.getRepository(DecisionEntity).save(
      Array.from({ length: 22 }, (_, i) =>
        ds.getRepository(DecisionEntity).create({
          id: uniq('ctx-decision-'),
          workspaceId,
          key: `CTX-${uniq()}`,
          number: 50000 + i,
          title: `Late decision ${i}`,
          statement: 'Use the bounded query',
          rationale: null,
          status: 'accepted',
          originIssueId: lastIssue.id,
          relatedIssueIds: [],
          legacyWorkstreamKeys: [],
          legacyWorkstreamKey: null,
          supersededById: null,
          proposedBy: actor,
          decidedById: null,
          decidedAt: null,
          tags: [],
        }),
      ),
    );
    await ds.getRepository(InputRequestEntity).save(
      Array.from({ length: 22 }, (_, i) =>
        ds.getRepository(InputRequestEntity).create({
          id: uniq('ctx-input-'),
          workspaceId,
          issueId: lastIssue.id,
          legacyWorkstreamKey: null,
          question: `Late question ${i}?`,
          options: null,
          requestedBy: actor,
          assigneeUserId: null,
          state: 'open',
          answer: null,
          answeredById: null,
          answeredAt: null,
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
    expect(markdown.text).toContain('… 2 more');
    expect(markdown.text).toContain('Late decision');
    expect(markdown.text).toContain('Late question');

    await request(server)
      .get(`${base}/projects/${project.id}/context.md`)
      .expect(401);
  }, 120_000);
});
