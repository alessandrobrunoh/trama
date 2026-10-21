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
    'hides and protects artifacts owned by hidden projects (includeUnassigned=%s)',
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
          .post(`${w}/issues`, {
            kind: 'bug',
            title: 'Visible issue',
            projectId: visibleProject.id,
          })
          .expect(201)
      ).body;
      const hiddenIssue = (
        await owner.client
          .post(`${w}/issues`, {
            kind: 'bug',
            title: 'Hidden issue',
            projectId: hiddenProject.id,
          })
          .expect(201)
      ).body;
      const visibleArtifact = (
        await owner.client
          .post(`${w}/issues/${visibleIssue.id}/artifacts`, {
            kind: 'document',
            title: 'Visible evidence',
          })
          .expect(201)
      ).body;
      const hiddenIssueArtifact = (
        await owner.client
          .post(`${w}/issues/${hiddenIssue.id}/artifacts`, {
            kind: 'document',
            title: 'Hidden issue evidence',
          })
          .expect(201)
      ).body;
      const hiddenProjectArtifact = (
        await owner.client
          .post(`${w}/projects/${hiddenProject.id}/artifacts`, {
            kind: 'document',
            title: 'Hidden project evidence',
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
      expect(listed.map((row) => row.id)).not.toContain(
        hiddenProjectArtifact.id,
      );
      await member.client
        .get(`${w}/artifacts/${hiddenIssueArtifact.id}`)
        .expect(404);
      await member.client
        .get(`${w}/artifacts/${hiddenProjectArtifact.id}`)
        .expect(404);
      expect(
        (
          await member.client
            .get(`${w}/issues/${hiddenIssue.id}/artifacts`)
            .expect(200)
        ).body,
      ).toEqual([]);

      await member.client
        .get(`${w}/projects/${hiddenProject.id}/artifacts`)
        .expect(404);
      await member.client
        .post(`${w}/issues/${hiddenIssue.id}/artifacts`, {
          kind: 'document',
          title: 'Attempted hidden issue attach',
        })
        .expect(400);
      await member.client
        .post(`${w}/projects/${hiddenProject.id}/artifacts`, {
          kind: 'document',
          title: 'Attempted hidden project attach',
        })
        .expect(404);
      await member.client
        .post(`${w}/artifacts`, {
          kind: 'document',
          title: 'Attempted direct hidden project attach',
          projectId: hiddenProject.id,
        })
        .expect(400);
      await member.client
        .patch(`${w}/artifacts/${visibleArtifact.id}`, {
          projectId: hiddenProject.id,
        })
        .expect(400);
      await member.client
        .delete(`${w}/artifacts/${hiddenIssueArtifact.id}`)
        .expect(404);
    },
  );
});
