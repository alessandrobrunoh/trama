import { MigrationInterface, QueryRunner } from 'typeorm';
import { freshWorkspaceRoles } from '../../contracts/domain.js';
import { uid } from '../../common/util.js';
import { freeSlug } from '../../workspaces/workspace-slug.js';

/**
 * Every account gets a personal workspace (`personal = true`, one per user), and a person can show a project
 * shared with them in one of their own workspaces (`project_placements`, per user, grants no access).
 * Existing users are backfilled with a personal workspace named after them; their other workspaces are untouched.
 */
export class PersonalWorkspaces1794100000000 implements MigrationInterface {
  name = 'PersonalWorkspaces1794100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "workspaces" ADD "personal" boolean NOT NULL DEFAULT false`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_workspaces_personal_owner" ON "workspaces" ("primaryOwnerId") WHERE "personal"`,
    );
    await q.query(
      `CREATE TABLE "project_placements" (
         "id" character varying NOT NULL,
         "userId" character varying NOT NULL,
         "projectId" character varying NOT NULL,
         "workspaceId" character varying,
         "position" integer NOT NULL DEFAULT 0,
         "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
         CONSTRAINT "PK_project_placements" PRIMARY KEY ("id")
       )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_project_placements_user_project" ON "project_placements" ("userId", "projectId")`,
    );
    await q.query(
      `CREATE INDEX "IDX_project_placements_workspace" ON "project_placements" ("workspaceId")`,
    );
    await q.query(
      `ALTER TABLE "project_placements" ADD CONSTRAINT "FK_project_placements_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "project_placements" ADD CONSTRAINT "FK_project_placements_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "project_placements" ADD CONSTRAINT "FK_project_placements_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await this.backfill(q);
  }

  /** Same shape `WorkspacesService.create` writes: the four default roles, the person as owner and primary owner. */
  private async backfill(q: QueryRunner): Promise<void> {
    const users = (await q.query(
      `SELECT u."id", u."name" FROM "users" u ORDER BY u."createdAt", u."id"`,
    )) as { id: string; name: string }[];
    if (!users.length) return;
    const taken = new Set(
      ((await q.query(`SELECT "slug" FROM "workspaces"`)) as { slug: string }[]).map((row) => row.slug),
    );
    const settings = JSON.stringify({ roles: freshWorkspaceRoles() });
    for (const user of users) {
      const slug = freeSlug(user.name, (candidate) => taken.has(candidate), 'personal');
      taken.add(slug);
      const id = uid('ws');
      await q.query(
        `INSERT INTO "workspaces" ("id", "name", "slug", "settings", "primaryOwnerId", "personal")
         VALUES ($1, $2, $3, $4::jsonb, $5, true)`,
        [id, user.name.trim().slice(0, 80) || 'Personal', slug, settings, user.id],
      );
      await q.query(
        `INSERT INTO "memberships" ("id", "workspaceId", "userId", "role") VALUES ($1, $2, $3, 'owner')`,
        [uid('mb'), id, user.id],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "project_placements"`);
    await q.query(`DELETE FROM "workspaces" WHERE "personal"`);
    await q.query(`DROP INDEX "UQ_workspaces_personal_owner"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN "personal"`);
  }
}
