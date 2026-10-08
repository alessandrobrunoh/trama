import type { INestApplication } from '@nestjs/common';
import { Client, TokenClient, createTestApp } from './app.js';

const DELTA = 'https://delta.dev/t/e2e';

describe('permission policies, team roles and token scopes', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
  });
  afterAll(() => app.close());

  async function setup() {
    const owner = await Client.signup(server, 'Olivia Owner');
    const ws = (await owner.client.post('/api/workspaces', { name: 'Policy Co' }).expect(201)).body;
    const slug: string = ws.slug;
    const people = {} as Record<'admin' | 'member' | 'member2' | 'viewer', Client & { id: string }>;
    for (const [name, role] of [['admin', 'admin'], ['member', 'member'], ['member2', 'member'], ['viewer', 'viewer']] as const) {
      const u = await Client.signup(server, name);
      await owner.client.post(`/api/w/${slug}/members`, { email: u.email, role }).expect(201);
      people[name] = Object.assign(u.client, { id: u.user.id });
    }
    return { owner: owner.client, ownerId: owner.user.id, slug, w: `/api/w/${slug}`, ws, ...people };
  }

  describe('workspace permission policy', () => {
    it('exposes resolved defaults on the workspace and only owners may change them', async () => {
      const { owner, admin, member, w } = await setup();
      const ws = (await owner.get(w).expect(200)).body;
      expect(ws.settings.permissions).toMatchObject({ createTeams: 'admin', createIssues: 'member', manageIntegrations: 'admin', manageTokens: 'member' });
      expect(ws.settings).toMatchObject({ estimateScale: 'fibonacci', weekStart: 'monday', timeZone: 'auto' });

      await admin.patch(`${w}/settings`, { permissions: { createTeams: 'member' } }).expect(403);
      await member.patch(`${w}/settings`, { estimateScale: 'linear' }).expect(403);
      await owner.patch(`${w}/settings`, { permissions: { nope: 'member' } }).expect(400);
      await owner.patch(`${w}/settings`, { permissions: { createTeams: 'viewer' } }).expect(400);
      const res = (await owner.patch(`${w}/settings`, { permissions: { createTeams: 'member' } }).expect(200)).body;
      expect(res.settings.permissions.createTeams).toBe('member');
      expect(res.settings.permissions.createIssues).toBe('member');
      // partial: untouched capabilities keep their value and the snapshot carries the policy
      const snap = (await owner.get(`${w}/snapshot`).expect(200)).body;
      expect(snap.workspace.settings.permissions.createTeams).toBe('member');
    });

    it('capabilities are enforced on the routes (members can create teams once allowed; viewers never)', async () => {
      const { owner, member, viewer, w } = await setup();
      await member.post(`${w}/teams`, { name: 'Nope', key: 'NOPE' }).expect(403);
      await owner.patch(`${w}/settings`, { permissions: { createTeams: 'member' } }).expect(200);
      await member.post(`${w}/teams`, { name: 'Yes', key: 'YES' }).expect(201);
      await viewer.post(`${w}/teams`, { name: 'No', key: 'NO' }).expect(403);
      // editing / deleting teams is a separate capability
      const t = (await owner.post(`${w}/teams`, { name: 'Core', key: 'CORE' }).expect(201)).body;
      await member.patch(`${w}/teams/CORE`, { name: 'Renamed' }).expect(403);
      await member.delete(`${w}/teams/${t.id}`).expect(403);
    });

    it('can lock down issue / workstream deletion and decision acceptance', async () => {
      const { owner, admin, member, w } = await setup();
      const team = (await owner.post(`${w}/teams`, { name: 'Core', key: 'CORE' }).expect(201)).body;
      const issue = (await member.post(`${w}/issues`, { kind: 'bug', title: 'Crash' }).expect(201)).body;
      const decision = (await member.post(`${w}/decisions`, { title: 'Use X', statement: 'We use X' }).expect(201)).body;
      const ws = (await member.post(`${w}/workstreams`, { title: 'W', ownerTeamId: team.id, deltaThreadUrl: DELTA }).expect(201)).body;

      await owner.patch(`${w}/settings`, { permissions: { deleteIssues: 'admin', acceptDecisions: 'admin', deleteWorkstreams: 'owner', createIssues: 'admin' } }).expect(200);
      await member.delete(`${w}/issues/${issue.key}`).expect(403);
      await member.post(`${w}/decisions/${decision.key}/accept`).expect(403);
      await member.delete(`${w}/workstreams/${ws.key}`).expect(403);
      await member.post(`${w}/issues`, { kind: 'bug', title: 'Another' }).expect(403);
      await admin.delete(`${w}/workstreams/${ws.key}`).expect(403);
      await admin.post(`${w}/decisions/${decision.key}/accept`).expect(200);
      await admin.delete(`${w}/issues/${issue.key}`).expect(204);
      await owner.delete(`${w}/workstreams/${ws.key}`).expect(204);
    });

    it('only admins+ invite by default; invitees cannot exceed the inviter role; shared views follow manageSharedViews', async () => {
      const { owner, admin, member, w } = await setup();
      await member.post(`${w}/members`, { email: 'x@y.dev', role: 'viewer' }).expect(403);
      await owner.patch(`${w}/settings`, { permissions: { inviteMembers: 'member', manageSharedViews: 'admin' } }).expect(200);
      const other = await Client.signup(server, 'Newbie');
      await member.post(`${w}/members`, { email: other.email, role: 'admin' }).expect(403); // above own role
      await member.post(`${w}/members`, { email: other.email, role: 'viewer' }).expect(201);
      await member.post(`${w}/views`, { name: 'Mine', entity: 'issue', shared: true }).expect(403);
      await member.post(`${w}/views`, { name: 'Private', entity: 'issue' }).expect(201);
      await admin.post(`${w}/views`, { name: 'Shared', entity: 'issue', shared: true }).expect(201);
    });

    it('stores workspace customization (default team, estimate scale, week start, time zone, icon)', async () => {
      const { owner, admin, member, w } = await setup();
      const team = (await owner.post(`${w}/teams`, { name: 'Core', key: 'CORE' }).expect(201)).body;
      const res = (
        await admin
          .patch(`${w}/settings`, { defaultTeamId: team.id, estimateScale: 'tshirt', weekStart: 'sunday', timeZone: 'Europe/Rome', iconColor: '#7C3AED', iconInitial: 'pc' })
          .expect(200)
      ).body;
      expect(res.settings).toMatchObject({ defaultTeamId: team.id, estimateScale: 'tshirt', weekStart: 'sunday', timeZone: 'Europe/Rome', iconColor: '#7c3aed', iconInitial: 'PC' });
      await admin.patch(`${w}/settings`, { timeZone: 'Mars/Olympus' }).expect(400);
      await admin.patch(`${w}/settings`, { defaultTeamId: 'tm_missing' }).expect(400);
      await admin.patch(`${w}/settings`, { estimateScale: 'bananas' }).expect(400);
      expect((await admin.patch(`${w}/settings`, { estimateScale: 'exponential' }).expect(200)).body.settings.estimateScale).toBe('exponential');
      await admin.patch(`${w}/settings`, { estimateScale: 'tshirt' }).expect(200);
      expect((await member.get(w).expect(200)).body.settings.estimateScale).toBe('tshirt');
      const cleared = (await admin.patch(`${w}/settings`, { defaultTeamId: null, iconColor: null, iconInitial: '' }).expect(200)).body;
      expect(cleared.settings.defaultTeamId).toBeUndefined();
      expect(cleared.settings.iconColor).toBeUndefined();
      expect(cleared.settings.estimateScale).toBe('tshirt');
    });
  });

  describe('team roles and edit policy', () => {
    async function teamSetup() {
      const ctx = await setup();
      const { owner, member, w } = ctx;
      const team = (
        await owner.post(`${w}/teams`, { name: 'Secure', key: 'SEC', memberIds: [member.id], leadIds: [member.id], editPolicy: 'members' }).expect(201)
      ).body;
      const open = (await owner.post(`${w}/teams`, { name: 'Open', key: 'OPEN' }).expect(201)).body;
      return { ...ctx, team, open };
    }

    it('validates leads (subset of members), drops leads who leave the team', async () => {
      const { owner, member, member2, w, team } = await teamSetup();
      expect(team).toMatchObject({ leadIds: [member.id], editPolicy: 'members' });
      await owner.post(`${w}/teams`, { name: 'Bad', key: 'BAD', leadIds: [member.id] }).expect(400);
      await owner.patch(`${w}/teams/SEC`, { leadIds: [member2.id] }).expect(400);
      const t = (await owner.patch(`${w}/teams/SEC`, { memberIds: [member2.id] }).expect(200)).body;
      expect(t.leadIds).toEqual([]);
      expect(t.memberIds).toEqual([member2.id]);
    });

    it('editPolicy "members": only team members, leads and admins edit its workstreams', async () => {
      const { owner, admin, member, member2, w, team } = await teamSetup();
      const body = { title: 'Locked', ownerTeamId: team.id, deltaThreadUrl: DELTA };
      await member2.post(`${w}/workstreams`, body).expect(403);
      const ws = (await member.post(`${w}/workstreams`, body).expect(201)).body;
      await admin.post(`${w}/workstreams`, { ...body, title: 'By admin' }).expect(201);

      await member2.patch(`${w}/workstreams/${ws.key}`, { title: 'Hacked' }).expect(403);
      await member2.post(`${w}/workstreams/${ws.key}/criteria`, { text: 'x' }).expect(403);
      await member2.delete(`${w}/workstreams/${ws.key}`).expect(403);
      await member2.get(`${w}/workstreams/${ws.key}`).expect(200); // reading is never restricted
      await member.patch(`${w}/workstreams/${ws.key}`, { title: 'Fine' }).expect(200);

      // moving a workstream INTO a restricted team needs membership of it too
      const free = (await member2.post(`${w}/workstreams`, { title: 'Free', ownerTeamId: (await owner.get(`${w}/teams/OPEN`)).body.id, deltaThreadUrl: DELTA }).expect(201)).body;
      await member2.patch(`${w}/workstreams/${free.key}`, { ownerTeamId: team.id }).expect(403);

      // switch to "workspace": everyone can edit again
      await owner.patch(`${w}/teams/SEC`, { editPolicy: 'workspace' }).expect(200);
      await member2.patch(`${w}/workstreams/${ws.key}`, { title: 'Now open' }).expect(200);
    });

    it('editPolicy "members" also protects the team\'s issues; issues without a team stay open', async () => {
      const { member, member2, w, team } = await teamSetup();
      const issue = (await member.post(`${w}/issues`, { kind: 'bug', title: 'Team bug', teamId: team.id }).expect(201)).body;
      await member2.post(`${w}/issues`, { kind: 'bug', title: 'Sneaky', teamId: team.id }).expect(403);
      await member2.patch(`${w}/issues/${issue.key}`, { title: 'Hacked' }).expect(403);
      await member2.delete(`${w}/issues/${issue.key}`).expect(403);
      await member.patch(`${w}/issues/${issue.key}`, { priority: 'high' }).expect(200);
      const free = (await member2.post(`${w}/issues`, { kind: 'bug', title: 'No team' }).expect(201)).body;
      await member2.patch(`${w}/issues/${free.key}`, { teamId: team.id }).expect(403);
      await member2.patch(`${w}/issues/${free.key}`, { title: 'Still ok' }).expect(200);
    });

    it('agents count through their owner; a lead may edit their own team but not delete it', async () => {
      const { owner, member, member2, w, team } = await teamSetup();
      const mine = (await owner.post(`${w}/agents`, { name: 'Mine', provider: 'claude_code', ownerUserId: member.id }).expect(201)).body;
      const theirs = (await owner.post(`${w}/agents`, { name: 'Theirs', provider: 'codex', ownerUserId: member2.id }).expect(201)).body;
      const mineTok = new TokenClient(server, (await owner.post(`${w}/tokens`, { name: 'a', agentId: mine.id }).expect(201)).body.secret);
      const theirsTok = new TokenClient(server, (await owner.post(`${w}/tokens`, { name: 'b', agentId: theirs.id }).expect(201)).body.secret);
      const body = { title: 'Agent work', ownerTeamId: team.id, deltaThreadUrl: DELTA };
      await theirsTok.post(`${w}/workstreams`, body).expect(403);
      await mineTok.post(`${w}/workstreams`, body).expect(201);

      await member.patch(`${w}/teams/SEC`, { description: 'Led by member' }).expect(200);
      await member2.patch(`${w}/teams/SEC`, { description: 'Not a lead' }).expect(403);
      await member.delete(`${w}/teams/${team.id}`).expect(403);
    });
  });

  describe('API token scopes', () => {
    it('default scope is write; read tokens are GET-only; write tokens cannot reach admin routes', async () => {
      const { owner, slug, w } = await setup();
      const mint = async (scope?: string) => {
        const res = (await owner.post(`${w}/tokens`, { name: `t-${scope ?? 'default'}`, ...(scope ? { scope } : {}) }).expect(201)).body;
        return { client: new TokenClient(server, res.secret), token: res.token };
      };
      const dflt = await mint();
      expect(dflt.token.scope).toBe('write');
      const read = await mint('read');
      const write = await mint('write');
      const admin = await mint('admin');
      expect(read.token.scope).toBe('read');

      // read: GET only
      await read.client.get(`${w}/snapshot`).expect(200);
      expect((await read.client.get(`${w}/snapshot`)).body.myRole).toBe('viewer');
      const denied = await read.client.post(`${w}/issues`, { kind: 'bug', title: 'x' }).expect(403);
      expect(denied.body.message).toMatch(/read/);
      await read.client.get(`${w}/integrations`).expect(403);

      // write: everyday work yes, admin routes no (even though the user is an owner)
      await write.client.post(`${w}/issues`, { kind: 'bug', title: 'from token' }).expect(201);
      expect((await write.client.get(`${w}/snapshot`)).body.myRole).toBe('member');
      const noTeam = await write.client.post(`${w}/teams`, { name: 'T', key: 'TT' }).expect(403);
      expect(noTeam.body.message).toMatch(/admin-scoped token/);
      await write.client.patch(w, { name: 'Renamed' }).expect(403);
      await dflt.client.post(`${w}/teams`, { name: 'T', key: 'TT' }).expect(403);

      // admin: full role of the user
      await admin.client.post(`${w}/teams`, { name: 'T', key: 'TT' }).expect(201);
      expect((await admin.client.get(`${w}/snapshot`)).body.myRole).toBe('owner');
      expect(slug).toBeTruthy();
    });

    it('only admins mint admin tokens; agents cannot be given the admin scope; lists show the scope', async () => {
      const { owner, member, admin, w } = await setup();
      await member.post(`${w}/tokens`, { name: 'sneaky', scope: 'admin' }).expect(403);
      await member.post(`${w}/tokens`, { name: 'fine', scope: 'read' }).expect(201);
      // a write-scoped admin token cannot escalate by minting an admin token
      const writeTok = new TokenClient(server, (await admin.post(`${w}/tokens`, { name: 'w', scope: 'write' }).expect(201)).body.secret);
      await writeTok.post(`${w}/tokens`, { name: 'esc', scope: 'admin' }).expect(403);
      await writeTok.post(`${w}/tokens`, { name: 'ok', scope: 'read' }).expect(201);

      const agent = (await owner.post(`${w}/agents`, { name: 'Bot', provider: 'claude_code' }).expect(201)).body;
      await owner.post(`${w}/tokens`, { name: 'bot', agentId: agent.id, scope: 'admin' }).expect(400);
      const bot = (await owner.post(`${w}/tokens`, { name: 'bot', agentId: agent.id, scope: 'read' }).expect(201)).body;
      const readBot = new TokenClient(server, bot.secret);
      await readBot.get(`${w}/workstreams`).expect(200);
      await readBot.post(`${w}/issues`, { kind: 'bug', title: 'x' }).expect(403);

      const listed = (await owner.get(`${w}/tokens`).expect(200)).body as { scope: string }[];
      expect(listed.map((t) => t.scope).sort()).toEqual(['read', 'read', 'read', 'write']);
      await owner.post(`${w}/tokens`, { name: 'bad', scope: 'root' }).expect(400);
    });

    it('manageTokens and manageAgents capabilities gate token creation', async () => {
      const { owner, member, w } = await setup();
      const agent = (await owner.post(`${w}/agents`, { name: 'Bot', provider: 'codex' }).expect(201)).body;
      await member.post(`${w}/tokens`, { name: 'for agent', agentId: agent.id }).expect(403);
      await owner.patch(`${w}/settings`, { permissions: { manageAgents: 'member' } }).expect(200);
      await member.post(`${w}/tokens`, { name: 'for agent', agentId: agent.id }).expect(201);
      await owner.patch(`${w}/settings`, { permissions: { manageTokens: 'admin' } }).expect(200);
      await member.post(`${w}/tokens`, { name: 'mine' }).expect(403);
    });
  });
});
