import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthInfo, WorkspaceContext } from '../auth/request-context.js';
import { TokensController } from './workspaces.controller.js';

function setup() {
  const tokens = { create: vi.fn(async (input: unknown) => ({ token: input, secret: 'nbl_x' })) };
  const controller = new TokensController({} as never, tokens as never);
  const ctx = (role: 'member' | 'admin' | 'owner') =>
    ({ workspace: { id: 'w1' }, actor: { type: 'user', id: 'u1' }, userId: 'u1', role, memberRole: 'owner' }) as unknown as WorkspaceContext;
  const auth = (scope: 'read' | 'write' | 'admin' | 'custom', permissions: string[] = []) =>
    ({ actor: { type: 'user', id: 'u1' }, method: 'token', token: { scope, permissions } }) as unknown as AuthInfo;
  return { controller, tokens, ctx, auth };
}

describe('TokensController.create privilege ceiling', () => {
  it('a write token cannot mint a custom token (which would not be capped to member)', async () => {
    const { controller, tokens, ctx, auth } = setup();
    await expect(
      controller.create(ctx('member'), auth('write'), { name: 'x', permissions: ['workspace:write', 'members:write'] } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokens.create).not.toHaveBeenCalled();
  });

  it('a write token can still mint read and write tokens', async () => {
    const { controller, tokens, ctx, auth } = setup();
    await controller.create(ctx('member'), auth('write'), { name: 'x', scope: 'read' } as never);
    await controller.create(ctx('member'), auth('write'), { name: 'x' } as never);
    expect(tokens.create).toHaveBeenCalledTimes(2);
  });

  it('an admin-scoped token or a session can mint custom tokens', async () => {
    const { controller, tokens, ctx, auth } = setup();
    await controller.create(ctx('owner'), auth('admin'), { name: 'x', permissions: ['issues:read'] } as never);
    await controller.create(ctx('owner'), { actor: { type: 'user', id: 'u1' }, method: 'session' } as never, {
      name: 'x',
      permissions: ['issues:read'],
    } as never);
    expect(tokens.create).toHaveBeenCalledTimes(2);
  });
});
