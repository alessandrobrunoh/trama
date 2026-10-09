import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { SESSION_ONLY_KEY } from '../auth/request-context.js';
import type { Role } from '../contracts/domain.js';
import { MembershipEntity, WorkspaceEntity } from '../database/entities/index.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DeleteWorkspaceDto, WorkspaceController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

function setup(roles: Record<string, Role>, primaryOwnerId: string | null = 'u_primary') {
  const ws = Object.assign(new WorkspaceEntity(), { id: 'ws_1', name: 'Acme Inc', slug: 'acme', primaryOwnerId });
  const members = Object.entries(roles).map(([userId, role]) =>
    Object.assign(new MembershipEntity(), { id: `mb_${userId}`, workspaceId: 'ws_1', userId, role }),
  );
  const memberships = {
    findOneBy: async ({ id }: { id: string }) => members.find((m) => m.id === id) ?? null,
    countBy: async ({ role }: { role: Role }) => members.filter((m) => m.role === role).length,
    save: async (m: MembershipEntity) => m,
  };
  const workspaces = { save: vi.fn(async (w: WorkspaceEntity) => w), delete: vi.fn(async () => undefined) };
  const tx = { delete: vi.fn(async () => undefined), findBy: vi.fn(async () => []), update: vi.fn() };
  const ds = { transaction: async (fn: (m: typeof tx) => Promise<void>) => fn(tx) };
  const events = { publish: vi.fn() };
  const users = { findOneBy: async ({ id }: { id: string }) => ({ id }) };
  const service = new WorkspacesService(
    ds as never,
    {} as never,
    events as never,
    workspaces as never,
    memberships as never,
    users as never,
    {} as never,
    {} as never,
  );
  return { service, ws, members, workspaces, tx, events };
}

const ROLES = { u_primary: 'owner', u_owner2: 'owner', u_admin: 'admin', u_member: 'member' } as const;
const as = (userId: string, role: Role) => ({ userId, role });

describe('deleting a workspace needs the slug or name', () => {
  it('refuses a missing, empty or wrong confirmation (400) and deletes nothing', async () => {
    const { service, ws, workspaces } = setup(ROLES);
    for (const typed of ['', '   ', 'acm', 'ACME', 'acme-inc', 'Acme']) {
      await expect(service.remove(ws, typed)).rejects.toThrow(BadRequestException);
    }
    await expect(service.remove(ws, undefined as never)).rejects.toThrow(BadRequestException);
    expect(workspaces.delete).not.toHaveBeenCalled();
  });

  it('deletes when the slug or the exact name is given', async () => {
    const a = setup(ROLES);
    await a.service.remove(a.ws, 'acme');
    expect(a.workspaces.delete).toHaveBeenCalledWith({ id: 'ws_1' });
    const b = setup(ROLES);
    await b.service.remove(b.ws, ' Acme Inc ');
    expect(b.workspaces.delete).toHaveBeenCalledWith({ id: 'ws_1' });
  });
});

describe('DELETE /w/:slug body', () => {
  const errors = (body: object) => validate(plainToInstance(DeleteWorkspaceDto, body));
  it('requires a non-empty string `confirm` (400 before the service runs)', async () => {
    expect(await errors({})).not.toHaveLength(0);
    expect(await errors({ confirm: '' })).not.toHaveLength(0);
    expect(await errors({ confirm: 42 })).not.toHaveLength(0);
    expect(await errors({ confirm: 'acme' })).toHaveLength(0);
  });
});

describe('members through the service', () => {
  it('another owner cannot remove or demote the primary owner (403), nothing is written', async () => {
    const { service, ws, tx, events } = setup(ROLES);
    await expect(service.removeMember(ws, as('u_owner2', 'owner'), 'mb_u_primary')).rejects.toThrow(ForbiddenException);
    await expect(service.changeRole(ws, as('u_owner2', 'owner'), 'mb_u_primary', 'admin')).rejects.toThrow(ForbiddenException);
    expect(tx.delete).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('the primary owner can remove another owner, and the membership is deleted', async () => {
    const { service, ws, tx } = setup(ROLES);
    await service.removeMember(ws, as('u_primary', 'owner'), 'mb_u_owner2');
    expect(tx.delete).toHaveBeenCalledOnce();
  });

  it('the primary owner can demote another owner', async () => {
    const { service, ws, members } = setup(ROLES);
    await service.changeRole(ws, as('u_primary', 'owner'), 'mb_u_owner2', 'admin');
    expect(members.find((m) => m.userId === 'u_owner2')?.role).toBe('admin');
  });

  it('an unchanged role is a no-op even for a protected owner', async () => {
    const { service, ws } = setup(ROLES);
    await expect(service.changeRole(ws, as('u_owner2', 'owner'), 'mb_u_primary', 'owner')).resolves.toBeDefined();
  });

  it('the primary owner cannot leave or step down before transferring (409)', async () => {
    const { service, ws } = setup(ROLES);
    await expect(service.removeMember(ws, as('u_primary', 'owner'), 'mb_u_primary')).rejects.toThrow(ConflictException);
    await expect(service.changeRole(ws, as('u_primary', 'owner'), 'mb_u_primary', 'admin')).rejects.toThrow(ConflictException);
  });
});

describe('transferring ownership', () => {
  it('promotes the target, makes them the primary owner, and the old owner may then leave', async () => {
    const { service, ws, members, workspaces, events } = setup(ROLES);
    await service.transferOwnership(ws, as('u_primary', 'owner'), 'mb_u_member');
    expect(members.find((m) => m.userId === 'u_member')?.role).toBe('owner');
    expect(ws.primaryOwnerId).toBe('u_member');
    expect(workspaces.save).toHaveBeenCalledWith(ws);
    expect(events.publish).toHaveBeenCalledWith('ws_1', { type: 'updated', entity: 'workspace', id: 'ws_1' });

    await expect(service.removeMember(ws, as('u_primary', 'owner'), 'mb_u_primary')).resolves.toBeUndefined();
    // and the new primary owner is now the protected one
    await expect(service.removeMember(ws, as('u_owner2', 'owner'), 'mb_u_member')).rejects.toThrow(ForbiddenException);
  });

  it('only the primary owner can transfer (403) and not to themselves (409)', async () => {
    const { service, ws } = setup(ROLES);
    await expect(service.transferOwnership(ws, as('u_owner2', 'owner'), 'mb_u_member')).rejects.toThrow(ForbiddenException);
    await expect(service.transferOwnership(ws, as('u_admin', 'admin'), 'mb_u_member')).rejects.toThrow(ForbiddenException);
    await expect(service.transferOwnership(ws, as('u_primary', 'owner'), 'mb_u_primary')).rejects.toThrow(ConflictException);
    expect(ws.primaryOwnerId).toBe('u_primary');
  });

  it('is only reachable from a browser session, never by API token', () => {
    expect(Reflect.getMetadata(SESSION_ONLY_KEY, WorkspaceController.prototype.transferOwnership)).toBe(true);
  });
});
