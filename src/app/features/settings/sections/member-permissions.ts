import type { ID, Role } from '../../../core/contracts/domain';

/**
 * What the Members list lets me do to a row. Mirrors the server rules (`server/src/workspaces/member-rules.ts`),
 * which stay authoritative: this only hides or disables what the API would refuse, and says why.
 */
export interface MemberUiContext {
  meId?: ID;
  myRole: Role | null;
  /** `Workspace.primaryOwnerId`; absent on legacy workspaces. */
  primaryOwnerId?: ID;
  ownerCount: number;
}

export interface MemberUiRules {
  /** Why the role cannot be changed (or the owner cannot be demoted), `null` when it can. */
  roleLocked: string | null;
  /** Why the member cannot be removed, `null` when they can. */
  removeLocked: string | null;
  /** Whether I can hand the workspace over to this person. */
  canTransfer: boolean;
}

export const NEEDS_TRANSFER = 'The workspace owner has to transfer ownership to someone else first.';
export const OWNER_PROTECTED = 'Only the workspace owner can change their own role or leave.';
export const ONLY_OWNERS = 'Only owners can change an owner.';
export const ONLY_PRIMARY_OWNER = 'Only the workspace owner can change other owners.';
export const LAST_OWNER = 'A workspace needs at least one owner.';

export function memberRules(ctx: MemberUiContext, target: { userId: ID; role: Role }): MemberUiRules {
  const self = !!ctx.meId && ctx.meId === target.userId;
  const iAmPrimary = !!ctx.meId && ctx.meId === ctx.primaryOwnerId;
  const iAmOwner = ctx.myRole === 'owner';
  const canTransfer =
    iAmOwner && !self && target.userId !== ctx.primaryOwnerId && (ctx.primaryOwnerId ? iAmPrimary : true);

  let locked: string | null = null;
  if (target.role === 'owner') {
    if (!self && target.userId === ctx.primaryOwnerId) locked = OWNER_PROTECTED;
    else if (!self && !iAmOwner) locked = ONLY_OWNERS;
    else if (!self && ctx.primaryOwnerId && !iAmPrimary) locked = ONLY_PRIMARY_OWNER;
    else if (self && target.userId === ctx.primaryOwnerId) locked = NEEDS_TRANSFER;
    else if (ctx.ownerCount <= 1) locked = LAST_OWNER;
  }
  return { roleLocked: locked, removeLocked: locked, canTransfer };
}
