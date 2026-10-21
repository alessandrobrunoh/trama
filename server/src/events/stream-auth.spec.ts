import { NEVER, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthInfo, WorkspaceContext } from '../auth/request-context.js';
import {
  agentWorkspaceRole,
  capabilitiesForLegacyRole,
  effectiveMemberAccess,
  roleGrants,
  type MemberAccess,
  type Role,
  type WorkspaceRole,
} from '../contracts/domain.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import { DEFAULT_STREAM_RECHECK_MS, StreamAuthService, closeWhenInvalid, streamRecheckMs } from './stream-auth.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const future = new Date(NOW + 60_000);
const past = new Date(NOW - 1);

function setup(state: {
  session?: { expiresAt: Date } | null;
  token?: { workspaceId: string; expiresAt: Date | null } | null;
  member?: boolean;
  agent?: boolean;
  memberAccess?: MemberAccess | null;
  capturedAccess?: MemberAccess | null;
}) {
  const viewerRole: WorkspaceRole = {
    id: 'viewer',
    name: 'Viewer',
    owner: false,
    capabilities: capabilitiesForLegacyRole('viewer'),
    grants: roleGrants('viewer'),
  };
  const workspace = Object.assign(new WorkspaceEntity(), {
    id: 'ws_1',
    resolved: () => ({ roles: [viewerRole] }),
  });
  const sessions = { findOneBy: vi.fn().mockResolvedValue(state.session ?? null) };
  const tokens = { findOneBy: vi.fn().mockResolvedValue(state.token ?? null) };
  const memberships = {
    findOneBy: vi.fn().mockResolvedValue(
      state.member
        ? { id: 'mem_1', workspaceId: 'ws_1', userId: 'usr_1', role: 'viewer', access: state.memberAccess ?? null }
        : null,
    ),
  };
  const agents = { existsBy: vi.fn().mockResolvedValue(state.agent ?? false) };
  const workspaces = { findOneBy: vi.fn().mockResolvedValue(workspace) };
  const service = new StreamAuthService(
    sessions as never,
    tokens as never,
    memberships as never,
    agents as never,
    workspaces as never,
  );
  const ctx = {
    workspace,
    role: 'viewer' as Role,
    memberRole: 'viewer' as Role,
    tokenScope: undefined,
    owner: false,
    capabilities: viewerRole.capabilities,
    access: effectiveMemberAccess(viewerRole, state.capturedAccess ?? state.memberAccess ?? null),
  } as unknown as WorkspaceContext;
  return { service, sessions, tokens, memberships, agents, workspaces, ctx };
}

const sessionAuth = { method: 'session', sessionId: 'sess_1', actor: { type: 'user', id: 'usr_1' }, user: { id: 'usr_1' } } as unknown as AuthInfo;
const userTokenAuth = { method: 'token', token: { id: 'tok_1' }, actor: { type: 'user', id: 'usr_1' }, user: { id: 'usr_1' } } as unknown as AuthInfo;
const agentTokenAuth = { method: 'token', token: { id: 'tok_2' }, actor: { type: 'agent', id: 'ag_1' } } as unknown as AuthInfo;

describe('StreamAuthService.isStillValid', () => {
  it('accepts a live session of a current member', async () => {
    const { service, ctx } = setup({ session: { expiresAt: future }, member: true });
    expect(await service.isStillValid(sessionAuth, ctx, NOW)).toBe(true);
  });

  it('rejects a deleted (logged out) or expired session', async () => {
    const deleted = setup({ session: null, member: true });
    expect(await deleted.service.isStillValid(sessionAuth, deleted.ctx, NOW)).toBe(false);
    const expired = setup({ session: { expiresAt: past }, member: true });
    expect(await expired.service.isStillValid(sessionAuth, expired.ctx, NOW)).toBe(false);
  });

  it('rejects a member who was removed from the workspace', async () => {
    const { service, memberships, ctx } = setup({ session: { expiresAt: future }, member: false });
    expect(await service.isStillValid(sessionAuth, ctx, NOW)).toBe(false);
    expect(memberships.findOneBy).toHaveBeenCalledWith({ workspaceId: 'ws_1', userId: 'usr_1' });
  });

  it('accepts a live API token and rejects a revoked, expired or foreign one', async () => {
    const ok = { workspaceId: 'ws_1', expiresAt: null };
    const live = setup({ token: ok, member: true });
    expect(await live.service.isStillValid(userTokenAuth, live.ctx, NOW)).toBe(true);
    const futureToken = setup({ token: { ...ok, expiresAt: future }, member: true });
    expect(await futureToken.service.isStillValid(userTokenAuth, futureToken.ctx, NOW)).toBe(true);
    const revoked = setup({ token: null, member: true });
    expect(await revoked.service.isStillValid(userTokenAuth, revoked.ctx, NOW)).toBe(false);
    const expired = setup({ token: { ...ok, expiresAt: past }, member: true });
    expect(await expired.service.isStillValid(userTokenAuth, expired.ctx, NOW)).toBe(false);
    const foreign = setup({ token: { ...ok, workspaceId: 'ws_2' }, member: true });
    expect(await foreign.service.isStillValid(userTokenAuth, foreign.ctx, NOW)).toBe(false);
  });

  it('closes a stream when effective project access changes', async () => {
    const before: MemberAccess = {
      projects: { all: false, projectIds: ['pr_1'] },
      includeUnassigned: false,
      grants: [],
    };
    const after: MemberAccess = {
      projects: { all: false, projectIds: ['pr_2'] },
      includeUnassigned: false,
      grants: [],
    };
    const changed = setup({
      session: { expiresAt: future },
      member: true,
      memberAccess: after,
      capturedAccess: before,
    });
    expect(await changed.service.isStillValid(sessionAuth, changed.ctx, NOW)).toBe(false);
  });

  it('keeps an agent token open only while the agent exists in the workspace', async () => {
    const token = { workspaceId: 'ws_1', expiresAt: null };
    const live = setup({ token, agent: true });
    const role = agentWorkspaceRole();
    const agentCtx = {
      ...live.ctx,
      role: 'member',
      memberRole: 'member',
      capabilities: role.capabilities,
      access: effectiveMemberAccess(role, null),
    } as unknown as WorkspaceContext;
    expect(await live.service.isStillValid(agentTokenAuth, agentCtx, NOW)).toBe(true);
    expect(live.agents.existsBy).toHaveBeenCalledWith({ id: 'ag_1', workspaceId: 'ws_1' });
    const removed = setup({ token, agent: false });
    expect(await removed.service.isStillValid(agentTokenAuth, agentCtx, NOW)).toBe(false);
  });
});

describe('closeWhenInvalid', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes the stream on the first failed check, and keeps it open before that', async () => {
    let valid = true;
    const source = new Subject<number>();
    const seen: number[] = [];
    let completed = false;
    source.pipe(closeWhenInvalid(() => Promise.resolve(valid), 1000)).subscribe({ next: (v) => seen.push(v), complete: () => (completed = true) });

    await vi.advanceTimersByTimeAsync(3000);
    source.next(1);
    expect(completed).toBe(false);

    valid = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(true);
    source.next(2);
    expect(seen).toEqual([1]);
    expect(source.observed).toBe(false);
  });

  it('closes the stream when authorization cannot be revalidated', async () => {
    let calls = 0;
    let completed = false;
    NEVER.pipe(
      closeWhenInvalid(() => {
        calls++;
        return Promise.reject(new Error('db down'));
      }, 1000),
    ).subscribe({ complete: () => (completed = true) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(true);
    expect(calls).toBe(1);
  });
});

describe('streamRecheckMs', () => {
  it('defaults to 30 seconds and accepts an override', () => {
    expect(streamRecheckMs({})).toBe(DEFAULT_STREAM_RECHECK_MS);
    expect(streamRecheckMs({ TRAMA_SSE_RECHECK_MS: 'abc' })).toBe(DEFAULT_STREAM_RECHECK_MS);
    expect(streamRecheckMs({ TRAMA_SSE_RECHECK_MS: '5000' })).toBe(5000);
  });
});
