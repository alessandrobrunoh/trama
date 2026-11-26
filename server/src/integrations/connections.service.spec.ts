import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceEntity, IntegrationConnectionEntity, type MembershipEntity } from '../database/entities/index.js';
import { connectionHost, type IntegrationConnection } from '../contracts/domain.js';
import { ConnectionsService, markSuggested } from './connections.service.js';
import { IntegrationsService } from './integrations.service.js';
import { SecretsService } from './secrets.service.js';

const secrets = new SecretsService();

function conn(over: Partial<IntegrationConnectionEntity>): IntegrationConnectionEntity {
  const id = over.id ?? 'ic_x';
  return Object.assign(new IntegrationConnectionEntity(), {
    id,
    ownerType: 'workspace',
    workspaceId: 'w1',
    ownerUserId: null,
    label: 'GitHub · acme',
    provider: 'github',
    account: 'acme',
    host: 'github.com',
    baseUrl: null,
    status: 'connected',
    lastError: null,
    config: {},
    secret: secrets.encrypt('ghp_supersecret', `${id}:secret`),
    webhookSecret: secrets.encrypt('whsec_supersecret', `${id}:webhook`),
    createdAt: new Date(),
    ...over,
  });
}

/** Just enough of a repository: `find` / `findOneBy` filter on plain equality. */
function fakeRepo<T extends object>(rows: T[]) {
  const matches = (row: T, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
  return {
    rows,
    find: vi.fn(async (opts?: { where?: Record<string, unknown> }) => rows.filter((r) => matches(r, opts?.where ?? {}))),
    findOneBy: vi.fn(async (where: Record<string, unknown>) => rows.find((r) => matches(r, where)) ?? null),
    save: vi.fn(async (x: T) => x),
  };
}

function setup(rows: IntegrationConnectionEntity[], opts: { role?: string; member?: boolean } = {}) {
  const repo = fakeRepo(rows);
  const users = { find: vi.fn(async () => [{ id: 'u1', name: 'Alessandro' }]) };
  const integrations = new IntegrationsService({} as never, secrets, { publish: vi.fn() } as never, repo as never, users as never);
  const workspace = Object.assign(new WorkspaceEntity(), { id: 'w1' });
  vi.spyOn(workspace, 'resolved').mockReturnValue({
    roles: [
      { id: 'owner', name: 'Owner', owner: true, capabilities: ['manageIntegrations'] },
      { id: 'admin', name: 'Admin', capabilities: ['manageIntegrations'] },
      { id: 'member', name: 'Member', capabilities: [] },
    ],
  } as never);
  const memberships = fakeRepo<MembershipEntity>(
    opts.member === false ? [] : [{ id: 'mb1', workspaceId: 'w1', userId: 'u1', role: opts.role ?? 'member' } as MembershipEntity],
  );
  const workspaces = fakeRepo([workspace]);
  const connections = new ConnectionsService(integrations, repo as never, memberships as never, workspaces as never);
  return { repo, integrations, connections };
}

describe('connectionHost', () => {
  it('uses the base URL host, else the provider host', () => {
    expect(connectionHost('github', null)).toBe('github.com');
    expect(connectionHost('gitlab', 'https://GitLab.Example.com:8443/sub')).toBe('gitlab.example.com:8443');
    expect(connectionHost('bitbucket', undefined)).toBe('bitbucket.org');
  });
});

describe('IntegrationsService.summarize / revoke', () => {
  it('never serializes tokens, and names the owner of a personal connection', async () => {
    const personal = conn({ id: 'ic_p', ownerType: 'user', workspaceId: null, ownerUserId: 'u1' });
    const { integrations } = setup([personal]);
    const [summary] = await integrations.summarize([personal]);
    expect(summary).toMatchObject({ id: 'ic_p', ownerType: 'user', ownerUserId: 'u1', ownerName: 'Alessandro', label: 'GitHub · acme', host: 'github.com' });
    expect(summary).not.toHaveProperty('workspaceId');
    const json = JSON.stringify(await integrations.present(personal, 'http://x'));
    expect(json).not.toContain('ghp_supersecret');
    expect(json).not.toContain('whsec_supersecret');
    expect(json).not.toMatch(/"secret"|"webhookSecret"/);
  });

  it('revoke flips the status, wipes the token and keeps the row', async () => {
    const row = conn({ id: 'ic_w' });
    const { integrations, repo } = setup([row]);
    const out = await integrations.revoke({ type: 'workspace', workspaceId: 'w1' }, 'ic_w', 'http://x');
    expect(out.status).toBe('revoked');
    expect(out.lastError).toBe('Revoked');
    expect(row.secret).toBeNull();
    expect(repo.save).toHaveBeenCalled();
  });

  it('does not find a connection through the wrong owner', async () => {
    const personal = conn({ id: 'ic_p', ownerType: 'user', workspaceId: null, ownerUserId: 'u1' });
    const { integrations } = setup([personal]);
    await expect(integrations.get({ type: 'user', userId: 'u2' }, 'ic_p', 'http://x')).rejects.toThrow(/not found/);
    await expect(integrations.get({ type: 'workspace', workspaceId: 'w1' }, 'ic_p', 'http://x')).rejects.toThrow(/not found/);
    await expect(integrations.revoke({ type: 'user', userId: 'u2' }, 'ic_p', 'http://x')).rejects.toThrow(/not found/);
    await expect(integrations.get({ type: 'user', userId: 'u1' }, 'ic_p', 'http://x')).resolves.toMatchObject({ id: 'ic_p' });
  });

  it('refuses to read repositories through a revoked connection', async () => {
    const row = conn({ id: 'ic_w', status: 'revoked', secret: null });
    const { integrations } = setup([row]);
    await expect(integrations.remoteRepositories({ type: 'workspace', workspaceId: 'w1' }, 'ic_w', 1, 30)).rejects.toThrow(/revoked/);
  });
});

describe('ConnectionsService.usableFor', () => {
  const personalGithub = conn({ id: 'ic_p', ownerType: 'user', workspaceId: null, ownerUserId: 'u1', label: 'GitHub · personal', account: 'ale' });
  const otherPersonal = conn({ id: 'ic_o', ownerType: 'user', workspaceId: null, ownerUserId: 'u2', label: 'GitHub · other', account: 'bob' });
  const workspaceGithub = conn({ id: 'ic_w', label: 'GitHub · Acme' });
  const personalGitlab = conn({ id: 'ic_g', ownerType: 'user', workspaceId: null, ownerUserId: 'u1', provider: 'gitlab', host: 'gitlab.com', account: 'ale', label: 'GitLab · ale' });

  it('gives a member their own connections only, never someone else\'s', async () => {
    const { connections } = setup([personalGithub, otherPersonal, workspaceGithub, personalGitlab]);
    const usable = await connections.usableFor('u1', 'w1');
    expect(usable.map((c) => c.id).sort()).toEqual(['ic_g', 'ic_p']);
    expect(JSON.stringify(usable)).not.toContain('ghp_supersecret');
  });

  it('adds the workspace connections for a role with the integrations permission and suggests them', async () => {
    const { connections } = setup([personalGithub, otherPersonal, workspaceGithub, personalGitlab], { role: 'admin' });
    const usable = await connections.usableFor('u1', 'w1');
    expect(usable.map((c) => [c.id, c.suggested])).toEqual([
      ['ic_w', true],
      ['ic_p', false],
      ['ic_g', true], // the only GitLab one
    ]);
  });

  it('leaves out revoked connections and returns nothing to a non-member', async () => {
    const revoked = conn({ id: 'ic_r', ownerType: 'user', workspaceId: null, ownerUserId: 'u1', status: 'revoked', account: 'old' });
    expect((await setup([personalGithub, revoked]).connections.usableFor('u1', 'w1')).map((c) => c.id)).toEqual(['ic_p']);
    expect(await setup([personalGithub], { member: false }).connections.usableFor('u1', 'w1')).toEqual([]);
  });
});

describe('markSuggested', () => {
  const base = { webhookConfigured: true, createdAt: '2026-01-01', baseUrl: undefined } as const;
  const c = (over: Partial<IntegrationConnection>): IntegrationConnection =>
    ({ ...base, id: 'x', ownerType: 'workspace', label: 'l', provider: 'github', account: 'a', host: 'github.com', status: 'connected', ...over }) as IntegrationConnection;

  it('prefers a healthy workspace connection over personal ones for the same host', () => {
    const out = markSuggested([c({ id: 'p', ownerType: 'user' }), c({ id: 'w' })]);
    expect(out.find((x) => x.id === 'w')?.suggested).toBe(true);
    expect(out.find((x) => x.id === 'p')?.suggested).toBe(false);
  });

  it('falls back to a personal connection when the workspace one is failing', () => {
    const out = markSuggested([c({ id: 'p', ownerType: 'user' }), c({ id: 'w', status: 'error' })]);
    expect(out.map((x) => [x.id, x.suggested])).toEqual([['p', true], ['w', false]]);
  });

  it('does not pick between several personal accounts on one host', () => {
    const out = markSuggested([c({ id: 'p1', ownerType: 'user' }), c({ id: 'p2', ownerType: 'user' })]);
    expect(out.every((x) => !x.suggested)).toBe(true);
  });

  it('treats hosts separately', () => {
    const out = markSuggested([c({ id: 'a', ownerType: 'user' }), c({ id: 'b', ownerType: 'user', host: 'ghe.example.com' })]);
    expect(out.every((x) => x.suggested)).toBe(true);
  });
});
