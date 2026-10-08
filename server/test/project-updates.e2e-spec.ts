import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

interface UpdateBody {
  id: string;
  projectId: string;
  health: string;
  body: string;
  aiDrafted?: boolean;
  editedAt?: string;
  author: { type: string; id: string };
  createdAt: string;
}

describe('project updates', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  /** A workspace with an owner, an admin, two members, a viewer and a project led by `lead`. */
  async function setup() {
    const owner = await Client.signup(server, 'Olivia Owner');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Updates Co' }).expect(201)).body;
    const w = `/api/w/${ws.slug}`;
    const join = async (role: 'admin' | 'member' | 'viewer', name: string) => {
      const u = await Client.signup(server, name);
      await owner.client.post(`${w}/members`, { email: u.email, role }).expect(201);
      return u;
    };
    const admin = await join('admin', 'Ada Admin');
    const lead = await join('member', 'Lea Lead');
    const member = await join('member', 'Max Member');
    const viewer = await join('viewer', 'Vic Viewer');
    const project = (await owner.client.post(`${w}/projects`, { name: 'Apollo', leadId: lead.user.id }).expect(201)).body;
    const pu = `${w}/projects/${project.id}/updates`;
    const post = (c: Client, health = 'on_track', body = 'All good') => c.post(pu, { health, body });
    const getProject = async () => (await owner.client.get(`${w}/projects/${project.id}`).expect(200)).body;
    return { owner, admin, lead, member, viewer, ws, slug: ws.slug as string, w, project, pu, post, getProject };
  }

  it('creates, lists newest-first, gets, and the newest drives Project.health and lastUpdateAt', async () => {
    const { owner, pu, post, getProject } = await setup();
    const before = await getProject();
    expect(before.health ?? null).toBeNull();
    expect(before.lastUpdateAt ?? null).toBeNull();
    expect((await owner.client.get(pu).expect(200)).body).toEqual([]);

    const u1 = (await post(owner.client, 'on_track', '  First post  ').expect(201)).body as UpdateBody;
    expect(u1.id).toMatch(/^pu_/);
    expect(u1).toMatchObject({ health: 'on_track', body: 'First post', aiDrafted: false, author: { type: 'user', id: owner.user.id } });
    expect(u1.editedAt ?? null).toBeNull();
    let p = await getProject();
    expect(p.health).toBe('on_track');
    expect(new Date(p.lastUpdateAt).getTime()).toBe(new Date(u1.createdAt).getTime());

    await new Promise((r) => setTimeout(r, 5));
    const u2 = (await owner.client.post(pu, { health: 'at_risk', body: 'Slipping', aiDrafted: true }).expect(201)).body as UpdateBody;
    expect(u2.aiDrafted).toBe(true);
    p = await getProject();
    expect(p.health).toBe('at_risk');
    expect(new Date(p.lastUpdateAt).getTime()).toBe(new Date(u2.createdAt).getTime());

    const list = (await owner.client.get(pu).expect(200)).body as UpdateBody[];
    expect(list.map((u) => u.id)).toEqual([u2.id, u1.id]);
    expect((await owner.client.get(`${pu}/${u1.id}`).expect(200)).body.body).toBe('First post');
    await owner.client.get(`${pu}/pu_missing`).expect(404);
  });

  it('editing the newest update re-syncs the project; editing an older one does not; editedAt is set', async () => {
    const { owner, pu, post, getProject } = await setup();
    const u1 = (await post(owner.client, 'on_track', 'one').expect(201)).body as UpdateBody;
    await new Promise((r) => setTimeout(r, 5));
    const u2 = (await post(owner.client, 'at_risk', 'two').expect(201)).body as UpdateBody;

    const edited = (await owner.client.patch(`${pu}/${u2.id}`, { health: 'off_track', body: 'two, worse' }).expect(200)).body as UpdateBody;
    expect(edited).toMatchObject({ health: 'off_track', body: 'two, worse' });
    expect(edited.editedAt).toBeTruthy();
    expect((await getProject()).health).toBe('off_track');

    // an older update does not drive the project
    await owner.client.patch(`${pu}/${u1.id}`, { health: 'at_risk' }).expect(200);
    expect((await getProject()).health).toBe('off_track');

    // a no-op patch leaves editedAt untouched
    const fresh = (await post(owner.client, 'on_track', 'three').expect(201)).body as UpdateBody;
    const noop = (await owner.client.patch(`${pu}/${fresh.id}`, { body: 'three', health: 'on_track' }).expect(200)).body as UpdateBody;
    expect(noop.editedAt ?? null).toBeNull();
  });

  it('deleting the newest falls back to the previous update; deleting the last one resets to null', async () => {
    const { owner, pu, post, getProject } = await setup();
    const u1 = (await post(owner.client, 'on_track', 'one').expect(201)).body as UpdateBody;
    await new Promise((r) => setTimeout(r, 5));
    const u2 = (await post(owner.client, 'off_track', 'two').expect(201)).body as UpdateBody;
    expect((await getProject()).health).toBe('off_track');

    await owner.client.delete(`${pu}/${u2.id}`).expect(204);
    let p = await getProject();
    expect(p.health).toBe('on_track');
    expect(new Date(p.lastUpdateAt).getTime()).toBe(new Date(u1.createdAt).getTime());
    await owner.client.get(`${pu}/${u2.id}`).expect(404);

    await owner.client.delete(`${pu}/${u1.id}`).expect(204);
    p = await getProject();
    expect(p.health ?? null).toBeNull();
    expect(p.lastUpdateAt ?? null).toBeNull();
    expect((await owner.client.get(pu).expect(200)).body).toEqual([]);
    await owner.client.delete(`${pu}/${u1.id}`).expect(404);
  });

  it('records domain events for create/update/delete', async () => {
    const { owner, w, pu, post } = await setup();
    const u = (await post(owner.client).expect(201)).body as UpdateBody;
    await owner.client.patch(`${pu}/${u.id}`, { body: 'changed' }).expect(200);
    await owner.client.delete(`${pu}/${u.id}`).expect(204);
    const events = (await owner.client.get(`${w}/events?subject=project_update:${u.id}`).expect(200)).body as { type: string }[];
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['project_update.created', 'project_update.updated', 'project_update.deleted']));
  });

  describe('authorization', () => {
    it('viewer cannot post, edit or delete', async () => {
      const { owner, viewer, pu, post } = await setup();
      const u = (await post(owner.client).expect(201)).body as UpdateBody;
      await post(viewer.client).expect(403);
      await viewer.client.patch(`${pu}/${u.id}`, { body: 'x' }).expect(403);
      await viewer.client.delete(`${pu}/${u.id}`).expect(403);
      // reading is fine
      await viewer.client.get(pu).expect(200);
      await viewer.client.get(`${pu}/${u.id}`).expect(200);
    });

    it('with the default permissions (manageProjects = member) a member can post, and the lead is the author of theirs', async () => {
      const { lead, member, pu, post } = await setup();
      const u = (await post(lead.client, 'on_track', 'by the lead').expect(201)).body as UpdateBody;
      expect(u.author).toEqual({ type: 'user', id: lead.user.id });
      await lead.client.patch(`${pu}/${u.id}`, { body: 'lead edit' }).expect(200);
      // members already hold manageProjects by default, so they may also edit it
      await member.client.patch(`${pu}/${u.id}`, { body: 'member edit' }).expect(200);
      await post(member.client).expect(201);
    });

    describe('with manageProjects raised to admin', () => {
      it('a non-lead member cannot post, the lead can, admin and owner can', async () => {
        const { owner, admin, lead, member, w, post } = await setup();
        await owner.client.patch(`${w}/settings`, { permissions: { manageProjects: 'admin' } }).expect(200);
        const denied = await post(member.client).expect(403);
        expect(denied.body.message).toMatch(/lead|Manage projects/);
        await post(lead.client).expect(201);
        await post(admin.client).expect(201);
        await post(owner.client).expect(201);
      });

      it('only the author or manageProjects can edit/delete', async () => {
        const { owner, admin, lead, member, w, pu, post } = await setup();
        await owner.client.patch(`${w}/settings`, { permissions: { manageProjects: 'admin' } }).expect(200);
        const leadUpdate = (await post(lead.client, 'on_track', 'lead says').expect(201)).body as UpdateBody;
        await member.client.patch(`${pu}/${leadUpdate.id}`, { body: 'nope' }).expect(403);
        await member.client.delete(`${pu}/${leadUpdate.id}`).expect(403);
        // the author can edit their own; an admin (manageProjects) can edit/delete anyone's
        await lead.client.patch(`${pu}/${leadUpdate.id}`, { body: 'lead edit' }).expect(200);
        await admin.client.patch(`${pu}/${leadUpdate.id}`, { health: 'at_risk' }).expect(200);
        await lead.client.delete(`${pu}/${leadUpdate.id}`).expect(204);

        const adminUpdate = (await post(admin.client, 'on_track', 'admin says').expect(201)).body as UpdateBody;
        await lead.client.patch(`${pu}/${adminUpdate.id}`, { body: 'nope' }).expect(403);
        await lead.client.delete(`${pu}/${adminUpdate.id}`).expect(403);
        await owner.client.delete(`${pu}/${adminUpdate.id}`).expect(204);
      });

      it('demoting the lead (changing leadId) removes their right to post', async () => {
        const { owner, lead, member, w, project, post } = await setup();
        await owner.client.patch(`${w}/settings`, { permissions: { manageProjects: 'admin' } }).expect(200);
        await post(lead.client).expect(201);
        await owner.client.patch(`${w}/projects/${project.id}`, { leadId: member.user.id }).expect(200);
        await post(lead.client).expect(403);
        await post(member.client).expect(201);
      });
    });

    it('API token: read scope cannot write, write scope can, and acts as the owner', async () => {
      const { owner, w, pu, post } = await setup();
      const mint = async (body: object) => {
        const res = (await owner.client.post(`${w}/tokens`, { name: 'k', ...body }).expect(201)).body;
        return new TokenClient(server, res.secret);
      };
      const u = (await post(owner.client).expect(201)).body as UpdateBody;
      const reader = await mint({ scope: 'read' });
      await reader.get(pu).expect(200);
      await reader.get(`${pu}/${u.id}`).expect(200);
      await reader.post(pu, { health: 'on_track', body: 'nope' }).expect(403);
      await reader.patch(`${pu}/${u.id}`, { body: 'nope' }).expect(403);
      await reader.delete(`${pu}/${u.id}`).expect(403);

      const writer = await mint({ scope: 'write' });
      const created = (await writer.post(pu, { health: 'at_risk', body: 'via token' }).expect(201)).body as UpdateBody;
      expect(created.author.type).toBe('user');
    });

    it('custom token needs projects:write to post', async () => {
      const { owner, w, pu } = await setup();
      const mint = async (permissions: string[]) => {
        const res = (await owner.client.post(`${w}/tokens`, { name: 'k', permissions }).expect(201)).body;
        return new TokenClient(server, res.secret);
      };
      const ro = await mint(['projects:read']);
      await ro.get(pu).expect(200);
      await ro.post(pu, { health: 'on_track', body: 'x' }).expect(403);
      const rw = await mint(['projects:write']);
      await rw.post(pu, { health: 'on_track', body: 'x' }).expect(201);
      const other = await mint(['issues:write']);
      await other.get(pu).expect(403);
    });
  });

  describe('validation', () => {
    it('rejects an unknown health, an empty or missing body and wrong types', async () => {
      const { owner, pu, post } = await setup();
      await post(owner.client, 'great', 'x').expect(400);
      await post(owner.client, 'on_track', '').expect(400);
      await owner.client.post(pu, { health: 'on_track' }).expect(400);
      await owner.client.post(pu, { body: 'no health' }).expect(400);
      await owner.client.post(pu, { health: 'on_track', body: 123 }).expect(400);
      await owner.client.post(pu, { health: 'on_track', body: 'x', aiDrafted: 'yes' }).expect(400);
      await owner.client.post(pu, { health: 'on_track', body: 'x'.repeat(20001) }).expect(400);
      expect((await owner.client.get(pu).expect(200)).body).toEqual([]);
    });

    it('rejects invalid patches', async () => {
      const { owner, pu, post } = await setup();
      const u = (await post(owner.client).expect(201)).body as UpdateBody;
      await owner.client.patch(`${pu}/${u.id}`, { health: 'meh' }).expect(400);
      await owner.client.patch(`${pu}/${u.id}`, { body: '' }).expect(400);
      await owner.client.patch(`${pu}/${u.id}`, { body: null }).expect(400);
      await owner.client.patch(`${pu}/${u.id}`, { health: null }).expect(400);
    });

    it('rejects a whitespace-only body', async () => {
      const { owner, post } = await setup();
      await post(owner.client, 'on_track', '   ').expect(400);
    });

    it('404 for an unknown project', async () => {
      const { owner, w } = await setup();
      await owner.client.post(`${w}/projects/pj_missing/updates`, { health: 'on_track', body: 'x' }).expect(404);
      await owner.client.get(`${w}/projects/pj_missing/updates`).expect(404);
    });
  });

  describe('workspace isolation', () => {
    it('another workspace gets 404 on the project, its updates and its slug', async () => {
      const a = await setup();
      const b = await setup();
      const u = (await a.post(a.owner.client).expect(201)).body as UpdateBody;

      // B's slug + A's ids
      const viaB = `${b.w}/projects/${a.project.id}/updates`;
      await b.owner.client.get(viaB).expect(404);
      await b.owner.client.post(viaB, { health: 'on_track', body: 'leak' }).expect(404);
      await b.owner.client.get(`${viaB}/${u.id}`).expect(404);
      await b.owner.client.patch(`${viaB}/${u.id}`, { body: 'leak' }).expect(404);
      await b.owner.client.delete(`${viaB}/${u.id}`).expect(404);
      // B's project with A's update id
      await b.owner.client.get(`${b.pu}/${u.id}`).expect(404);
      await b.owner.client.patch(`${b.pu}/${u.id}`, { body: 'leak' }).expect(404);
      await b.owner.client.delete(`${b.pu}/${u.id}`).expect(404);
      // A's slug is closed to a non-member
      await b.owner.client.get(a.pu).expect(404);
      await b.owner.client.post(a.pu, { health: 'on_track', body: 'leak' }).expect(404);

      // nothing changed in A
      expect((await a.owner.client.get(`${a.pu}/${u.id}`).expect(200)).body.body).toBe('All good');
      expect((await a.owner.client.get(a.pu).expect(200)).body).toHaveLength(1);
      expect((await b.owner.client.get(b.pu).expect(200)).body).toEqual([]);
    });

    it('a token of another workspace is rejected', async () => {
      const a = await setup();
      const b = await setup();
      const res = (await b.owner.client.post(`${b.w}/tokens`, { name: 't' }).expect(201)).body;
      const t = new TokenClient(server, res.secret);
      await t.get(a.pu).expect(404);
      await t.post(a.pu, { health: 'on_track', body: 'x' }).expect(404);
    });
  });

  describe('comments on updates', () => {
    it('accepts project_update subjects, and deleting the update removes its comments', async () => {
      const { owner, member, w, pu, post } = await setup();
      const u = (await post(owner.client).expect(201)).body as UpdateBody;
      const subject = { type: 'project_update', id: u.id };
      await member.client.post(`${w}/comments`, { subject, body: 'Thanks for the update' }).expect(201);
      const list = (await owner.client.get(`${w}/comments?subjectType=project_update&subjectId=${u.id}`).expect(200)).body as { body: string }[];
      expect(list.map((c) => c.body)).toEqual(['Thanks for the update']);

      await owner.client.delete(`${pu}/${u.id}`).expect(204);
      expect((await owner.client.get(`${w}/comments?subjectType=project_update&subjectId=${u.id}`).expect(200)).body).toEqual([]);
    });

    it('rejects comments on an unknown update and on another workspace\'s update', async () => {
      const a = await setup();
      const b = await setup();
      const u = (await a.post(a.owner.client).expect(201)).body as UpdateBody;
      const subject = { type: 'project_update', id: u.id };
      await b.owner.client.post(`${b.w}/comments`, { subject, body: 'leak' }).expect((r) => {
        if (![400, 404].includes(r.status)) throw new Error(`expected 400/404, got ${r.status}`);
      });
      await a.owner.client.post(`${a.w}/comments`, { subject: { type: 'project_update', id: 'pu_missing' }, body: 'x' }).expect((r) => {
        if (![400, 404].includes(r.status)) throw new Error(`expected 400/404, got ${r.status}`);
      });
      await a.viewer.client.post(`${a.w}/comments`, { subject, body: 'viewer' }).expect(403);
    });
  });

  it('deleting the project removes its updates', async () => {
    const { owner, w, project, pu, post } = await setup();
    const u = (await post(owner.client).expect(201)).body as UpdateBody;
    await owner.client.delete(`${w}/projects/${project.id}`).expect(204);
    await owner.client.get(pu).expect(404);
    await owner.client.get(`${pu}/${u.id}`).expect(404);
  });
});
