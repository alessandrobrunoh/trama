import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('project-scoped artifact access', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  it.each([true, false])(
    'hides and protects artifacts of tasks in hidden projects (includeUnassigned=%s)',
    async (includeUnassigned) => {
      const owner = await Client.signup(server, 'Artifact scope owner');
      const workspace = (
        await owner.client
          .post('/api/workspaces', { name: 'Artifact scope' })
          .expect(201)
      ).body;
      const w = `/api/w/${workspace.slug}`;
      const member = await Client.signup(server, 'Artifact scope member');
      await owner.client
        .post(`${w}/members`, { email: member.email, role: 'member' })
        .expect(201);

      const visibleProject = (
        await owner.client
          .post(`${w}/projects`, { name: 'Visible project' })
          .expect(201)
      ).body;
      const hiddenProject = (
        await owner.client
          .post(`${w}/projects`, { name: 'Hidden project' })
          .expect(201)
      ).body;
      const visibleIssue = (
        await owner.client
          .post(`${w}/tasks`, {
            kind: 'bug',
            title: 'Visible issue',
            projectId: visibleProject.id,
          })
          .expect(201)
      ).body;
      const hiddenIssue = (
        await owner.client
          .post(`${w}/tasks`, {
            kind: 'bug',
            title: 'Hidden issue',
            projectId: hiddenProject.id,
          })
          .expect(201)
      ).body;
      const visibleArtifact = (
        await owner.client
          .post(`${w}/tasks/${visibleIssue.id}/artifacts`, {
            kind: 'document',
            title: 'Visible evidence',
          })
          .expect(201)
      ).body;
      const hiddenIssueArtifact = (
        await owner.client
          .post(`${w}/tasks/${hiddenIssue.id}/artifacts`, {
            kind: 'document',
            title: 'Hidden issue evidence',
          })
          .expect(201)
      ).body;

      const memberships = (await owner.client.get(`${w}/members`).expect(200))
        .body as { id: string; userId: string }[];
      const membership = memberships.find(
        (row) => row.userId === member.user.id,
      );
      expect(membership).toBeDefined();
      await owner.client
        .patch(`${w}/members/${membership!.id}`, {
          access: {
            projects: { all: false, projectIds: [visibleProject.id] },
            includeUnassigned,
          },
        })
        .expect(200);

      const listed = (await member.client.get(`${w}/artifacts`).expect(200))
        .body as { id: string }[];
      expect(listed.map((row) => row.id)).toContain(visibleArtifact.id);
      expect(listed.map((row) => row.id)).not.toContain(hiddenIssueArtifact.id);
      await member.client
        .get(`${w}/artifacts/${hiddenIssueArtifact.id}`)
        .expect(404);
      expect(
        (
          await member.client
            .get(`${w}/tasks/${hiddenIssue.id}/artifacts`)
            .expect(200)
        ).body,
      ).toEqual([]);

      await member.client
        .post(`${w}/tasks/${hiddenIssue.id}/artifacts`, {
          kind: 'document',
          title: 'Attempted hidden issue attach',
        })
        .expect(400);
      await member.client
        .post(`${w}/artifacts`, {
          kind: 'document',
          title: 'Attempted direct hidden issue attach',
          issueId: hiddenIssue.id,
        })
        .expect(400);
      await member.client
        .patch(`${w}/artifacts/${visibleArtifact.id}`, {
          issueId: hiddenIssue.id,
        })
        .expect(400);
      await member.client
        .delete(`${w}/artifacts/${hiddenIssueArtifact.id}`)
        .expect(404);
    },
  );
});
