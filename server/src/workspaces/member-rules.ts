import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Role } from '../contracts/domain.js';
import { hasRole } from '../auth/request-context.js';

/**
 * Who may remove or demote whom. Pure functions so every rule is covered by a unit test.
 *
 * - The primary owner (the creator, until ownership is transferred) can never be removed or demoted by anyone
 *   else (`403`). To stop being owner they transfer ownership first; leaving or stepping down before that is `409`.
 * - Only the primary owner removes or demotes other owners (`403` for admins, who cannot touch owners at all,
 *   and for other owners). An owner may always step down or leave on their own.
 * - A workspace always keeps at least one owner (`409`).
 * - Workspaces without a recorded primary owner (legacy rows) fall back to "any owner may act on owners".
 */
export interface MemberActor {
  /** Effective role of the caller (capped by the token scope). */
  role: Role;
  userId?: string;
}

export interface MemberTarget {
  userId: string;
  role: Role;
}

export interface MemberRuleContext {
  primaryOwnerId?: string | null;
  /** Number of owners the workspace has right now. */
  ownerCount: number;
}

export const PRIMARY_OWNER_PROTECTED =
  'The workspace owner cannot be removed or demoted by someone else. They can transfer ownership first.';

function isPrimary(ws: Pick<MemberRuleContext, 'primaryOwnerId'>, userId: string | undefined): boolean {
  return !!userId && !!ws.primaryOwnerId && ws.primaryOwnerId === userId;
}

/** May this caller act on `target` as an owner-level change (remove or demote)? Throws otherwise. */
function assertCanActOnOwner(ws: MemberRuleContext, actor: MemberActor, target: MemberTarget, verb: string): void {
  const self = !!actor.userId && actor.userId === target.userId;
  if (self) return;
  if (isPrimary(ws, target.userId)) throw new ForbiddenException(PRIMARY_OWNER_PROTECTED);
  if (actor.role !== 'owner') throw new ForbiddenException(`Only an owner can ${verb} an owner`);
  // with a recorded primary owner, other owners are peers: only the primary owner governs them
  if (ws.primaryOwnerId && !isPrimary(ws, actor.userId))
    throw new ForbiddenException(`Only the workspace owner can ${verb} another owner`);
}

function assertStillHasOwner(ws: MemberRuleContext, target: MemberTarget, verb: string): void {
  if (target.role === 'owner' && ws.ownerCount <= 1)
    throw new ConflictException(`A workspace needs at least one owner: transfer ownership before you ${verb}`);
}

function assertPrimaryOwnerTransfersFirst(ws: MemberRuleContext, target: MemberTarget, verb: string): void {
  if (isPrimary(ws, target.userId))
    throw new ConflictException(`Transfer ownership to another member before you ${verb}`);
}

/** Removing a membership (or leaving: caller = target). */
export function assertCanRemoveMember(ws: MemberRuleContext, actor: MemberActor, target: MemberTarget): void {
  const self = !!actor.userId && actor.userId === target.userId;
  if (!self && !hasRole(actor.role, 'admin')) throw new ForbiddenException('Requires role admin or higher');
  if (target.role !== 'owner') return;
  assertCanActOnOwner(ws, actor, target, 'remove');
  if (self) assertPrimaryOwnerTransfersFirst(ws, target, 'leave');
  assertStillHasOwner(ws, target, 'leave');
}

/** Changing a role. Demoting an owner counts as removing them; promoting is checked by the caller (`assertCanGrant`). */
export function assertCanChangeRole(ws: MemberRuleContext, actor: MemberActor, target: MemberTarget, next: Role): void {
  if (target.role !== 'owner' || next === 'owner') return;
  assertCanActOnOwner(ws, actor, target, 'demote');
  if (!!actor.userId && actor.userId === target.userId) assertPrimaryOwnerTransfersFirst(ws, target, 'step down');
  assertStillHasOwner(ws, target, 'step down');
}

/** Only the primary owner (any owner when none is recorded) hands the workspace over, and only to another member. */
export function assertCanTransferOwnership(ws: Pick<MemberRuleContext, 'primaryOwnerId'>, actor: MemberActor, targetUserId: string): void {
  if (actor.role !== 'owner') throw new ForbiddenException('Only an owner can transfer ownership');
  if (ws.primaryOwnerId && !isPrimary(ws, actor.userId))
    throw new ForbiddenException('Only the workspace owner can transfer ownership');
  if (ws.primaryOwnerId === targetUserId) throw new ConflictException('That person already owns the workspace');
}
