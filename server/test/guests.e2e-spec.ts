import type { INestApplication } from '@nestjs/common';
import { Client, createTestApp } from './app.js';

const tokenOf = (url: string): string => url.split('/invite/')[1];

interface Row {
  id: string;
}

describe('project guests and the organizer role', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  /** A workspace with two projects, a task in each, and an owner. */
  async function setup() {
    const owner = await Client.signup(server, 'Olivia Owner');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Guest Co' }).expect(201)).body;
    const w = `/api/w/${ws.slug as string}`;
    const shared = (await owner.client.post(`${w}/projects`, { name: 'Shared with client' }).expect(201)).body;
    const secret = (await owner.client.post(`${w}/projects`, { name: 'Internal only' }).expect(201)).body;
    const sharedTask = (
      await owner.client.post(`${w}/tasks`, { kind: 'bug', title: 'Visible zebra task', projectId: shared.id }).expect(201)
    ).body;
    const secretTask = (
      await owner.client.post(`${w}/tasks`, { kind: 'bug', title: 'Hidden zebra task', projectId: secret.id }).expect(201)
    ).body;
    await owner.client
      .post(`${w}/comments`, { subject: { type: 'issue', id: secretTask.id }, body: 'internal-only comment' })
      .expect(201);
    return {
      owner: owner.client,
      ownerId: owner.user.id,
      ownerEmail: owner.email,
      ws,
      w,
      shared,
      secret,
      sharedTask,
      secretTask,
    };
  }

  /** Invites a new person to the project and has them accept. */
  async function guestOn(ctx: Awaited<ReturnType<typeof setup>>, projectId: string, name = 'Gina Guest') {
    const person = await Client.signup(server, name);
    const res = (await ctx.owner.post(`${ctx.w}/projects/${projectId}/invites`, { email: person.email }).expect(201)).body;
    expect(res.status).toBe('invited');
    await person.client.post(`/api/invites/${tokenOf(res.link.url)}/accept`).expect(200);
    return { client: person.client, email: person.email, id: person.user.id };
  }

  async function membershipOf(ctx: Awaited<ReturnType<typeof setup>>, userId: string) {
    const rows = (await ctx.owner.get(`${ctx.w}/members`).expect(200)).body as { id: string; userId: string }[];
    return rows.find((row) => row.userId === userId);
  }

  it('a guest sees only their project: projects, tasks, comments, events, search', async () => {
    const ctx = await setup();
    const { w, shared, secret, sharedTask, secretTask } = ctx;
    const guest = await guestOn(ctx, shared.id);

    expect((await guest.client.get(`${w}`).expect(200)).body.role).toBe('guest');
    const snapshot = (await guest.client.get(`${w}/snapshot`).expect(200)).body;
    expect(snapshot.projects.map((p: Row) => p.id)).toEqual([shared.id]);
    expect(snapshot.issues.map((i: Row) => i.id)).toEqual([sharedTask.id]);
    expect(JSON.stringify(snapshot.comments)).not.toContain('internal-only');
    expect(JSON.stringify(snapshot.events)).not.toContain(secret.id);
    expect(JSON.stringify(snapshot.events)).not.toContain(secretTask.id);
    expect(snapshot.integrations).toEqual([]);

    await guest.client.get(`${w}/projects/${secret.id}`).expect(404);
    expect((await guest.client.get(`${w}/projects`).expect(200)).body.map((p: Row) => p.id)).toEqual([shared.id]);
    expect((await guest.client.get(`${w}/tasks`).expect(200)).body.map((i: Row) => i.id)).toEqual([sharedTask.id]);
    await guest.client.get(`${w}/tasks/${secretTask.key}`).expect(404);
    expect((await guest.client.get(`${w}/tasks/${secretTask.id}/artifacts`).expect(200)).body).toEqual([]);

    const events = (await guest.client.get(`${w}/events`).expect(200)).body as { subject: { id: string } }[];
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.subject.id === secretTask.id || e.subject.id === secret.id)).toBe(false);

    const found = (await guest.client.get(`${w}/search?q=zebra`).expect(200)).body.results as Row[];
    expect(found.map((r) => r.id)).toEqual([sharedTask.id]);

    await guest.client
      .get(`${w}/comments?subjectType=issue&subjectId=${secretTask.id}`)
      .expect(404);
    await guest.client
      .post(`${w}/comments`, { subject: { type: 'issue', id: secretTask.id }, body: 'peek' })
      .expect(404);
  });

  it('a guest cannot list the members beyond the people on their project', async () => {
    const ctx = await setup();
    const { owner, w, shared, secret } = ctx;
    const guest = await guestOn(ctx, shared.id);
    const otherGuest = await guestOn(ctx, secret.id, 'Other Guest');
    const insider = await Client.signup(server, 'Internal Dev');
    await owner.post(`${w}/members`, { email: insider.email, role: 'member' }).expect(201);
    const insiderRow = await membershipOf(ctx, insider.user.id);
    await owner
      .patch(`${w}/members/${insiderRow!.id}`, {
        access: { projects: { all: false, projectIds: [secret.id] }, includeUnassigned: false },
      })
      .expect(200);
    const bot = (await owner.post(`${w}/agents`, { name: 'Secret bot', provider: 'codex' }).expect(201)).body;
    await owner.post(`${w}/tasks`, { kind: 'bug', title: 'Bot job', projectId: secret.id }).expect(201);

    const listed = (await guest.client.get(`${w}/members`).expect(200)).body as { userId: string }[];
    const ids = listed.map((row) => row.userId);
    expect(ids).toContain(guest.id);
    expect(ids).toContain(ctx.ownerId); // sees every project, so is on this one too
    expect(ids).not.toContain(otherGuest.id);
    expect(ids).not.toContain(insider.user.id);

    const snapshot = (await guest.client.get(`${w}/snapshot`).expect(200)).body;
    expect(snapshot.memberships.map((m: { userId: string }) => m.userId).sort()).toEqual(ids.sort());
    expect(snapshot.users.map((u: Row) => u.id).sort()).toEqual(ids.sort());
    expect(snapshot.agents).toEqual([]);
    expect((await guest.client.get(`${w}/agents`).expect(200)).body).toEqual([]);
    await guest.client.get(`${w}/agents/${bot.id}`).expect(403);
  });

  it('a guest creates tasks and comments in their project, but not elsewhere, and touches no workspace settings', async () => {
    const ctx = await setup();
    const { w, shared, secret, sharedTask } = ctx;
    const guest = await guestOn(ctx, shared.id);

    const created = (
      await guest.client.post(`${w}/tasks`, { kind: 'bug', title: 'From the client', projectId: shared.id }).expect(201)
    ).body;
    expect(created.projectId).toBe(shared.id);
    await guest.client.patch(`${w}/tasks/${created.key}`, { title: 'Renamed by the client' }).expect(200);
    await guest.client.post(`${w}/comments`, { subject: { type: 'issue', id: sharedTask.id }, body: 'hello' }).expect(201);
    await guest.client.post(`${w}/tasks`, { kind: 'bug', title: 'Elsewhere', projectId: secret.id }).expect(403);
    await guest.client.post(`${w}/tasks`, { kind: 'bug', title: 'No project' }).expect(403);
    await guest.client.patch(`${w}/tasks/${created.key}`, { projectId: secret.id }).expect(403);
    await guest.client.delete(`${w}/tasks/${created.key}`).expect(403);

    // time tracking works on their own project only
    await guest.client.post(`${w}/time-entries/start`, { issueId: sharedTask.id }).expect(201);
    await guest.client.post(`${w}/time-entries/start`, { projectId: secret.id }).expect(404);
    await guest.client.post(`${w}/time-entries/stop`).expect(201);

    // nothing of the workspace itself
    await guest.client.post(`${w}/projects`, { name: 'Mine' }).expect(403);
    await guest.client.patch(`${w}/projects/${shared.id}`, { name: 'Renamed' }).expect(403);
    await guest.client.post(`${w}/milestones`, { projectId: shared.id, name: 'M1' }).expect(403);
    await guest.client.post(`${w}/labels`, { name: 'guest-label', scope: 'issue' }).expect(403);
    await guest.client.patch(`${w}/settings`, { estimateScale: 'linear' }).expect(403);
    await guest.client.patch(`${w}/roles/guest`, { capabilities: ['manageProjects'] }).expect(403);
    await guest.client.get(`${w}/integrations`).expect(403);
    await guest.client.get(`${w}/outgoing-webhooks`).expect(403);
    await guest.client.get(`${w}/invites`).expect(403);
    await guest.client.get(`${w}/tokens`).expect(403);
    await guest.client.post(`${w}/tokens`, { name: 'nope' }).expect(403);
    await guest.client.post(`${w}/members`, { email: 'someone@test.dev', role: 'viewer' }).expect(403);
    await guest.client.post(`${w}/ai/chat`, { messages: [{ role: 'user', content: 'hi' }] }).expect(403);
    await guest.client.post(`${w}/projects/${shared.id}/invites`, { email: 'friend@test.dev' }).expect(403);
    await guest.client.get(`${w}/projects/${shared.id}/share`).expect(403);
  });

  it('does not show a guest the views shared with the workspace', async () => {
    const ctx = await setup();
    const { owner, w, shared } = ctx;
    const guest = await guestOn(ctx, shared.id);
    await owner.post(`${w}/views`, { name: 'Everyone', entity: 'issue', shared: true }).expect(201);
    const snapshot = (await guest.client.get(`${w}/snapshot`).expect(200)).body;
    expect(snapshot.views).toEqual([]);
    await guest.client.get(`${w}/views`).expect(403);
    await guest.client.post(`${w}/views`, { name: 'Mine', entity: 'issue' }).expect(403);
  });

  describe('invite to project', () => {
    it('invites by email, lists the guest and the pending invitation, and refreshes a repeated invitation', async () => {
      const ctx = await setup();
      const { owner, w, shared } = ctx;
      const email = 'pending-client@test.dev';
      const first = (await owner.post(`${w}/projects/${shared.id}/invites`, { email }).expect(201)).body;
      expect(first.status).toBe('invited');
      expect(first.link.invite).toMatchObject({ email, role: 'guest' });
      expect(first.link.invite.access.projects.projectIds).toEqual([shared.id]);
      expect(first.link.invite.access.includeUnassigned).toBe(false);

      let share = (await owner.get(`${w}/projects/${shared.id}/share`).expect(200)).body;
      expect(share.invites.map((i: { email: string }) => i.email)).toEqual([email]);
      expect(share.members.map((m: { userId: string }) => m.userId)).toEqual([ctx.ownerId]);
      expect(share.members[0].allProjects).toBe(true);

      const again = (await owner.post(`${w}/projects/${shared.id}/invites`, { email }).expect(201)).body;
      expect(again.link.invite.id).toBe(first.link.invite.id);
      expect(again.link.url).not.toBe(first.link.url);

      const guest = await guestOn(ctx, shared.id);
      share = (await owner.get(`${w}/projects/${shared.id}/share`).expect(200)).body;
      const row = share.members.find((m: { userId: string }) => m.userId === guest.id);
      expect(row).toMatchObject({ role: 'guest', allProjects: false });
      expect(row.user.email).toBe(guest.email);

      await owner.post(`${w}/projects/${shared.id}/invites`, { email: 'not-an-email' }).expect(400);
      await owner.post(`${w}/projects/pj_missing/invites`, { email: 'x@test.dev' }).expect(404);
    });

    it('adds the project to an existing guest, and refuses someone who already sees every project', async () => {
      const ctx = await setup();
      const { owner, w, shared, secret, secretTask } = ctx;
      const guest = await guestOn(ctx, shared.id);
      await guest.client.get(`${w}/tasks/${secretTask.key}`).expect(404);

      const added = (await owner.post(`${w}/projects/${secret.id}/invites`, { email: guest.email }).expect(201)).body;
      expect(added.status).toBe('added');
      expect(added.member.userId).toBe(guest.id);
      expect(added.member.access.projects.projectIds.sort()).toEqual([shared.id, secret.id].sort());
      await guest.client.get(`${w}/tasks/${secretTask.key}`).expect(200);
      expect((await guest.client.get(`${w}/projects`).expect(200)).body).toHaveLength(2);
      // a second invitation is a no-op
      const repeated = (await owner.post(`${w}/projects/${secret.id}/invites`, { email: guest.email }).expect(201)).body;
      expect(repeated.status).toBe('added');
      expect(repeated.member.access.projects.projectIds).toHaveLength(2);

      const member = await Client.signup(server, 'Full Member');
      await owner.post(`${w}/members`, { email: member.email, role: 'member' }).expect(201);
      const refused = await owner.post(`${w}/projects/${shared.id}/invites`, { email: member.email }).expect(400);
      expect(refused.body.message).toMatch(/every project/);
      await owner.post(`${w}/projects/${shared.id}/invites`, { email: ctx.ownerEmail }).expect(400);
    });

    it('removes a project from a guest, and ends the membership with the last one', async () => {
      const ctx = await setup();
      const { owner, w, shared, secret } = ctx;
      const guest = await guestOn(ctx, shared.id);
      await owner.post(`${w}/projects/${secret.id}/invites`, { email: guest.email }).expect(201);
      const row = await membershipOf(ctx, guest.id);

      const first = (await owner.delete(`${w}/projects/${secret.id}/share/${row!.id}`).expect(200)).body;
      expect(first).toEqual({ membershipEnded: false });
      expect((await guest.client.get(`${w}/projects`).expect(200)).body.map((p: Row) => p.id)).toEqual([shared.id]);

      const last = (await owner.delete(`${w}/projects/${shared.id}/share/${row!.id}`).expect(200)).body;
      expect(last).toEqual({ membershipEnded: true });
      await guest.client.get(`${w}`).expect(404); // no longer a member
      expect(await membershipOf(ctx, guest.id)).toBeUndefined();

      // people who see every project are changed from Settings, not from one project
      const ownerRow = await membershipOf(ctx, ctx.ownerId);
      await owner.delete(`${w}/projects/${shared.id}/share/${ownerRow!.id}`).expect(400);
    });

    it('revokes a pending project invitation', async () => {
      const ctx = await setup();
      const { owner, w, shared } = ctx;
      const email = 'revoked@test.dev';
      const sent = (await owner.post(`${w}/projects/${shared.id}/invites`, { email }).expect(201)).body;
      await owner.post(`${w}/projects/${shared.id}/invites/${sent.link.invite.id}/resend`).expect(200);
      await owner.delete(`${w}/projects/${shared.id}/invites/${sent.link.invite.id}`).expect(204);
      const share = (await owner.get(`${w}/projects/${shared.id}/share`).expect(200)).body;
      expect(share.invites).toEqual([]);
    });

    it('promoting a guest to a member is a role change and opens every project', async () => {
      const ctx = await setup();
      const { owner, w, shared, secretTask } = ctx;
      const guest = await guestOn(ctx, shared.id);
      const row = await membershipOf(ctx, guest.id);
      await owner.patch(`${w}/members/${row!.id}`, { role: 'member', access: null }).expect(200);
      await guest.client.get(`${w}/tasks/${secretTask.key}`).expect(200);
      expect((await guest.client.get(`${w}/projects`).expect(200)).body).toHaveLength(2);
    });

    it('a guest invited without any project (role guest, no access list) sees nothing', async () => {
      const ctx = await setup();
      const { owner, w } = ctx;
      const lost = await Client.signup(server, 'No Projects');
      await owner.post(`${w}/members`, { email: lost.email, role: 'guest' }).expect(201);
      const snapshot = (await lost.client.get(`${w}/snapshot`).expect(200)).body;
      expect(snapshot.projects).toEqual([]);
      expect(snapshot.issues).toEqual([]);
    });
  });

  describe('organizer', () => {
    async function organizerOn(ctx: Awaited<ReturnType<typeof setup>>) {
      const person = await Client.signup(server, 'Pat Organizer');
      await ctx.owner.post(`${ctx.w}/members`, { email: person.email, role: 'organizer' }).expect(201);
      return person.client;
    }

    it('manages projects, milestones, tasks and shares a project', async () => {
      const ctx = await setup();
      const { w, shared } = ctx;
      const organizer = await organizerOn(ctx);
      const project = (await organizer.post(`${w}/projects`, { name: 'PM project' }).expect(201)).body;
      await organizer.patch(`${w}/projects/${project.id}`, { summary: 'planned' }).expect(200);
      await organizer.post(`${w}/milestones`, { projectId: project.id, name: 'Kickoff' }).expect(201);
      const task = (await organizer.post(`${w}/tasks`, { kind: 'feature', title: 'Plan it', projectId: project.id }).expect(201)).body;
      await organizer.delete(`${w}/tasks/${task.key}`).expect(204);

      const client = await Client.signup(server, 'Client');
      const res = (await organizer.post(`${w}/projects/${shared.id}/invites`, { email: client.email }).expect(201)).body;
      expect(res.status).toBe('invited');
      await client.client.post(`/api/invites/${tokenOf(res.link.url)}/accept`).expect(200);
      // the owner and the organizer see every project; the client is the guest
      expect((await organizer.get(`${w}/projects/${shared.id}/share`).expect(200)).body.members).toHaveLength(3);
    });

    it('cannot open settings, integrations, members, tokens or roles', async () => {
      const ctx = await setup();
      const { w } = ctx;
      const organizer = await organizerOn(ctx);
      await organizer.patch(`${w}/settings`, { estimateScale: 'linear' }).expect(403);
      await organizer.patch(w, { name: 'Renamed' }).expect(403);
      await organizer.get(`${w}/integrations`).expect(403);
      await organizer.get(`${w}/outgoing-webhooks`).expect(403);
      await organizer.get(`${w}/invites`).expect(403);
      await organizer.post(`${w}/invites`, { email: 'x@test.dev', role: 'viewer' }).expect(403);
      await organizer.post(`${w}/members`, { email: 'x@test.dev', role: 'viewer' }).expect(403);
      await organizer.post(`${w}/tokens`, { name: 'nope' }).expect(403);
      await organizer.post(`${w}/agents`, { name: 'Bot', provider: 'codex' }).expect(403);
      await organizer.patch(`${w}/roles/organizer`, { capabilities: ['manageIntegrations'] }).expect(403);
      await organizer.patch(`${w}/statuses/issue/todo`, { name: 'Renamed' }).expect(403);
    });

    it('a plain member cannot share a project unless a role gives them the permission', async () => {
      const ctx = await setup();
      const { owner, w, shared } = ctx;
      const member = await Client.signup(server, 'Plain Member');
      await owner.post(`${w}/members`, { email: member.email, role: 'member' }).expect(201);
      await member.client.post(`${w}/projects/${shared.id}/invites`, { email: 'client@test.dev' }).expect(403);
      await member.client.get(`${w}/projects/${shared.id}/share`).expect(403);
      const caps = ((await owner.get(w).expect(200)).body.settings.roles as { id: string; capabilities: string[] }[]).find(
        (role) => role.id === 'member',
      )!.capabilities;
      await owner.patch(`${w}/roles/member`, { capabilities: [...caps, 'inviteToProject'] }).expect(200);
      await member.client.post(`${w}/projects/${shared.id}/invites`, { email: 'client@test.dev' }).expect(201);
    });
  });
});
