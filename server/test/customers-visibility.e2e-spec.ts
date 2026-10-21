import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('project-scoped customer requests', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  it.each([true, false])(
    'scopes request reads and writes when includeUnassigned=%s',
    async (includeUnassigned) => {
      const owner = await Client.signup(server, 'Customer scope owner');
      const workspace = (
        await owner.client
          .post('/api/workspaces', {
            name: `Customer scope ${includeUnassigned}`,
          })
          .expect(201)
      ).body;
      const w = `/api/w/${workspace.slug}`;
      const customer = (
        await owner.client
          .post(`${w}/customers`, {
            name: 'Scoped customer',
            domain: `scope-${includeUnassigned}.example`,
          })
          .expect(201)
      ).body;
      const visibleProject = (
        await owner.client
          .post(`${w}/projects`, { name: 'Visible customer project' })
          .expect(201)
      ).body;
      const hiddenProject = (
        await owner.client
          .post(`${w}/projects`, { name: 'Hidden customer project' })
          .expect(201)
      ).body;
      const visibleIssue = (
        await owner.client
          .post(`${w}/issues`, {
            kind: 'feature',
            title: 'Visible customer issue',
            projectId: visibleProject.id,
          })
          .expect(201)
      ).body;
      const hiddenIssue = (
        await owner.client
          .post(`${w}/issues`, {
            kind: 'feature',
            title: 'Hidden customer issue',
            projectId: hiddenProject.id,
          })
          .expect(201)
      ).body;
      const visibleIssueRequest = (
        await owner.client
          .post(`${w}/customers/${customer.id}/requests`, {
            issueId: visibleIssue.id,
            body: 'Visible issue request',
          })
          .expect(201)
      ).body;
      const visibleProjectRequest = (
        await owner.client
          .post(`${w}/customers/${customer.id}/requests`, {
            projectId: visibleProject.id,
            body: 'Visible project request',
          })
          .expect(201)
      ).body;
      const hiddenIssueRequest = (
        await owner.client
          .post(`${w}/customers/${customer.id}/requests`, {
            issueId: hiddenIssue.id,
            body: 'Hidden issue request secret',
          })
          .expect(201)
      ).body;
      const hiddenProjectRequest = (
        await owner.client
          .post(`${w}/customers/${customer.id}/requests`, {
            projectId: hiddenProject.id,
            body: 'Hidden project request secret',
          })
          .expect(201)
      ).body;

      const member = await Client.signup(server, 'Customer scope member');
      await owner.client
        .post(`${w}/members`, { email: member.email, role: 'member' })
        .expect(201);
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

      const workspacePage = (
        await member.client.get(`${w}/customer-requests?limit=100`).expect(200)
      ).body as {
        items: { id: string }[];
        nextCursor: string | null;
      };
      expect(
        workspacePage.items
          .map((row) => row.id)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(
        [visibleIssueRequest.id, visibleProjectRequest.id].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
      expect(JSON.stringify(workspacePage)).not.toContain(
        'Hidden issue request secret',
      );
      expect(JSON.stringify(workspacePage)).not.toContain(
        'Hidden project request secret',
      );
      expect(workspacePage.nextCursor).toBeNull();

      const customerRequests = (
        await member.client
          .get(`${w}/customers/${customer.id}/requests`)
          .expect(200)
      ).body as { id: string }[];
      expect(
        customerRequests
          .map((row) => row.id)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(
        [visibleIssueRequest.id, visibleProjectRequest.id].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
      expect(
        (
          await member.client
            .get(`${w}/customer-requests?issueId=${hiddenIssue.id}&limit=100`)
            .expect(200)
        ).body.items,
      ).toEqual([]);
      expect(
        (
          await member.client
            .get(
              `${w}/customer-requests?projectId=${hiddenProject.id}&limit=100`,
            )
            .expect(200)
        ).body.items,
      ).toEqual([]);

      for (const request of [hiddenIssueRequest, hiddenProjectRequest]) {
        await member.client
          .patch(`${w}/customers/${customer.id}/requests/${request.id}`, {
            important: true,
          })
          .expect(403);
        await member.client
          .post(`${w}/customers/${customer.id}/requests/${request.id}/unlink`)
          .expect(403);
      }
      await member.client
        .post(`${w}/customers/${customer.id}/requests`, {
          issueId: hiddenIssue.id,
          body: 'Attempted hidden issue request',
        })
        .expect(403);
      await member.client
        .post(`${w}/customers/${customer.id}/requests`, {
          projectId: hiddenProject.id,
          body: 'Attempted hidden project request',
        })
        .expect(403);

      const edited = (
        await member.client
          .patch(
            `${w}/customers/${customer.id}/requests/${visibleIssueRequest.id}`,
            { body: 'Edited visible request' },
          )
          .expect(200)
      ).body;
      expect(edited.body).toBe('Edited visible request');
      await member.client
        .post(
          `${w}/customers/${customer.id}/requests/${visibleProjectRequest.id}/unlink`,
        )
        .expect(204);
    },
  );
});
