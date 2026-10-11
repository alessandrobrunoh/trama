import 'reflect-metadata';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import {
  DEFAULT_PERMISSIONS,
  freshWorkspaceRoles,
  migrateLegacyRoles,
  resolveWorkspaceSettings,
  roleAllows,
  roleGrants,
  roleHasCapability,
} from '../contracts/domain.js';
import {
  MembershipEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { WorkspacesService } from './workspaces.service.js';

function ctx(ws: WorkspaceEntity, role = 'owner'): WorkspaceContext {
  return {
    workspace: ws,
    role,
    userId: 'u_owner',
    actor: { type: 'user', id: 'u_owner' },
    owner: role === 'owner',
  } as WorkspaceContext;
}

function setup(
  settings: WorkspaceEntity['settings'] = { roles: freshWorkspaceRoles() },
) {
  const ws = Object.assign(new WorkspaceEntity(), {
    id: 'ws_1',
    name: 'Acme',
    slug: 'acme',
    primaryOwnerId: 'u_owner',
    settings,
  });
  const members: MembershipEntity[] = [
    Object.assign(new MembershipEntity(), {
      id: 'mb_owner',
      workspaceId: 'ws_1',
      userId: 'u_owner',
      role: 'owner',
    }),
    Object.assign(new MembershipEntity(), {
      id: 'mb_member',
      workspaceId: 'ws_1',
      userId: 'u_member',
      role: 'member',
    }),
  ];
  const memberships = {
    existsBy: async ({ role }: { role?: string }) =>
      role ? members.some((m) => m.role === role) : false,
    findOneBy: async () => null,
    countBy: async () => 0,
    save: async (m: MembershipEntity) => m,
  };
  const invites = { existsBy: async () => false };
  const workspaces = { save: vi.fn(async (w: WorkspaceEntity) => w) };
  const ds = {
    getRepository: () => invites,
    transaction: async (fn: (m: unknown) => Promise<void>) => fn({}),
  };
  const events = { publish: vi.fn() };
  const service = new WorkspacesService(
    ds as never,
    {} as never,
    events as never,
    workspaces as never,
    memberships as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, ws, workspaces };
}

describe('workspace roles', () => {
  it('creates a role with exactly the capabilities it was given', async () => {
    const { service, ws } = setup();
    await service.createRole(ctx(ws), {
      name: 'Support',
      capabilities: ['manageCustomers'],
      grants: ['customers:view'],
    });
    const support = ws.resolved().roles.find((role) => role.name === 'Support');
    expect(support).toMatchObject({
      owner: false,
      capabilities: ['manageCustomers'],
    });
    expect(support?.grants).toEqual(['customers:view']);
    expect(ws.resolved().roles.map((role) => role.id)).toContain('owner');
  });

  it('enforces that role and refuses a capability it does not have', async () => {
    const { service, ws } = setup();
    await service.createRole(ctx(ws), {
      name: 'Support',
      capabilities: ['manageCustomers'],
    });
    const support = ws
      .resolved()
      .roles.find((role) => role.name === 'Support')!;
    expect(
      roleAllows(
        support,
        { capability: 'manageCustomers', min: 'member', neededGrant: null },
        null,
      ),
    ).toBe(true);
    expect(
      roleAllows(
        support,
        { capability: 'deleteCustomers', min: 'member', neededGrant: null },
        null,
      ),
    ).toBe(false);
    expect(
      roleAllows(
        support,
        { capability: 'inviteMembers', min: 'admin', neededGrant: null },
        null,
      ),
    ).toBe(false);
    expect(
      roleHasCapability(ws.resolved().roles, 'owner', 'inviteMembers'),
    ).toBe(true);
  });

  it('refuses to delete the owner role', async () => {
    const { service, ws, workspaces } = setup();
    await expect(service.deleteRole(ctx(ws), 'owner')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(workspaces.save).not.toHaveBeenCalled();
    expect(ws.resolved().roles.some((role) => role.owner)).toBe(true);
  });

  it('refuses to delete a role someone still has, and deletes an unused one', async () => {
    const { service, ws } = setup();
    await service.createRole(ctx(ws), {
      name: 'Support',
      capabilities: ['createIssues'],
    });
    const support = ws
      .resolved()
      .roles.find((role) => role.name === 'Support')!;
    ws.settings = { roles: ws.resolved().roles };
    const held = setup();
    held.ws.settings = {
      roles: migrateLegacyRoles(DEFAULT_PERMISSIONS),
    };
    await expect(
      held.service.deleteRole(ctx(held.ws), 'member'),
    ).rejects.toBeInstanceOf(ConflictException);
    await service.deleteRole(ctx(ws), support.id);
    expect(ws.resolved().roles.some((role) => role.id === support.id)).toBe(
      false,
    );
  });

  it('migrates a member who was member onto a role with the same capabilities', () => {
    const settings = resolveWorkspaceSettings({
      permissions: { ...DEFAULT_PERMISSIONS, manageProjects: 'admin' },
      roleGrants: {
        member: roleGrants('member'),
        viewer: roleGrants('viewer'),
      },
    });
    const member = settings.roles.find((role) => role.id === 'member');
    expect(member).toMatchObject({ name: 'Member', owner: false });
    expect(member?.capabilities).toContain('createIssues');
    expect(member?.capabilities).not.toContain('manageProjects');
    expect(member?.capabilities).not.toContain('inviteMembers');
    expect(member?.grants).toEqual(roleGrants('member'));
    expect(roleHasCapability(settings.roles, 'member', 'createIssues')).toBe(
      true,
    );
    expect(
      roleAllows(member, { min: 'member', neededGrant: 'issues:create' }, null),
    ).toBe(true);
    expect(
      roleAllows(
        member,
        { capability: 'inviteMembers', min: 'member', neededGrant: null },
        null,
      ),
    ).toBe(false);
    const fresh = resolveWorkspaceSettings({ roles: freshWorkspaceRoles() });
    expect(fresh.roles.map((role) => role.id)).toEqual(['owner']);
  });

  it('keeps invite members on the owner role even when a save tries to remove it', async () => {
    const { service, ws } = setup();
    await service.updateRole(ctx(ws), 'owner', {
      capabilities: ['createIssues'],
    });
    expect(
      ws.resolved().roles.find((role) => role.owner)?.capabilities,
    ).toContain('inviteMembers');
    expect(
      ws.resolved().roles.find((role) => role.owner)?.capabilities,
    ).toContain('createIssues');
  });
});
