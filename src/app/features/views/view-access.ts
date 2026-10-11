import { legacyRoleAtLeast, type Role, type SavedView } from '../../core';

export interface ViewPower {
  canWrite: boolean;
  canAdmin: boolean;
}

function canWrite(role: Role | null | undefined, power?: ViewPower): boolean {
  return power ? power.canWrite : legacyRoleAtLeast(role ?? '', 'member');
}
function canAdmin(role: Role | null | undefined, power?: ViewPower): boolean {
  return power ? power.canAdmin : legacyRoleAtLeast(role ?? '', 'admin');
}

/** Client mirror of the server rules (server/src/views/view-access.ts); the server stays the authority. */
export function canEditSavedView(view: SavedView, userId: string | undefined, role: Role | null | undefined, power?: ViewPower): boolean {
  if (!userId || !canWrite(role, power)) return false;
  if (view.ownerId === userId) return true;
  if (view.sharing.grants.some((g) => g.userId === userId && g.level === 'edit')) return true;
  return view.sharing.visibility !== 'private' && canAdmin(role, power);
}

/** Change who has access, or delete the view. */
export function canManageViewSharing(view: SavedView, userId: string | undefined, role: Role | null | undefined, power?: ViewPower): boolean {
  if (!userId || !canWrite(role, power)) return false;
  return view.ownerId === userId || (view.sharing.visibility !== 'private' && canAdmin(role, power));
}

/** The public URL of a link-shared view (only managers receive the token). */
export function publicViewUrl(view: SavedView): string | null {
  return view.publicToken ? `${location.origin}/shared/${view.publicToken}` : null;
}
