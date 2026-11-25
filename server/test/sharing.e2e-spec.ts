import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

interface WorkspaceJson {
  id: string;
  slug: string;
  name: string;
  role: string;
  personal?: boolean;
  primaryOwnerId?: string;
  settings: { labels: { id: string; name: string }[] };
}

interface SharedJson {
  id: string;
  name: string;
  workspace: { id: string; slug: string; name: string };
  role: string;
  placement?: { projectId: string; workspaceId: string | null; position: number };
}

describe('personal workspaces, Shared with me and project transfer', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  const workspacesOf = async (c: Client) => (await c.get('/api/workspaces').expect(200)).body as WorkspaceJson[];
  const personalOf = async (c: Client) => (await workspacesOf(c)).find((w) => w.personal) as WorkspaceJson;
  const sharedOf = async (c: Client) => (await c.get('/api/shared/projects').expect(200)).body as SharedJson[];

  /** Limit a member to some projects: the shape a guest has. */
  async function limit(owner: Client, slug: string, membershipId: string, projectIds: string[]) {
    await owner
      .patch(`/api/w/${slug}/members/${membershipId}`, {
        access: { projects: { all: false, projectIds }, includeUnassigned: false, grants: [] },
      })
      .expect(200);
  }

  async function addMember(owner: Client, slug: string, email: string, role: string): Promise<string> {
    return (await owner.post(`/api/w/${slug}/members`, { email, role }).expect(201)).body.id as string;
  }

  describe('personal workspace', () => {
    it('sign-up creates one, named after the person, with a free and unreserved slug', async () => {
      const ada = await Client.signup(server, 'Ada Lovelace');
      const mine = await workspacesOf(ada.client);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ name: 'Ada Lovelace', personal: true, role: 'owner', primaryOwnerId: ada.user.id });
      expect(mine[0].slug).toMatch(/^ada-lovelace/);

      const namesake = await Client.signup(server, 'Ada Lovelace');
      const other = await personalOf(namesake.client);
      expect(other.slug).not.toBe(mine[0].slug);
      expect(other.slug).toMatch(/^ada-lovelace-\d+$/);

      const reserved = await Client.signup(server, 'Admin');
      const reservedWs = await personalOf(reserved.client);
      expect(reservedWs.slug).not.toBe('admin');
      expect(reservedWs.slug).toMatch(/^admin-ws/);
    });

    it('can be renamed, but not left, deleted or handed over', async () => {
      const solo = await Client.signup(server, 'Solo Dev');
      const ws = await personalOf(solo.client);
      const w = `/api/w/${ws.slug}`;

      const renamed = (await solo.client.patch(w, { name: 'Solo Studio' }).expect(200)).body;
      expect(renamed).toMatchObject({ name: 'Solo Studio', personal: true });

      const members = (await solo.client.get(`${w}/members`).expect(200)).body as { id: string; userId: string }[];
      const mine = members.find((m) => m.userId === solo.user.id)!;
      await solo.client.delete(`${w}/members/${mine.id}`).expect(409);
      await solo.client.delete(w, { confirm: ws.slug }).expect(409);

      const friend = await Client.signup(server, 'Friend');
      const friendMembership = await addMember(solo.client, ws.slug, friend.email, 'admin');
      await solo.client.post(`${w}/transfer-ownership`, { membershipId: friendMembership }).expect(409);
      // still there, still theirs
      expect((await solo.client.get(w).expect(200)).body).toMatchObject({ personal: true, primaryOwnerId: solo.user.id });
      expect((await friend.client.get(w).expect(200)).body.role).toBe('admin');
    });

    it('is one of the account workspaces next to the ones the person creates', async () => {
      const dev = await Client.signup(server, 'Two Homes');
      await dev.client.post('/api/workspaces', { name: 'Side Company' }).expect(201);
      const mine = await workspacesOf(dev.client);
      expect(mine).toHaveLength(2);
      expect(mine.filter((w) => w.personal)).toHaveLength(1);
    });
  });

  describe('Shared with me and Show in', () => {
    async function scene() {
      const owner = await Client.signup(server, 'Sharer');
      const ws = (await owner.client.post('/api/workspaces', { name: 'Studio' }).expect(201)).body as WorkspaceJson;
      const w = `/api/w/${ws.slug}`;
      const shared = (await owner.client.post(`${w}/projects`, { name: 'Brand refresh' }).expect(201)).body;
      const hidden = (await owner.client.post(`${w}/projects`, { name: 'Internal only' }).expect(201)).body;
      const gina = await Client.signup(server, 'Guest Gina');
      await limit(owner.client, ws.slug, await addMember(owner.client, ws.slug, gina.email, 'viewer'), [shared.id]);
      return { owner, ws, w, shared, hidden, gina };
    }

    it('lists the projects a person reaches as a guest, with the workspace that owns them', async () => {
      const { owner, ws, shared, gina } = await scene();
      const list = await sharedOf(gina.client);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: shared.id,
        name: 'Brand refresh',
        role: 'viewer',
        workspace: { id: ws.id, slug: ws.slug, name: 'Studio' },
      });
      expect(list[0].placement).toBeUndefined();
      // the workspace's own people are not guests, and a person's own workspace never shows up here
      expect(await sharedOf(owner.client)).toEqual([]);
      const colleague = await Client.signup(server, 'Full Member');
      await addMember(owner.client, ws.slug, colleague.email, 'member');
      expect(await sharedOf(colleague.client)).toEqual([]);
    });

    it('places a shared project in one of my workspaces without giving anybody access', async () => {
      const { w, shared, hidden, gina } = await scene();
      const home = await personalOf(gina.client);
      const placed = (await gina.client.put(`/api/shared/projects/${shared.id}/placement`, { workspaceId: home.id }).expect(200)).body;
      expect(placed).toEqual({ projectId: shared.id, workspaceId: home.id, position: 0 });
      expect((await sharedOf(gina.client))[0].placement).toEqual(placed);

      // somebody else in the workspace she placed it in gets nothing out of it
      const mallory = await Client.signup(server, 'Mallory');
      await addMember(gina.client, home.slug, mallory.email, 'member');
      expect(await sharedOf(mallory.client)).toEqual([]);
      expect((await mallory.client.get(`/api/w/${home.slug}/projects`).expect(200)).body).toEqual([]);
      await mallory.client.get(`/api/w/${home.slug}/projects/${shared.id}`).expect(404);
      await mallory.client.get(`${w}/projects/${shared.id}`).expect(404);
      await mallory.client.get(`${w}/snapshot`).expect(404);
      const snapshot = (await mallory.client.get(`/api/w/${home.slug}/snapshot`).expect(200)).body;
      expect(snapshot.projects).toEqual([]);

      // reading the project still goes through its own workspace, and only the shared project
      await gina.client.get(`${w}/projects/${shared.id}`).expect(200);
      await gina.client.get(`${w}/projects/${hidden.id}`).expect(404);
    });

    it('keeps placements per person', async () => {
      const { owner, ws, shared, gina } = await scene();
      const hugo = await Client.signup(server, 'Guest Hugo');
      await limit(owner.client, ws.slug, await addMember(owner.client, ws.slug, hugo.email, 'viewer'), [shared.id]);
      const ginaHome = await personalOf(gina.client);
      await gina.client.put(`/api/shared/projects/${shared.id}/placement`, { workspaceId: ginaHome.id }).expect(200);
      expect((await sharedOf(gina.client))[0].placement?.workspaceId).toBe(ginaHome.id);
      expect((await sharedOf(hugo.client))[0].placement).toBeUndefined();
      // Hugo cannot place it into Gina's workspace: he does not belong there
      await hugo.client.put(`/api/shared/projects/${shared.id}/placement`, { workspaceId: ginaHome.id }).expect(404);
      // and clearing hers does not touch his
      const hugoHome = await personalOf(hugo.client);
      await hugo.client.put(`/api/shared/projects/${shared.id}/placement`, { workspaceId: hugoHome.id }).expect(200);
      await gina.client.delete(`/api/shared/projects/${shared.id}/placement`).expect(204);
      expect((await sharedOf(gina.client))[0].placement).toBeUndefined();
      expect((await sharedOf(hugo.client))[0].placement?.workspaceId).toBe(hugoHome.id);
    });

    it('only places what is shared, into workspaces the person belongs to', async () => {
      const { owner, ws, shared, hidden, gina } = await scene();
      const home = await personalOf(gina.client);
      const put = (projectId: string, body: object) => gina.client.put(`/api/shared/projects/${projectId}/placement`, body);
      await put(hidden.id, { workspaceId: home.id }).expect(404); // not shared with her
      await put('pj_missing', { workspaceId: home.id }).expect(404);
      await put(shared.id, { workspaceId: ws.id }).expect(400); // it already lives there
      const stranger = await Client.signup(server, 'Stranger');
      await put(shared.id, { workspaceId: (await personalOf(stranger.client)).id }).expect(404);
      await put(shared.id, {}).expect(400);
      await put(shared.id, { workspaceId: home.id, position: -1 }).expect(400);
      // the owner reaches the project as a member, not as a guest: nothing to place or hide
      await owner.client.put(`/api/shared/projects/${shared.id}/placement`, { workspaceId: (await personalOf(owner.client)).id }).expect(404);
      await owner.client.put(`/api/shared/projects/${shared.id}/placement`, { workspaceId: null }).expect(404);
    });

    it('hides a project from Shared with me, brings it back, and lets a guest leave', async () => {
      const { w, shared, gina } = await scene();
      const hidden = (await gina.client.put(`/api/shared/projects/${shared.id}/placement`, { workspaceId: null }).expect(200)).body;
      expect(hidden).toEqual({ projectId: shared.id, workspaceId: null, position: 0 });
      expect((await sharedOf(gina.client))[0].placement).toEqual(hidden);
      await gina.client.delete(`/api/shared/projects/${shared.id}/placement`).expect(204);
      expect((await sharedOf(gina.client))[0].placement).toBeUndefined();

      await gina.client.post(`/api/shared/projects/${shared.id}/leave`).expect(204);
      expect(await sharedOf(gina.client)).toEqual([]);
      await gina.client.get(`${w}/projects/${shared.id}`).expect(404);
      await gina.client.post(`/api/shared/projects/${shared.id}/leave`).expect(404);
    });

    it('is an account route: a browser session only, never an API token', async () => {
      const { owner, ws } = await scene();
      const minted = (await owner.client.post(`/api/w/${ws.slug}/tokens`, { name: 'cli', scope: 'admin' }).expect(201)).body;
      await new TokenClient(server, minted.secret).get('/api/shared/projects').expect(403);
    });
  });

  describe('project transfer', () => {
    async function scene() {
      const owner = await Client.signup(server, 'Mover');
      const source = (await owner.client.post('/api/workspaces', { name: 'Transfer Source' }).expect(201)).body as WorkspaceJson;
      const target = (await owner.client.post('/api/workspaces', { name: 'Transfer Target' }).expect(201)).body as WorkspaceJson;
      const s = `/api/w/${source.slug}`;
      const t = `/api/w/${target.slug}`;

      // labels: one the target already has (other casing), one it does not
      const bug = (await owner.client.post(`${s}/labels`, { name: 'Bug', scope: 'issue' }).expect(201)).body.settings.labels.find(
        (l: { name: string }) => l.name === 'Bug',
      );
      const design = (await owner.client.post(`${s}/labels`, { name: 'Needs design', scope: 'issue', color: '#7c3aed' }).expect(201)).body.settings.labels.find(
        (l: { name: string }) => l.name === 'Needs design',
      );
      const targetBug = (await owner.client.post(`${t}/labels`, { name: 'bug', scope: 'issue' }).expect(201)).body.settings.labels.find(
        (l: { name: string }) => l.name === 'bug',
      );
      await owner.client.patch(`${t}/statuses/issue/in_progress`, { name: 'Doing' }).expect(200);

      const project = (await owner.client.post(`${s}/projects`, { name: 'Checkout', status: 'in_progress' }).expect(201)).body;
      const milestone = (await owner.client.post(`${s}/milestones`, { projectId: project.id, name: 'Beta' }).expect(201)).body;

      const lost = await Client.signup(server, 'Left Behind');
      await addMember(owner.client, source.slug, lost.email, 'member');
      const first = (
        await owner.client
          .post(`${s}/tasks`, {
            kind: 'feature',
            title: 'Parent task',
            projectId: project.id,
            status: 'in_progress',
            labels: [bug.id],
            assigneeId: owner.user.id,
          })
          .expect(201)
      ).body;
      const second = (
        await owner.client
          .post(`${s}/tasks`, {
            kind: 'bug',
            title: 'Child task',
            projectId: project.id,
            parentId: first.id,
            labels: [bug.id, design.id],
            assigneeId: lost.user.id,
          })
          .expect(201)
      ).body;
      await owner.client.patch(`${s}/tasks/${second.key}`, { milestoneIds: [milestone.id] }).expect(200);
      const now = Date.now();
      await owner.client
        .post(`${s}/time-entries`, {
          issueId: first.id,
          startedAt: new Date(now - 3_600_000).toISOString(),
          endedAt: new Date(now).toISOString(),
        })
        .expect(201);

      const guest = await Client.signup(server, 'Project Guest');
      await limit(owner.client, source.slug, await addMember(owner.client, source.slug, guest.email, 'viewer'), [project.id]);

      return { owner, source, target, s, t, project, milestone, first, second, bug, design, targetBug, guest, lost };
    }

    it('previews and then moves the project with its issues, guests and history', async () => {
      const { owner, source, target, s, t, project, milestone, first, second, targetBug, guest } = await scene();

      const preview = (await owner.client.get(`${s}/projects/${project.id}/transfer-preview?target=${target.slug}`).expect(200)).body;
      expect(preview).toMatchObject({
        project: { id: project.id, key: project.key },
        target: { slug: target.slug },
        counts: { issues: 2, milestones: 1, timeEntries: 1 },
        unassigned: 1,
        blockers: [],
      });
      expect(preview.mappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'label', from: 'Bug', to: 'bug', action: 'map', count: 2 }),
          expect.objectContaining({ kind: 'label', from: 'Needs design', to: 'Needs design', action: 'create', count: 1 }),
          expect.objectContaining({ kind: 'issue', from: 'In Progress', to: 'Doing' }),
        ]),
      );
      expect(preview.guests).toEqual([expect.objectContaining({ name: 'Project Guest', action: 'add', role: 'viewer' })]);
      // a preview changes nothing
      await owner.client.get(`${s}/projects/${project.id}`).expect(200);
      await owner.client.get(`${t}/projects/${project.id}`).expect(404);

      const done = (await owner.client.post(`${s}/projects/${project.id}/transfer`, { target: target.slug }).expect(200)).body;
      expect(done).toMatchObject({
        project: { id: project.id, key: project.key, workspaceId: target.id },
        target: { slug: target.slug },
        counts: { issues: 2, milestones: 1, timeEntries: 1 },
        unassigned: 1,
      });

      // gone from the source, whole in the target
      await owner.client.get(`${s}/projects/${project.id}`).expect(404);
      await owner.client.get(`${s}/tasks/${first.key}`).expect(404);
      const moved = (await owner.client.get(`${t}/projects/${project.id}`).expect(200)).body;
      expect(moved).toMatchObject({ key: project.key, status: 'in_progress' });

      // issue keys, parent links and the milestone survive; labels and statuses are the target's
      const parent = (await owner.client.get(`${t}/tasks/${first.key}`).expect(200)).body;
      const child = (await owner.client.get(`${t}/tasks/${second.key}`).expect(200)).body;
      expect(parent).toMatchObject({ key: first.key, status: 'in_progress', assigneeId: owner.user.id });
      expect(parent.labels).toEqual([targetBug.id]);
      expect(child).toMatchObject({ key: second.key, parentId: first.id, milestoneIds: [milestone.id] });
      const targetLabels = (await owner.client.get(t).expect(200)).body.settings.labels as { id: string; name: string }[];
      expect(child.labels).toEqual([targetBug.id, targetLabels.find((l) => l.name === 'Needs design')!.id]);
      // someone who is not in the target no longer holds the task
      expect(child.assigneeId).toBeUndefined();
      expect((await owner.client.get(`${t}/milestones?projectId=${project.id}`).expect(200)).body).toHaveLength(1);
      expect((await owner.client.get(`${s}/milestones`).expect(200)).body).toEqual([]);
      expect((await owner.client.get(`${t}/time-entries`).expect(200)).body).toHaveLength(1);
      expect((await owner.client.get(`${s}/time-entries`).expect(200)).body).toEqual([]);
      const events = (await owner.client.get(`${t}/events?type=project.transferred`).expect(200)).body as unknown[];
      expect(events).toHaveLength(1);

      // the next issue continues the project's numbering
      const next = (await owner.client.post(`${t}/tasks`, { kind: 'bug', title: 'After the move', projectId: project.id }).expect(201)).body;
      expect(next.key).toBe(`${project.key}-3`);

      // guests come along as limited members of the target, and Shared with me follows
      const list = await sharedOf(guest.client);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: project.id, workspace: { slug: target.slug } });
      await guest.client.get(`/api/w/${target.slug}/projects/${project.id}`).expect(200);
      await guest.client.get(`${s}/projects/${project.id}`).expect(404);
      const members = (await owner.client.get(`${t}/members`).expect(200)).body as {
        userId: string;
        access?: { projects: { all: boolean; projectIds: string[] } };
      }[];
      const carried = members.find((m) => m.userId === guest.user.id)!;
      expect(carried.access?.projects).toEqual({ all: false, projectIds: [project.id] });
      void source;
    });

    it('needs owner or admin rights on both workspaces', async () => {
      const { owner, source, target, s, project } = await scene();
      const go = (c: Client, slug: string) => c.post(`${s}/projects/${project.id}/transfer`, { target: slug });
      const peek = (c: Client, slug: string) => c.get(`${s}/projects/${project.id}/transfer-preview?target=${slug}`);

      // an admin of the source who does not belong to the target cannot even see that it exists
      const admin = await Client.signup(server, 'Source Admin');
      await addMember(owner.client, source.slug, admin.email, 'admin');
      await go(admin.client, target.slug).expect(404);
      await peek(admin.client, target.slug).expect(404);

      // a plain member of the source cannot move projects at all
      const member = await Client.signup(server, 'Source Member');
      await addMember(owner.client, source.slug, member.email, 'member');
      await go(member.client, target.slug).expect(403);

      // an admin of the source who is only a member of the target is refused
      const boss = await Client.signup(server, 'Other Boss');
      const other = (await boss.client.post('/api/workspaces', { name: 'Elsewhere' }).expect(201)).body as WorkspaceJson;
      await addMember(boss.client, other.slug, admin.email, 'member');
      await go(admin.client, other.slug).expect(403);
      await peek(admin.client, other.slug).expect(403);

      // being admin on both is enough
      await boss.client.patch(`/api/w/${other.slug}/members/${await membershipOf(boss.client, other.slug, admin.user.id)}`, { role: 'admin' }).expect(200);
      expect((await peek(admin.client, other.slug).expect(200)).body.target.slug).toBe(other.slug);

      // unknown or identical targets, and an API token
      await go(owner.client, 'no-such-workspace').expect(404);
      await go(owner.client, source.slug).expect(400);
      const minted = (await owner.client.post(`${s}/tokens`, { name: 'cli', scope: 'admin' }).expect(201)).body;
      await new TokenClient(server, minted.secret).post(`${s}/projects/${project.id}/transfer`, { target: target.slug }).expect(403);
      await owner.client.get(`${s}/projects/${project.id}`).expect(200);
    });

    async function membershipOf(c: Client, slug: string, userId: string): Promise<string> {
      const members = (await c.get(`/api/w/${slug}/members`).expect(200)).body as { id: string; userId: string }[];
      return members.find((m) => m.userId === userId)!.id;
    }

    it('refuses to move a project whose tag the target already uses, and moves nothing', async () => {
      const { owner, target, s, t } = await scene();
      const clash = (await owner.client.post(`${s}/projects`, { name: 'Clash', key: 'CLSH' }).expect(201)).body;
      const task = (await owner.client.post(`${s}/tasks`, { kind: 'bug', title: 'Stays put', projectId: clash.id }).expect(201)).body;
      await owner.client.post(`${t}/projects`, { name: 'Already here', key: 'CLSH' }).expect(201);

      const preview = (await owner.client.get(`${s}/projects/${clash.id}/transfer-preview?target=${target.slug}`).expect(200)).body;
      expect(preview.blockers).toHaveLength(1);
      await owner.client.post(`${s}/projects/${clash.id}/transfer`, { target: target.slug }).expect(409);
      await owner.client.get(`${s}/projects/${clash.id}`).expect(200);
      expect((await owner.client.get(`${s}/tasks/${task.key}`).expect(200)).body.projectId).toBe(clash.id);
    });

    it('a placement made before the move keeps working without granting anything', async () => {
      const { owner, source, target, s, project, guest } = await scene();
      const home = await personalOf(guest.client);
      await guest.client.put(`/api/shared/projects/${project.id}/placement`, { workspaceId: home.id }).expect(200);
      await owner.client.post(`${s}/projects/${project.id}/transfer`, { target: target.slug }).expect(200);
      const list = await sharedOf(guest.client);
      expect(list[0]).toMatchObject({ workspace: { slug: target.slug }, placement: { workspaceId: home.id } });
      void source;
    });
  });
});
