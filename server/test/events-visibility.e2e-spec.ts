import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

describe('project-scoped event history', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  it('filters hidden project and issue events, including comment excerpts, in history and snapshots', async () => {
    const owner = await Client.signup(server, 'Events owner');
    const workspace = (
      await owner.client
        .post('/api/workspaces', { name: 'Event scope' })
        .expect(201)
    ).body;
    const w = `/api/w/${workspace.slug}`;
    const member = await Client.signup(server, 'Events member');
    await owner.client
      .post(`${w}/members`, { email: member.email, role: 'viewer' })
      .expect(201);

    const visibleProject = (
      await owner.client
        .post(`${w}/projects`, { name: 'Visible event project' })
        .expect(201)
    ).body;
    const hiddenProject = (
      await owner.client
        .post(`${w}/projects`, { name: 'Hidden event project' })
        .expect(201)
    ).body;
    const memberships = (await owner.client.get(`${w}/members`).expect(200))
      .body as {
      id: string;
      userId: string;
    }[];
    const memberRow = memberships.find((row) => row.userId === member.user.id);
    expect(memberRow).toBeDefined();
    await owner.client
      .patch(`${w}/members/${memberRow!.id}`, {
        access: {
          projects: { all: false, projectIds: [visibleProject.id] },
          includeUnassigned: false,
        },
      })
      .expect(200);

    const visibleIssue = (
      await owner.client
        .post(`${w}/issues`, {
          kind: 'bug',
          title: 'Visible issue event',
          projectId: visibleProject.id,
        })
        .expect(201)
    ).body;
    const hiddenIssue = (
      await owner.client
        .post(`${w}/issues`, {
          kind: 'bug',
          title: 'Hidden issue event',
          projectId: hiddenProject.id,
        })
        .expect(201)
    ).body;
    await owner.client
      .post(`${w}/comments`, {
        subject: { type: 'issue', id: visibleIssue.id },
        body: 'visible comment excerpt',
      })
      .expect(201);
    await owner.client
      .post(`${w}/comments`, {
        subject: { type: 'issue', id: hiddenIssue.id },
        body: 'hidden comment excerpt',
      })
      .expect(201);

    const history = (
      await member.client.get(`${w}/events?limit=500`).expect(200)
    ).body as {
      subject: { type: string; id: string };
      data: Record<string, unknown>;
    }[];
    expect(history.some((event) => event.subject.id === visibleIssue.id)).toBe(
      true,
    );
    expect(history.some((event) => event.subject.id === hiddenIssue.id)).toBe(
      false,
    );
    expect(JSON.stringify(history)).toContain('visible comment excerpt');
    expect(JSON.stringify(history)).not.toContain('hidden comment excerpt');
    expect(history.some((event) => event.subject.id === hiddenProject.id)).toBe(
      false,
    );

    const snapshot = (
      await member.client.get(`${w}/snapshot?comments=index`).expect(200)
    ).body as {
      events: { subject: { id: string }; data: Record<string, unknown> }[];
    };
    expect(
      snapshot.events.some((event) => event.subject.id === hiddenIssue.id),
    ).toBe(false);
    expect(JSON.stringify(snapshot.events)).not.toContain(
      'hidden comment excerpt',
    );
  });
});
