import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthInfo, WorkspaceContext } from '../auth/request-context.js';
import { DecisionsController } from './decisions.controller.js';

const actor = { type: 'user', id: 'u1' } as const;
const ctx = (role: 'member' | 'admin', acceptDecisions: 'member' | 'admin') =>
  ({ workspace: { id: 'w1', resolved: () => ({ permissions: { acceptDecisions } }) }, actor, userId: 'u1', role }) as unknown as WorkspaceContext;
const session = { actor, method: 'session' } as unknown as AuthInfo;

function setup() {
  const service = { create: vi.fn(async () => ({ id: 'dc_1' })) };
  return { service, controller: new DecisionsController(service as never) };
}

describe('DecisionsController.create', () => {
  it.each(['accepted', 'rejected'] as const)('creating a %s decision needs the acceptDecisions capability', async (status) => {
    const { controller, service } = setup();
    expect(() => controller.create(ctx('member', 'admin'), actor, session, { title: 't', statement: 's', status } as never)).toThrow(ForbiddenException);
    expect(service.create).not.toHaveBeenCalled();
    await controller.create(ctx('admin', 'admin'), actor, session, { title: 't', statement: 's', status } as never);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it('a custom token without decisions:accept cannot create an accepted decision', async () => {
    const { controller, service } = setup();
    const token = { actor, method: 'token', token: { scope: 'custom', permissions: ['decisions:write'] } } as unknown as AuthInfo;
    expect(() => controller.create(ctx('member', 'member'), actor, token, { title: 't', statement: 's', status: 'accepted' } as never)).toThrow(ForbiddenException);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('draft and proposed decisions are open to every member', async () => {
    const { controller, service } = setup();
    await controller.create(ctx('member', 'admin'), actor, session, { title: 't', statement: 's', status: 'proposed' } as never);
    await controller.create(ctx('member', 'admin'), actor, session, { title: 't' } as never);
    expect(service.create).toHaveBeenCalledTimes(2);
  });
});
