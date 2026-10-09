import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { RequireUser, SessionOnly, type AppRequest } from '../auth/request-context.js';
import { AccessGuard } from './access.guard.js';

class AccountRoutes {
  @RequireUser()
  @SessionOnly()
  create(): void {}

  @RequireUser()
  list(): void {}
}

function setup(auth: 'token' | 'session') {
  const token = { id: 'tok_1', workspaceId: 'ws_1', scope: 'admin', actor: { type: 'user', id: 'u1' } };
  const user = { id: 'u1' };
  const tokens = { authenticate: vi.fn(async () => token), enforceLimits: vi.fn(async () => undefined) };
  const sessions = { authenticateSession: vi.fn(async () => ({ user, sessionId: 's1' })) };
  const guard = new AccessGuard(
    new Reflector(),
    sessions as never,
    tokens as never,
    {} as never,
    {} as never,
    { findOneBy: vi.fn(async () => user) } as never,
    {} as never,
    {} as never,
  );
  const run = (handler: () => void, method: string) => {
    const req = {
      method,
      headers: auth === 'token' ? { authorization: 'Bearer trm_x' } : { cookie: 'trama_session=raw', 'x-requested-with': 'test' },
      params: {},
      route: { path: '/api/workspaces' },
      is: () => true,
    } as unknown as AppRequest;
    const context = {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => AccountRoutes,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  };
  return { run, tokens };
}

describe('AccessGuard @SessionOnly account routes', () => {
  it('refuses API tokens, whatever their scope', async () => {
    const { run, tokens } = setup('token');
    await expect(run(AccountRoutes.prototype.create, 'POST')).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokens.enforceLimits).not.toHaveBeenCalled();
  });

  it('keeps working for browser sessions', async () => {
    const { run } = setup('session');
    await expect(run(AccountRoutes.prototype.create, 'POST')).resolves.toBe(true);
  });

  it('leaves routes without the marker callable with a token', async () => {
    const { run } = setup('token');
    await expect(run(AccountRoutes.prototype.list, 'GET')).resolves.toBe(true);
  });
});
