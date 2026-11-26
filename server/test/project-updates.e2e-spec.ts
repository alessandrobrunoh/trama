import type { INestApplication } from '@nestjs/common';
import { PROJECT_UPDATE_BODY_MAX } from '../src/contracts/domain.js';
import { Client, TokenClient, createTestApp } from './app.js';

interface UpdateJson {
  id: string;
  workspaceId: string;
  projectId: string;
  author: { type: string; id: string };
  body: string;
  health?: string;
  createdAt: string;
  editedAt?: string;
}

const tokenOf = (url: string): string => url.split('/invite/')[1];

describe('project updates', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  /** A workspace with two projects and an owner. */
  async function setup() {
    const owner = await Client.signup(server, 'Olivia Owner');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Updates Co' }).expect(201)).body;
    const w = `/api/w/${ws.slug as string}`;
    const alpha = (await owner.client.post(`${w}/projects`, { name: 'Alpha' }).expect(201)).body;
    const beta = (await owner.client.post(`${w}/projects`, { name: 'Beta' }).expect(201)).body;
    return { owner: owner.client, ownerId: owner.user.id, ws, w, alpha, beta };
  }
  type Scene = Awaited<ReturnType<typeof setup>>;

  async function addMember(ctx: Scene, name: string, role: string) {
    const person = await Client.signup(server, name);
    await ctx.owner.post(`${ctx.w}/members`, { email: person.email, role }).expect(201);
    return { client: person.client, id: person.user.id };
  }

  /** A member whose access is narrowed to the given projects. */
  async function limitedMember(ctx: Scene, name: string, projectIds: string[]) {
    const person = await addMember(ctx, name, 'member');
    const rows = (await ctx.owner.get(`${ctx.w}/members`).expect(200)).body as { id: string; userId: string }[];
    const row = rows.find((r) => r.userId === person.id)!;
    await ctx.owner
      .patch(`${ctx.w}/members/${row.id}`, {
        access: { projects: { all: false, projectIds }, includeUnassigned: false, grants: [] },
      })
      .expect(200);
    return person;
  }

  async function guestOn(ctx: Scene, projectId: string) {
    const person = await Client.signup(server, 'Gina Guest');
    const res = (await ctx.owner.post(`${ctx.w}/projects/${projectId}/invites`, { email: person.email }).expect(201)).body;
    await person.client.post(`/api/invites/${tokenOf(res.link.url)}/accept`).expect(200);
    return { client: person.client, id: person.user.id };
  }

  it('a member posts and lists updates, newest first', async () => {
    const ctx = await setup();
    const { w, alpha } = ctx;
    const member = await addMember(ctx, 'Maya Member', 'member');
    const url = `${w}/projects/${alpha.id}/updates`;

    expect((await member.client.get(url).expect(200)).body).toEqual([]);
    const first = (await member.client.post(url, { body: '  Kicked off the work \n' }).expect(201)).body as UpdateJson;
    expect(first).toMatchObject({
      workspaceId: alpha.workspaceId,
      projectId: alpha.id,
      author: { type: 'user', id: member.id },
      body: 'Kicked off the work',
    });
    expect(first.id).toMatch(/^pu_/);
    expect(first.health).toBeUndefined();
    expect(first.editedAt).toBeUndefined();
    expect(new Date(first.createdAt).getTime()).not.toBeNaN();
    const second = (await ctx.owner.post(url, { body: 'Second update' }).expect(201)).body as UpdateJson;

    const listed = (await member.client.get(url).expect(200)).body as UpdateJson[];
    expect(listed.map((u) => u.id)).toEqual([second.id, first.id]);
    // another project has its own list
    expect((await ctx.owner.get(`${w}/projects/${ctx.beta.id}/updates`).expect(200)).body).toEqual([]);

    const events = (await ctx.owner.get(`${w}/events?type=project.update_posted`).expect(200)).body as {
      subject: { type: string; id: string };
      data: { updateId: string };
    }[];
    expect(events.map((e) => e.data.updateId).sort()).toEqual([first.id, second.id].sort());
    expect(events[0].subject).toEqual({ type: 'project', id: alpha.id });
  });

  it('a project the caller cannot see is a 404 for every route', async () => {
    const ctx = await setup();
    const { w, alpha, beta } = ctx;
    const insider = await limitedMember(ctx, 'Ivan Insider', [beta.id]);
    const posted = (await ctx.owner.post(`${w}/projects/${alpha.id}/updates`, { body: 'Alpha only' }).expect(201)).body as UpdateJson;
    const url = `${w}/projects/${alpha.id}/updates`;

    await insider.client.get(`${w}/projects/${alpha.id}`).expect(404);
    await insider.client.get(url).expect(404);
    await insider.client.post(url, { body: 'Sneaking in' }).expect(404);
    await insider.client.patch(`${url}/${posted.id}`, { body: 'Edited' }).expect(404);
    await insider.client.delete(`${url}/${posted.id}`).expect(404);
    // their own project works
    await insider.client.post(`${w}/projects/${beta.id}/updates`, { body: 'Beta news' }).expect(201);
    // and nothing happened to the hidden one
    const left = (await ctx.owner.get(url).expect(200)).body as UpdateJson[];
    expect(left).toHaveLength(1);
    expect(left[0].body).toBe('Alpha only');
  });

  it('a guest on the project can read but not post, edit or delete', async () => {
    const ctx = await setup();
    const { w, alpha, beta } = ctx;
    const guest = await guestOn(ctx, alpha.id);
    const url = `${w}/projects/${alpha.id}/updates`;
    const posted = (await ctx.owner.post(url, { body: 'Visible to the guest' }).expect(201)).body as UpdateJson;

    const seen = (await guest.client.get(url).expect(200)).body as UpdateJson[];
    expect(seen.map((u) => u.id)).toEqual([posted.id]);
    await guest.client.post(url, { body: 'Guest post' }).expect(403);
    await guest.client.patch(`${url}/${posted.id}`, { body: 'Guest edit' }).expect(403);
    await guest.client.delete(`${url}/${posted.id}`).expect(403);
    // another project of the workspace is not theirs
    await guest.client.get(`${w}/projects/${beta.id}/updates`).expect(404);
    expect((await ctx.owner.get(url).expect(200)).body).toHaveLength(1);
  });

  it('a viewer reads but cannot post', async () => {
    const ctx = await setup();
    const { w, alpha } = ctx;
    const viewer = await addMember(ctx, 'Vic Viewer', 'viewer');
    const url = `${w}/projects/${alpha.id}/updates`;
    await ctx.owner.post(url, { body: 'News' }).expect(201);

    expect((await viewer.client.get(url).expect(200)).body).toHaveLength(1);
    await viewer.client.post(url, { body: 'Nope' }).expect(403);
  });

  it('only the author edits; editing sets editedAt and leaves the project health alone', async () => {
    const ctx = await setup();
    const { w, alpha } = ctx;
    const author = await addMember(ctx, 'Ada Author', 'member');
    const other = await addMember(ctx, 'Otto Other', 'member');
    const url = `${w}/projects/${alpha.id}/updates`;
    const posted = (await author.client.post(url, { body: 'First draft', health: 'on_track' }).expect(201)).body as UpdateJson;
    expect(posted.health).toBe('on_track');

    await other.client.patch(`${url}/${posted.id}`, { body: 'Hijacked' }).expect(403);
    await ctx.owner.patch(`${url}/${posted.id}`, { body: 'Even the owner cannot' }).expect(403);

    const edited = (await author.client.patch(`${url}/${posted.id}`, { body: '  Final text ', health: 'off_track' }).expect(200)).body as UpdateJson;
    expect(edited).toMatchObject({ id: posted.id, body: 'Final text', health: 'off_track', author: { id: author.id } });
    expect(edited.editedAt).toBeTruthy();
    expect(edited.createdAt).toBe(posted.createdAt);

    // editing the health of the update does not move the project's health: only posting does
    expect((await ctx.owner.get(`${w}/projects/${alpha.id}`).expect(200)).body.health).toBe('on_track');

    const cleared = (await author.client.patch(`${url}/${posted.id}`, { health: null }).expect(200)).body as UpdateJson;
    expect(cleared.health).toBeUndefined();
    await author.client.patch(`${url}/${posted.id}`, { health: 'great' }).expect(400);
    await author.client.patch(`${url}/${posted.id}`, { body: '' }).expect(400);
    await author.client.patch(`${url}/${posted.id}`, { body: null }).expect(400);
    await author.client.patch(`${url}/upd_missing`, { body: 'x' }).expect(404);
    await ctx.owner.patch(`${w}/projects/${ctx.beta.id}/updates/${posted.id}`, { body: 'x' }).expect(404);

    const [listed] = (await author.client.get(url).expect(200)).body as UpdateJson[];
    expect(listed.body).toBe('Final text');
  });

  it('the author or a project manager deletes an update', async () => {
    const ctx = await setup();
    const { w, alpha } = ctx;
    const author = await addMember(ctx, 'Ada Author', 'member');
    const viewer = await addMember(ctx, 'Vic Viewer', 'viewer');
    const url = `${w}/projects/${alpha.id}/updates`;

    const own = (await author.client.post(url, { body: 'Mine' }).expect(201)).body as UpdateJson;
    await author.client.delete(`${url}/${own.id}`).expect(204);
    await author.client.delete(`${url}/${own.id}`).expect(404);

    const theirs = (await author.client.post(url, { body: 'Moderated' }).expect(201)).body as UpdateJson;
    await viewer.client.delete(`${url}/${theirs.id}`).expect(403);
    const manager = await addMember(ctx, 'Mia Manager', 'member');
    await manager.client.delete(`${url}/${theirs.id}`).expect(204);
    expect((await ctx.owner.get(url).expect(200)).body).toEqual([]);
  });

  it('posting with a health sets the project health, with the usual project events', async () => {
    const ctx = await setup();
    const { w, alpha } = ctx;
    const url = `${w}/projects/${alpha.id}/updates`;
    expect((await ctx.owner.get(`${w}/projects/${alpha.id}`).expect(200)).body.health).toBeUndefined();

    const posted = (await ctx.owner.post(url, { body: 'Risky', health: 'at_risk' }).expect(201)).body as UpdateJson;
    expect(posted.health).toBe('at_risk');
    expect((await ctx.owner.get(`${w}/projects/${alpha.id}`).expect(200)).body.health).toBe('at_risk');
    const changed = (await ctx.owner.get(`${w}/events?type=project.health_changed`).expect(200)).body as {
      subject: { id: string };
      data: { from: string | null; to: string };
    }[];
    expect(changed.find((e) => e.subject.id === alpha.id)?.data).toEqual({ from: null, to: 'at_risk' });

    // an update without a health leaves the project's health as it is
    await ctx.owner.post(url, { body: 'Just words' }).expect(201);
    expect((await ctx.owner.get(`${w}/projects/${alpha.id}`).expect(200)).body.health).toBe('at_risk');

    // an unknown health is refused and writes nothing
    await ctx.owner.post(url, { body: 'Bad health', health: 'great' }).expect(400);
    await ctx.owner.post(url, { body: 'Bad health', health: 42 }).expect(400);
    expect((await ctx.owner.get(url).expect(200)).body).toHaveLength(2);
  });

  it('validates the body', async () => {
    const ctx = await setup();
    const url = `${ctx.w}/projects/${ctx.alpha.id}/updates`;

    await ctx.owner.post(url, { body: 'x'.repeat(PROJECT_UPDATE_BODY_MAX + 1) }).expect(400);
    await ctx.owner.post(url, { body: '   ' }).expect(400);
    await ctx.owner.post(url, { body: '' }).expect(400);
    await ctx.owner.post(url, {}).expect(400);
    await ctx.owner.post(url, { body: 12 }).expect(400);
    await ctx.owner.post(url, { body: 'x'.repeat(PROJECT_UPDATE_BODY_MAX) }).expect(201);
    expect((await ctx.owner.get(url).expect(200)).body).toHaveLength(1);
  });

  it('follows the token scopes: read may GET, write is needed to change anything', async () => {
    const ctx = await setup();
    const { w, alpha } = ctx;
    const url = `${w}/projects/${alpha.id}/updates`;
    const posted = (await ctx.owner.post(url, { body: 'News' }).expect(201)).body as UpdateJson;
    const mint = async (scope: string) =>
      new TokenClient(server, (await ctx.owner.post(`${w}/tokens`, { name: `t-${scope}`, scope }).expect(201)).body.secret);

    const read = await mint('read');
    expect((await read.get(url).expect(200)).body).toHaveLength(1);
    await read.post(url, { body: 'Read token post' }).expect(403);
    await read.patch(`${url}/${posted.id}`, { body: 'Read token edit' }).expect(403);
    await read.delete(`${url}/${posted.id}`).expect(403);

    const write = await mint('write');
    const bot = (await write.post(url, { body: 'From a token' }).expect(201)).body as UpdateJson;
    expect(bot.author.type).toBe('user');
    await write.patch(`${url}/${bot.id}`, { body: 'Edited by its author' }).expect(200);
    await write.delete(`${url}/${bot.id}`).expect(204);

    // an agent token reads and writes under its own identity
    const agent = (await ctx.owner.post(`${w}/agents`, { name: 'Status bot', provider: 'codex' }).expect(201)).body;
    const agentToken = new TokenClient(
      server,
      (await ctx.owner.post(`${w}/tokens`, { name: 'bot', agentId: agent.id, scope: 'write' }).expect(201)).body.secret,
    );
    const byAgent = (await agentToken.post(url, { body: 'Automated status' }).expect(201)).body as UpdateJson;
    expect(byAgent.author).toEqual({ type: 'agent', id: agent.id });
    await ctx.owner.patch(`${url}/${byAgent.id}`, { body: 'Not mine' }).expect(403);
    await ctx.owner.delete(`${url}/${byAgent.id}`).expect(204);
  });

  it('updates go with their project when it is deleted or transferred', async () => {
    const ctx = await setup();
    const { w, alpha, beta } = ctx;
    const target = (await ctx.owner.post('/api/workspaces', { name: 'Updates Target' }).expect(201)).body;
    const t = `/api/w/${target.slug as string}`;

    const posted = (await ctx.owner.post(`${w}/projects/${alpha.id}/updates`, { body: 'Moving house', health: 'at_risk' }).expect(201)).body as UpdateJson;
    await ctx.owner.post(`${w}/projects/${beta.id}/updates`, { body: 'Doomed' }).expect(201);

    await ctx.owner.post(`${w}/projects/${alpha.id}/transfer`, { target: target.slug }).expect(200);
    await ctx.owner.get(`${w}/projects/${alpha.id}/updates`).expect(404);
    const moved = (await ctx.owner.get(`${t}/projects/${alpha.id}/updates`).expect(200)).body as UpdateJson[];
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ id: posted.id, workspaceId: target.id, body: 'Moving house', health: 'at_risk' });

    await ctx.owner.delete(`${w}/projects/${beta.id}`).expect(204);
    await ctx.owner.get(`${w}/projects/${beta.id}/updates`).expect(404);
  });
});
