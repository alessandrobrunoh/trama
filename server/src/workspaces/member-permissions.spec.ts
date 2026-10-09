import { describe, expect, it } from 'vitest';
import {
  LAST_OWNER,
  NEEDS_TRANSFER,
  ONLY_OWNERS,
  ONLY_PRIMARY_OWNER,
  OWNER_PROTECTED,
  memberRules,
  type MemberUiContext,
} from '../../../src/app/features/settings/sections/member-permissions.ts';

/** The Members UI must disable exactly what `member-rules.ts` refuses. */
const ctx = (over: Partial<MemberUiContext> = {}): MemberUiContext => ({
  meId: 'u_primary',
  myRole: 'owner',
  primaryOwnerId: 'u_primary',
  ownerCount: 2,
  ...over,
});

describe('member row rules in the UI', () => {
  it('the primary owner can manage everyone else and transfer ownership', () => {
    expect(memberRules(ctx(), { userId: 'u_owner2', role: 'owner' })).toEqual({ roleLocked: null, removeLocked: null, canTransfer: true });
    expect(memberRules(ctx(), { userId: 'u_member', role: 'member' }).canTransfer).toBe(true);
  });

  it('the primary owner cannot step down or leave until they transfer ownership', () => {
    const r = memberRules(ctx(), { userId: 'u_primary', role: 'owner' });
    expect(r.roleLocked).toBe(NEEDS_TRANSFER);
    expect(r.removeLocked).toBe(NEEDS_TRANSFER);
    expect(r.canTransfer).toBe(false);
  });

  it('nobody else can change the primary owner', () => {
    const other = ctx({ meId: 'u_owner2' });
    expect(memberRules(other, { userId: 'u_primary', role: 'owner' }).removeLocked).toBe(OWNER_PROTECTED);
    const admin = ctx({ meId: 'u_admin', myRole: 'admin' });
    expect(memberRules(admin, { userId: 'u_primary', role: 'owner' }).roleLocked).toBe(OWNER_PROTECTED);
  });

  it('another owner cannot touch a peer owner, an admin cannot touch any owner', () => {
    const other = ctx({ meId: 'u_owner2', ownerCount: 3 });
    expect(memberRules(other, { userId: 'u_owner3', role: 'owner' }).roleLocked).toBe(ONLY_PRIMARY_OWNER);
    expect(memberRules(other, { userId: 'u_owner3', role: 'owner' }).canTransfer).toBe(false);
    const admin = ctx({ meId: 'u_admin', myRole: 'admin' });
    expect(memberRules(admin, { userId: 'u_owner2', role: 'owner' }).removeLocked).toBe(ONLY_OWNERS);
    expect(memberRules(admin, { userId: 'u_member', role: 'member' }).removeLocked).toBeNull();
  });

  it('a non-primary owner can step down or leave', () => {
    const other = ctx({ meId: 'u_owner2' });
    expect(memberRules(other, { userId: 'u_owner2', role: 'owner' })).toEqual({ roleLocked: null, removeLocked: null, canTransfer: false });
  });

  it('the last owner is locked', () => {
    const solo = ctx({ meId: 'u_owner2', primaryOwnerId: undefined, ownerCount: 1 });
    expect(memberRules(solo, { userId: 'u_owner2', role: 'owner' }).removeLocked).toBe(LAST_OWNER);
  });

  it('legacy workspaces without a primary owner: owners act on owners, anyone can be handed the workspace', () => {
    const legacy = ctx({ primaryOwnerId: undefined, meId: 'u_owner2' });
    expect(memberRules(legacy, { userId: 'u_primary', role: 'owner' }).removeLocked).toBeNull();
    expect(memberRules(legacy, { userId: 'u_member', role: 'member' }).canTransfer).toBe(true);
  });
});
