import { MigrationInterface, QueryRunner } from 'typeorm';

interface StoredRole {
  id?: unknown;
  name?: unknown;
  owner?: unknown;
  capabilities?: unknown;
  grants?: unknown;
}

const ORGANIZER = {
  id: 'organizer',
  name: 'Organizer',
  owner: false,
  capabilities: ['manageProjects', 'createIssues', 'deleteIssues', 'manageSharedViews', 'inviteToProject'],
  grants: [
    'projects:view',
    'projects:create',
    'projects:update',
    'projects:delete',
    'milestones:view',
    'milestones:create',
    'milestones:update',
    'milestones:delete',
    'issues:view',
    'issues:create',
    'issues:update',
    'issues:delete',
    'artifacts:view',
    'artifacts:create',
    'artifacts:update',
    'artifacts:delete',
    'views:view',
    'views:create',
    'views:update',
    'views:delete',
    'comments:view',
    'comments:create',
    'comments:update',
    'comments:delete',
  ],
};

const GUEST = {
  id: 'guest',
  name: 'Guest',
  owner: false,
  capabilities: ['createIssues'],
  grants: [
    'projects:view',
    'milestones:view',
    'issues:view',
    'issues:create',
    'issues:update',
    'artifacts:view',
    'comments:view',
    'comments:create',
    'comments:update',
  ],
};

/**
 * Adds the default Organizer and Guest roles to workspaces that already store their roles, and the new
 * "Share projects" capability (`inviteToProject`) to every role that could already invite members.
 * Workspaces that never stored roles get all of it from the defaults. A role that already uses one of the
 * two ids is left untouched, and so is every other role.
 */
export class GuestOrganizerRoles1794000000000 implements MigrationInterface {
  name = 'GuestOrganizerRoles1794000000000';

  public async up(q: QueryRunner): Promise<void> {
    const rows: { id: string; settings: { roles?: unknown } | null }[] = await q.query(
      `SELECT "id", "settings" FROM "workspaces"`,
    );
    for (const row of rows) {
      const roles = row.settings?.roles;
      if (!Array.isArray(roles)) continue;
      const next: StoredRole[] = (roles as StoredRole[]).map((role) => {
        const caps = Array.isArray(role?.capabilities) ? (role.capabilities as unknown[]) : [];
        if (caps.includes('inviteMembers') && !caps.includes('inviteToProject'))
          return { ...role, capabilities: [...caps, 'inviteToProject'] };
        return role;
      });
      const has = (id: string) => next.some((role) => role?.id === id);
      if (!has(ORGANIZER.id)) next.push({ ...ORGANIZER, capabilities: [...ORGANIZER.capabilities], grants: [...ORGANIZER.grants] });
      if (!has(GUEST.id)) next.push({ ...GUEST, capabilities: [...GUEST.capabilities], grants: [...GUEST.grants] });
      await q.query(`UPDATE "workspaces" SET "settings" = $1::jsonb WHERE "id" = $2`, [
        JSON.stringify({ ...row.settings, roles: next }),
        row.id,
      ]);
    }
  }

  /** The two roles may be in use by now, so they stay. Only the capability is taken back. */
  public async down(q: QueryRunner): Promise<void> {
    const rows: { id: string; settings: { roles?: unknown } | null }[] = await q.query(
      `SELECT "id", "settings" FROM "workspaces"`,
    );
    for (const row of rows) {
      const roles = row.settings?.roles;
      if (!Array.isArray(roles)) continue;
      const next = (roles as StoredRole[]).map((role) => ({
        ...role,
        capabilities: Array.isArray(role?.capabilities)
          ? (role.capabilities as unknown[]).filter((cap) => cap !== 'inviteToProject')
          : role?.capabilities,
      }));
      await q.query(`UPDATE "workspaces" SET "settings" = $1::jsonb WHERE "id" = $2`, [
        JSON.stringify({ ...row.settings, roles: next }),
        row.id,
      ]);
    }
  }
}
