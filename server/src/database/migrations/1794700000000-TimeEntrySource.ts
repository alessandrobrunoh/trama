import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `time_entries.source`: `timer`, `manual` or `suggested` (sent by `trama sync`, not counted until a
 * person accepts it). Rows that exist already cannot tell a timer from a manual add, so they are `manual`.
 */
export class TimeEntrySource1794700000000 implements MigrationInterface {
  name = 'TimeEntrySource1794700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "time_entries" ADD COLUMN "source" character varying NOT NULL DEFAULT 'manual'`,
    );
    await q.query(
      `CREATE INDEX "IDX_time_entries_source" ON "time_entries" ("workspaceId", "userId", "source")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_time_entries_source"`);
    await q.query(`ALTER TABLE "time_entries" DROP COLUMN "source"`);
  }
}
