import 'reflect-metadata';
import {
  ForbiddenException,
  NotFoundException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { type AppRequest } from '../auth/request-context.js';
import { requiredMemberGrant } from '../auth/member-access.js';
import { requiredPermission } from '../auth/api-permissions.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import { AccessGuard } from '../workspaces/access.guard.js';
import {
  ReleasePipelinesController,
  ReleasesController,
} from './releases.controller.js';

function workspace() {
  return Object.assign(new WorkspaceEntity(), {
    id: 'ws_1',
    name: 'Acme',
    slug: 'acme',
    settings: {},
  });
}

function setup(opts: { member: { role: string } | null }) {
  const token = {
    id: 'tok_1',
    workspaceId: 'ws_1',
    scope: 'admin',
    actor: { type: 'user', id: 'u1' },
  };
  const user = { id: 'u1' };
  const tokens = {
    authenticate: vi.fn(async () => token),
    enforceLimits: vi.fn(async () => undefined),
  };
  const sessions = {
    authenticateSession: vi.fn(async () => ({ user, sessionId: 's1' })),
  };
  const workspaces = {
    findOneBy: vi.fn(async () => workspace()),
  };
  const memberships = {
    findOneBy: vi.fn(async () =>
      opts.member
        ? {
            workspaceId: 'ws_1',
            userId: 'u1',
            role: opts.member.role,
            access: null,
          }
        : null,
    ),
  };
  const guard = new AccessGuard(
    new Reflector(),
    sessions as never,
    tokens as never,
    workspaces as never,
    memberships as never,
    { findOneBy: vi.fn(async () => user) } as never,
    {} as never,
    {} as never,
  );
  const run = (
    handler: (...args: never[]) => unknown,
    cls: object,
    method: string,
    path: string,
  ) => {
    const req = {
      method,
      headers: { authorization: 'Bearer trm_x' },
      params: { slug: 'acme' },
      route: { path },
      is: () => true,
    } as unknown as AppRequest;
    const context = {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return guard.canActivate(context);
  };
  return { run };
}

describe('release route permissions', () => {
  it('maps API permissions onto the releases resource; member grants stay role-gated', () => {
    expect(requiredMemberGrant('POST', '/api/w/:slug/releases')).toBeNull();
    expect(requiredPermission('GET', '/api/w/:slug/releases')).toBe(
      'releases:read',
    );
    expect(requiredPermission('POST', '/api/w/:slug/releases')).toBe(
      'releases:write',
    );
    expect(
      requiredPermission('POST', '/api/w/:slug/releases/:id/complete'),
    ).toBe('releases:write');
    expect(requiredPermission('DELETE', '/api/w/:slug/releases/:id')).toBe(
      'releases:delete',
    );
  });

  it('rejects a non-member without revealing the workspace', async () => {
    const { run } = setup({ member: null });
    await expect(
      run(
        ReleasesController.prototype.create,
        ReleasesController,
        'POST',
        '/api/w/:slug/releases',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      run(
        ReleasePipelinesController.prototype.list,
        ReleasePipelinesController,
        'GET',
        '/api/w/:slug/releases/pipelines',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets a member write and forbids a viewer from creating', async () => {
    const member = setup({ member: { role: 'member' } });
    await expect(
      member.run(
        ReleasesController.prototype.create,
        ReleasesController,
        'POST',
        '/api/w/:slug/releases',
      ),
    ).resolves.toBe(true);
    const viewer = setup({ member: { role: 'viewer' } });
    await expect(
      viewer.run(
        ReleasePipelinesController.prototype.create,
        ReleasePipelinesController,
        'POST',
        '/api/w/:slug/releases/pipelines',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      viewer.run(
        ReleasesController.prototype.list,
        ReleasesController,
        'GET',
        '/api/w/:slug/releases',
      ),
    ).resolves.toBe(true);
  });
});
