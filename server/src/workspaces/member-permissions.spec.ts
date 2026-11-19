import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertCanChangeRole,
  assertCanRemoveMember,
  assertCanTransferOwnership,
  type MemberRuleContext,
} from './member-rules.js';

/** Server rules behind the members screen. Do not import the frontend module (it sits outside the server rootDir). */
const ctx = (over: Partial<MemberRuleContext> = {}): MemberRuleContext => ({
  primaryOwnerId: 'u_primary',
  ownerCount: 2,
  ...over,
});

describe('member rules', () => {
  it('the primary owner can manage everyone else and transfer ownership', () => {
    expect(() => assertCanChangeRole(ctx(), { userId: 'u_primary', role: 'owner' }, { userId: 'u_owner2', role: 'owner' }, 'member')).not.toThrow();
    expect(() => assertCanRemoveMember(ctx(), { userId: 'u_primary', role: 'owner' }, { userId: 'u_member', role: 'member' })).not.toThrow();
    expect(() => assertCanTransferOwnership({ primaryOwnerId: 'u_primary' }, { userId: 'u_primary', role: 'owner' }, 'u_member')).not.toThrow();
  });

  it('the primary owner cannot step down or leave until they transfer ownership', () => {
    expect(() => assertCanChangeRole(ctx(), { userId: 'u_primary', role: 'owner' }, { userId: 'u_primary', role: 'owner' }, 'member')).toThrow(ConflictException);
    expect(() => assertCanRemoveMember(ctx(), { userId: 'u_primary', role: 'owner' }, { userId: 'u_primary', role: 'owner' })).toThrow(ConflictException);
    expect(() => assertCanTransferOwnership({ primaryOwnerId: 'u_primary' }, { userId: 'u_primary', role: 'owner' }, 'u_primary')).toThrow();
  });

  it('nobody else can change the primary owner', () => {
    expect(() => assertCanRemoveMember(ctx(), { userId: 'u_owner2', role: 'owner' }, { userId: 'u_primary', role: 'owner' })).toThrow(ForbiddenException);
    expect(() => assertCanChangeRole(ctx(), { userId: 'u_admin', role: 'admin' }, { userId: 'u_primary', role: 'owner' }, 'member')).toThrow(ForbiddenException);
  });

  it('another owner cannot touch a peer owner, an admin cannot touch any owner', () => {
    const other = ctx({ ownerCount: 3 });
    expect(() => assertCanChangeRole(other, { userId: 'u_owner2', role: 'owner' }, { userId: 'u_owner3', role: 'owner' }, 'member')).toThrow(ForbiddenException);
    expect(() => assertCanTransferOwnership({ primaryOwnerId: 'u_primary' }, { userId: 'u_owner2', role: 'owner' }, 'u_owner3')).toThrow(ForbiddenException);
    expect(() => assertCanRemoveMember(ctx(), { userId: 'u_admin', role: 'admin' }, { userId: 'u_owner2', role: 'owner' })).toThrow(ForbiddenException);
    expect(() => assertCanRemoveMember(ctx(), { userId: 'u_admin', role: 'admin' }, { userId: 'u_member', role: 'member' })).not.toThrow();
  });

  it('a non-primary owner can step down or leave', () => {
    const other = ctx();
    expect(() => assertCanChangeRole(other, { userId: 'u_owner2', role: 'owner' }, { userId: 'u_owner2', role: 'owner' }, 'member')).not.toThrow();
    expect(() => assertCanRemoveMember(other, { userId: 'u_owner2', role: 'owner' }, { userId: 'u_owner2', role: 'owner' })).not.toThrow();
  });

  it('the last owner is locked', () => {
    const solo = ctx({ primaryOwnerId: undefined, ownerCount: 1 });
    expect(() => assertCanRemoveMember(solo, { userId: 'u_owner2', role: 'owner' }, { userId: 'u_owner2', role: 'owner' })).toThrow(ConflictException);
  });

  it('legacy workspaces without a primary owner: owners act on owners', () => {
    const legacy = ctx({ primaryOwnerId: undefined });
    expect(() => assertCanRemoveMember(legacy, { userId: 'u_owner2', role: 'owner' }, { userId: 'u_primary', role: 'owner' })).not.toThrow();
    expect(() => assertCanTransferOwnership({ primaryOwnerId: null }, { userId: 'u_owner2', role: 'owner' }, 'u_member')).not.toThrow();
  });
});
