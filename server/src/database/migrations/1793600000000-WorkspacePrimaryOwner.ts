import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A workspace remembers its primary owner (the creator until ownership is transferred), the only person who
 * can remove or demote other owners. Backfilled with the longest-standing owner of each workspace.
 */
export class WorkspacePrimaryOwner1793600000000 implements MigrationInterface {
  name = 'WorkspacePrimaryOwner1793600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workspaces" ADD "primaryOwnerId" character varying`);
    await q.query(
      `UPDATE "workspaces" w SET "primaryOwnerId" = (
         SELECT m."userId" FROM "memberships" m
         WHERE m."workspaceId" = w."id" AND m."role" = 'owner'
         ORDER BY m."createdAt" ASC, m."id" ASC LIMIT 1
       )`,
    );
    await q.query(
      `ALTER TABLE "workspaces" ADD CONSTRAINT "FK_workspaces_primary_owner" FOREIGN KEY ("primaryOwnerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workspaces" DROP CONSTRAINT "FK_workspaces_primary_owner"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN "primaryOwnerId"`);
  }
}
