import { MigrationInterface, QueryRunner } from 'typeorm';

/** Last title and description agreed by a push, pull, or identical realign. Null means no baseline yet. */
export class LunaGestSyncBaseline1793820000000 implements MigrationInterface {
  name = 'LunaGestSyncBaseline1793820000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lunagest_issue_links" ADD "syncedTitle" text`);
    await q.query(`ALTER TABLE "lunagest_issue_links" ADD "syncedBody" text`);
    await q.query(`ALTER TABLE "lunagest_project_links" ADD "syncedName" text`);
    await q.query(`ALTER TABLE "lunagest_project_links" ADD "syncedDescription" text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "lunagest_project_links" DROP COLUMN "syncedDescription"`);
    await q.query(`ALTER TABLE "lunagest_project_links" DROP COLUMN "syncedName"`);
    await q.query(`ALTER TABLE "lunagest_issue_links" DROP COLUMN "syncedBody"`);
    await q.query(`ALTER TABLE "lunagest_issue_links" DROP COLUMN "syncedTitle"`);
  }
}
