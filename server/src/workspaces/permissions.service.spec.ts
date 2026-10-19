import { describe, expect, it, vi } from 'vitest';
import type { AppRequest, WorkspaceContext } from '../auth/request-context.js';
import type { IssueEntity } from '../database/entities/index.js';
import { PermissionsService } from './permissions.service.js';

const restrictedAccess = {
  projects: { all: false, projectIds: ['pj_visible'] },
  includeUnassigned: false,
  grants: [],
};

describe('PermissionsService.enforceTeamScope', () => {
  it('uses access from the request context when the target issue is project-hidden', async () => {
    const query = { where: vi.fn(), getOne: vi.fn() };
    query.where.mockReturnValue(query);
    query.getOne.mockResolvedValue({
      id: 'in_hidden',
      projectId: 'pj_hidden',
      teamId: 'tm_secret',
    } as IssueEntity);
    const teams = { findOneBy: vi.fn() };
    const service = new PermissionsService(
      teams as never,
      {} as never,
      { createQueryBuilder: vi.fn(() => query) } as never,
    );
    const ctx = {
      workspace: { id: 'ws_1' },
      access: restrictedAccess,
    } as unknown as WorkspaceContext;
    const req = {
      method: 'PATCH',
      params: { idOrKey: 'in_hidden' },
      body: { title: 'Updated' },
    } as unknown as AppRequest;

    await service.enforceTeamScope('issue', req, ctx);

    expect(teams.findOneBy).not.toHaveBeenCalled();
  });

  it('leaves parent-team authorization to the transaction that creates or changes the link', async () => {
    const createQueryBuilder = vi.fn();
    const teams = { findOneBy: vi.fn() };
    const service = new PermissionsService(
      teams as never,
      {} as never,
      { createQueryBuilder } as never,
    );
    const ctx = {
      workspace: { id: 'ws_1' },
      access: restrictedAccess,
    } as unknown as WorkspaceContext;
    const req = {
      method: 'POST',
      params: {},
      body: { parentId: 'in_hidden', teamId: 'tm_secret' },
    } as unknown as AppRequest;

    await service.enforceTeamScope('issue', req, ctx);

    expect(createQueryBuilder).not.toHaveBeenCalled();
    expect(teams.findOneBy).not.toHaveBeenCalled();
  });
});

describe('PermissionsService.assertTeamEdit', () => {
  it('conceals a hidden parent team when rejecting a hierarchy change', async () => {
    const service = new PermissionsService(
      {
        findOneBy: vi.fn(async () => ({
          id: 'tm_secret',
          workspaceId: 'ws_1',
          key: 'SECRET',
          editPolicy: 'members',
          memberIds: ['usr_member'],
          leadIds: [],
        })),
      } as never,
      {} as never,
      {} as never,
    );
    const ctx = {
      workspace: { id: 'ws_1' },
      role: 'member',
      userId: 'usr_other',
      owner: false,
      capabilities: [],
    } as unknown as WorkspaceContext;

    await expect(
      service.assertTeamEdit(ctx, 'tm_secret', { conceal: true }),
    ).rejects.toThrow('You are not allowed to change this issue hierarchy');
    await expect(service.assertTeamEdit(ctx, 'tm_secret')).rejects.toThrow(
      'Team SECRET only lets its members and leads edit its work',
    );
  });
});
