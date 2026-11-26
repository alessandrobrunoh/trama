import {
  accessesShareProject,
  effectiveMemberAccess,
  findWorkspaceRole,
  isProjectLimited,
  type MemberAccess,
  type Role,
  type WorkspaceRole,
} from '../contracts/domain.js';

interface MembershipLike {
  userId: string;
  role: Role;
  access?: MemberAccess | null;
}

/**
 * The people a project-limited caller (a guest, or a member limited to a list) may see: themselves and
 * everybody who works on at least one of their projects. Someone with every project is on all of them,
 * so they are visible too. Anyone else is not listed. An unlimited caller sees everyone.
 */
export function visibleMemberships<T extends MembershipLike>(
  rows: readonly T[],
  roles: readonly WorkspaceRole[],
  caller: MemberAccess | null | undefined,
  selfUserId: string | undefined,
): T[] {
  if (!isProjectLimited(caller)) return [...rows];
  return rows
    .filter((row) => {
      if (row.userId === selfUserId) return true;
      const theirs = effectiveMemberAccess(findWorkspaceRole(roles, row.role), row.access ?? null);
      return accessesShareProject(caller, theirs);
    })
    .map((row) => (row.userId === selfUserId ? row : hideOtherProjects(row, caller!)));
}

/**
 * Someone else's project list only names projects the caller also has: the rest are not the caller's to know.
 * Keeps the row's prototype so entity serialization (`Wire.toJSON`) still applies.
 */
function hideOtherProjects<T extends MembershipLike>(row: T, caller: MemberAccess): T {
  const access = row.access;
  if (!access || access.projects.all) return row;
  const copy = Object.assign(Object.create(Object.getPrototypeOf(row)) as T, row);
  (copy as MembershipLike).access = {
    ...access,
    projects: {
      all: false,
      projectIds: access.projects.projectIds.filter((id) => caller.projects.projectIds.includes(id)),
    },
  };
  return copy;
}

/** Ids of the users who may appear next to the caller: the people of {@link visibleMemberships}. */
export function visibleUserIds(
  rows: readonly MembershipLike[],
  roles: readonly WorkspaceRole[],
  caller: MemberAccess | null | undefined,
  selfUserId: string | undefined,
): Set<string> {
  return new Set(visibleMemberships(rows, roles, caller, selfUserId).map((row) => row.userId));
}
