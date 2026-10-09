import { ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { Role } from '../contracts/domain.js';
import {
  PRIMARY_OWNER_PROTECTED,
  assertCanChangeRole,
  assertCanRemoveMember,
  assertCanTransferOwnership,
  type MemberRuleContext,
} from './member-rules.js';

const PRIMARY = 'u_primary';
const OTHER_OWNER = 'u_owner2';
const ADMIN = 'u_admin';
const MEMBER = 'u_member';

const ws = (over: Partial<MemberRuleContext> = {}): MemberRuleContext => ({
  primaryOwnerId: PRIMARY,
  ownerCount: 2,
  ...over,
});
const actor = (userId: string, role: Role) => ({ userId, role });
const target = (userId: string, role: Role) => ({ userId, role });

describe('removing a member', () => {
  it('members cannot remove anyone else (403), but may leave', () => {
    expect(() => assertCanRemoveMember(ws(), actor(MEMBER, 'member'), target(ADMIN, 'admin'))).toThrow(ForbiddenException);
    expect(() => assertCanRemoveMember(ws(), actor(MEMBER, 'member'), target(MEMBER, 'member'))).not.toThrow();
  });

  it('admins remove members and other admins, but never an owner (403)', () => {
    expect(() => assertCanRemoveMember(ws(), actor(ADMIN, 'admin'), target(MEMBER, 'member'))).not.toThrow();
    expect(() => assertCanRemoveMember(ws(), actor(ADMIN, 'admin'), target(OTHER_OWNER, 'owner'))).toThrow(ForbiddenException);
    expect(() => assertCanRemoveMember(ws(), actor(ADMIN, 'admin'), target(PRIMARY, 'owner'))).toThrow(PRIMARY_OWNER_PROTECTED);
  });

  it('the primary owner can never be removed by another owner (403)', () => {
    expect(() => assertCanRemoveMember(ws(), actor(OTHER_OWNER, 'owner'), target(PRIMARY, 'owner'))).toThrow(PRIMARY_OWNER_PROTECTED);
    expect(() => assertCanRemoveMember(ws(), actor(OTHER_OWNER, 'owner'), target(PRIMARY, 'owner'))).toThrow(ForbiddenException);
  });

  it('a non-primary owner cannot remove another non-primary owner (403)', () => {
    const w = ws({ ownerCount: 3 });
    expect(() => assertCanRemoveMember(w, actor(OTHER_OWNER, 'owner'), target('u_owner3', 'owner'))).toThrow(ForbiddenException);
  });

  it('the primary owner can remove another owner', () => {
    expect(() => assertCanRemoveMember(ws(), actor(PRIMARY, 'owner'), target(OTHER_OWNER, 'owner'))).not.toThrow();
  });

  it('an owner who is not the primary owner may leave on their own', () => {
    expect(() => assertCanRemoveMember(ws(), actor(OTHER_OWNER, 'owner'), target(OTHER_OWNER, 'owner'))).not.toThrow();
  });

  it('the primary owner cannot leave before transferring ownership (409)', () => {
    expect(() => assertCanRemoveMember(ws(), actor(PRIMARY, 'owner'), target(PRIMARY, 'owner'))).toThrow(ConflictException);
  });

  it('the last owner can never be removed (409)', () => {
    const solo = ws({ ownerCount: 1, primaryOwnerId: null });
    expect(() => assertCanRemoveMember(solo, actor(OTHER_OWNER, 'owner'), target(OTHER_OWNER, 'owner'))).toThrow(ConflictException);
    expect(() => assertCanRemoveMember(solo, actor(PRIMARY, 'owner'), target(PRIMARY, 'owner'))).toThrow(ConflictException);
  });

  it('legacy workspaces without a primary owner keep the old rule: any owner may remove another owner', () => {
    const legacy = ws({ primaryOwnerId: null });
    expect(() => assertCanRemoveMember(legacy, actor(OTHER_OWNER, 'owner'), target(PRIMARY, 'owner'))).not.toThrow();
    expect(() => assertCanRemoveMember(legacy, actor(ADMIN, 'admin'), target(PRIMARY, 'owner'))).toThrow(ForbiddenException);
  });

  it('a token without a user (agent) cannot remove an owner', () => {
    expect(() => assertCanRemoveMember(ws(), { role: 'member' }, target(OTHER_OWNER, 'owner'))).toThrow(ForbiddenException);
  });
});

describe('changing a role', () => {
  it('promoting or moving non-owners is not restricted here', () => {
    expect(() => assertCanChangeRole(ws(), actor(ADMIN, 'admin'), target(MEMBER, 'member'), 'admin')).not.toThrow();
    expect(() => assertCanChangeRole(ws(), actor(OTHER_OWNER, 'owner'), target(MEMBER, 'member'), 'owner')).not.toThrow();
    expect(() => assertCanChangeRole(ws(), actor(ADMIN, 'admin'), target(OTHER_OWNER, 'owner'), 'owner')).not.toThrow();
  });

  it('demoting the primary owner is refused to everyone else (403)', () => {
    expect(() => assertCanChangeRole(ws(), actor(OTHER_OWNER, 'owner'), target(PRIMARY, 'owner'), 'admin')).toThrow(PRIMARY_OWNER_PROTECTED);
    expect(() => assertCanChangeRole(ws(), actor(ADMIN, 'admin'), target(PRIMARY, 'owner'), 'member')).toThrow(ForbiddenException);
  });

  it('the primary owner cannot step down before transferring ownership (409)', () => {
    expect(() => assertCanChangeRole(ws(), actor(PRIMARY, 'owner'), target(PRIMARY, 'owner'), 'admin')).toThrow(ConflictException);
  });

  it('an owner cannot demote another non-primary owner unless they are the primary owner (403)', () => {
    const w = ws({ ownerCount: 3 });
    expect(() => assertCanChangeRole(w, actor(OTHER_OWNER, 'owner'), target('u_owner3', 'owner'), 'admin')).toThrow(ForbiddenException);
    expect(() => assertCanChangeRole(w, actor(PRIMARY, 'owner'), target('u_owner3', 'owner'), 'admin')).not.toThrow();
  });

  it('admins cannot demote an owner (403)', () => {
    expect(() => assertCanChangeRole(ws(), actor(ADMIN, 'admin'), target(OTHER_OWNER, 'owner'), 'member')).toThrow(ForbiddenException);
  });

  it('a non-primary owner may step down on their own', () => {
    expect(() => assertCanChangeRole(ws(), actor(OTHER_OWNER, 'owner'), target(OTHER_OWNER, 'owner'), 'admin')).not.toThrow();
  });

  it('the last owner can never be demoted (409)', () => {
    const solo = ws({ ownerCount: 1 });
    expect(() => assertCanChangeRole(solo, actor(PRIMARY, 'owner'), target(PRIMARY, 'owner'), 'admin')).toThrow(ConflictException);
    const legacy = ws({ ownerCount: 1, primaryOwnerId: null });
    expect(() => assertCanChangeRole(legacy, actor(OTHER_OWNER, 'owner'), target(OTHER_OWNER, 'owner'), 'admin')).toThrow(ConflictException);
  });

  it('legacy workspaces without a primary owner: owners may demote each other as before', () => {
    const legacy = ws({ primaryOwnerId: null });
    expect(() => assertCanChangeRole(legacy, actor(OTHER_OWNER, 'owner'), target(PRIMARY, 'owner'), 'admin')).not.toThrow();
  });
});

describe('transferring ownership', () => {
  it('only the primary owner can transfer (403 for other owners, admins and members)', () => {
    expect(() => assertCanTransferOwnership(ws(), actor(PRIMARY, 'owner'), MEMBER)).not.toThrow();
    expect(() => assertCanTransferOwnership(ws(), actor(OTHER_OWNER, 'owner'), MEMBER)).toThrow(ForbiddenException);
    expect(() => assertCanTransferOwnership(ws(), actor(ADMIN, 'admin'), MEMBER)).toThrow(ForbiddenException);
    expect(() => assertCanTransferOwnership(ws(), actor(MEMBER, 'member'), MEMBER)).toThrow(ForbiddenException);
  });

  it('a token capped below owner cannot transfer even for the primary owner (403)', () => {
    expect(() => assertCanTransferOwnership(ws(), actor(PRIMARY, 'member'), MEMBER)).toThrow(ForbiddenException);
  });

  it('transferring to the current primary owner is a conflict (409)', () => {
    expect(() => assertCanTransferOwnership(ws(), actor(PRIMARY, 'owner'), PRIMARY)).toThrow(ConflictException);
  });

  it('without a recorded primary owner any owner may claim it', () => {
    expect(() => assertCanTransferOwnership(ws({ primaryOwnerId: null }), actor(OTHER_OWNER, 'owner'), OTHER_OWNER)).not.toThrow();
  });
});
