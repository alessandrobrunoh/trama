import type { Role, SavedView } from '../../core';

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const atLeast = (role: Role | null | undefined, min: Role): boolean => !!role && RANK[role] >= RANK[min];

/** Client mirror of the server rules (server/src/views/view-access.ts); the server stays the authority. */
export function canEditSavedView(view: SavedView, userId: string | undefined, role: Role | null | undefined): boolean {
  if (!userId || !atLeast(role, 'member')) return false;
  if (view.ownerId === userId) return true;
  if (view.sharing.grants.some((g) => g.userId === userId && g.level === 'edit')) return true;
  return view.sharing.visibility !== 'private' && atLeast(role, 'admin');
}

/** Change who has access, or delete the view. */
export function canManageViewSharing(view: SavedView, userId: string | undefined, role: Role | null | undefined): boolean {
  if (!userId || !atLeast(role, 'member')) return false;
  return view.ownerId === userId || (view.sharing.visibility !== 'private' && atLeast(role, 'admin'));
}

/** The public URL of a link-shared view (only managers receive the token). */
export function publicViewUrl(view: SavedView): string | null {
  return view.publicToken ? `${location.origin}/shared/${view.publicToken}` : null;
}
