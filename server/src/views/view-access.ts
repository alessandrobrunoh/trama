import type { Role, ShareLevel, SharingSettings } from '../contracts/domain.js';
import { hasRole } from '../auth/request-context.js';

/** The caller as far as view permissions are concerned. */
export interface ViewActor {
  /** Absent for agent tokens (they can read shared views, never own or be granted one). */
  userId?: string;
  role: Role;
}

/** The part of a view the access rules look at. */
export interface ViewAccessSubject {
  ownerId: string;
  sharing: SharingSettings;
}

export const DEFAULT_SHARING: SharingSettings = { visibility: 'private', grants: [] };

export function isOwner(view: ViewAccessSubject, actor: ViewActor): boolean {
  return !!actor.userId && view.ownerId === actor.userId;
}

/** The level `actor` was explicitly granted, if any. */
export function grantLevel(view: ViewAccessSubject, actor: ViewActor): ShareLevel | null {
  if (!actor.userId) return null;
  return view.sharing.grants.find((g) => g.userId === actor.userId)?.level ?? null;
}

/** Owner, invited people, or (for workspace/link views) any workspace member. */
export function canReadView(view: ViewAccessSubject, actor: ViewActor): boolean {
  return isOwner(view, actor) || view.sharing.visibility !== 'private' || grantLevel(view, actor) !== null;
}

/**
 * Change the view's definition (name, filters, sort…): the owner, people granted `edit`, and
 * workspace admins for views that are shared beyond their owner.
 */
export function canEditView(view: ViewAccessSubject, actor: ViewActor): boolean {
  if (isOwner(view, actor)) return true;
  if (grantLevel(view, actor) === 'edit' && hasRole(actor.role, 'member')) return true;
  return view.sharing.visibility !== 'private' && hasRole(actor.role, 'admin');
}

/** Change who has access (visibility, invitations, public link) or delete the view. */
export function canManageSharing(view: ViewAccessSubject, actor: ViewActor): boolean {
  return isOwner(view, actor) || (view.sharing.visibility !== 'private' && hasRole(actor.role, 'admin'));
}
