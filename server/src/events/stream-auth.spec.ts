import { NEVER, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthInfo } from '../auth/request-context.js';
import { DEFAULT_STREAM_RECHECK_MS, StreamAuthService, closeWhenInvalid, streamRecheckMs } from './stream-auth.js';

const NOW = Date.parse('2026-10-09T12:00:00Z');
const future = new Date(NOW + 60_000);
const past = new Date(NOW - 1);

function setup(state: {
  session?: { expiresAt: Date } | null;
  token?: { workspaceId: string; expiresAt: Date | null } | null;
  member?: boolean;
  agent?: boolean;
}) {
  const sessions = { findOneBy: vi.fn().mockResolvedValue(state.session ?? null) };
  const tokens = { findOneBy: vi.fn().mockResolvedValue(state.token ?? null) };
  const memberships = { existsBy: vi.fn().mockResolvedValue(state.member ?? false) };
  const agents = { existsBy: vi.fn().mockResolvedValue(state.agent ?? false) };
  const service = new StreamAuthService(sessions as never, tokens as never, memberships as never, agents as never);
  return { service, sessions, tokens, memberships, agents };
}

const sessionAuth = { method: 'session', sessionId: 'sess_1', actor: { type: 'user', id: 'usr_1' }, user: { id: 'usr_1' } } as unknown as AuthInfo;
const userTokenAuth = { method: 'token', token: { id: 'tok_1' }, actor: { type: 'user', id: 'usr_1' }, user: { id: 'usr_1' } } as unknown as AuthInfo;
const agentTokenAuth = { method: 'token', token: { id: 'tok_2' }, actor: { type: 'agent', id: 'ag_1' } } as unknown as AuthInfo;

describe('StreamAuthService.isStillValid', () => {
  it('accepts a live session of a current member', async () => {
    const { service } = setup({ session: { expiresAt: future }, member: true });
    expect(await service.isStillValid(sessionAuth, 'ws_1', NOW)).toBe(true);
  });

  it('rejects a deleted (logged out) or expired session', async () => {
    expect(await setup({ session: null, member: true }).service.isStillValid(sessionAuth, 'ws_1', NOW)).toBe(false);
    expect(await setup({ session: { expiresAt: past }, member: true }).service.isStillValid(sessionAuth, 'ws_1', NOW)).toBe(false);
  });

  it('rejects a member who was removed from the workspace', async () => {
    const { service, memberships } = setup({ session: { expiresAt: future }, member: false });
    expect(await service.isStillValid(sessionAuth, 'ws_1', NOW)).toBe(false);
    expect(memberships.existsBy).toHaveBeenCalledWith({ workspaceId: 'ws_1', userId: 'usr_1' });
  });

  it('accepts a live API token and rejects a revoked, expired or foreign one', async () => {
    const ok = { workspaceId: 'ws_1', expiresAt: null };
    expect(await setup({ token: ok, member: true }).service.isStillValid(userTokenAuth, 'ws_1', NOW)).toBe(true);
    expect(await setup({ token: { ...ok, expiresAt: future }, member: true }).service.isStillValid(userTokenAuth, 'ws_1', NOW)).toBe(true);
    expect(await setup({ token: null, member: true }).service.isStillValid(userTokenAuth, 'ws_1', NOW)).toBe(false);
    expect(await setup({ token: { ...ok, expiresAt: past }, member: true }).service.isStillValid(userTokenAuth, 'ws_1', NOW)).toBe(false);
    expect(await setup({ token: { ...ok, workspaceId: 'ws_2' }, member: true }).service.isStillValid(userTokenAuth, 'ws_1', NOW)).toBe(false);
  });

  it('keeps an agent token open only while the agent exists in the workspace', async () => {
    const token = { workspaceId: 'ws_1', expiresAt: null };
    const live = setup({ token, agent: true });
    expect(await live.service.isStillValid(agentTokenAuth, 'ws_1', NOW)).toBe(true);
    expect(live.agents.existsBy).toHaveBeenCalledWith({ id: 'ag_1', workspaceId: 'ws_1' });
    expect(await setup({ token, agent: false }).service.isStillValid(agentTokenAuth, 'ws_1', NOW)).toBe(false);
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

  it('survives a failing check', async () => {
    let calls = 0;
    let completed = false;
    NEVER.pipe(
      closeWhenInvalid(() => {
        calls++;
        return calls === 1 ? Promise.reject(new Error('db down')) : Promise.resolve(calls < 3);
      }, 1000),
    ).subscribe({ complete: () => (completed = true) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(completed).toBe(true);
  });
});

describe('streamRecheckMs', () => {
  it('defaults to 30 seconds and accepts an override', () => {
    expect(streamRecheckMs({})).toBe(DEFAULT_STREAM_RECHECK_MS);
    expect(streamRecheckMs({ TRAMA_SSE_RECHECK_MS: 'abc' })).toBe(DEFAULT_STREAM_RECHECK_MS);
    expect(streamRecheckMs({ TRAMA_SSE_RECHECK_MS: '5000' })).toBe(5000);
  });
});
