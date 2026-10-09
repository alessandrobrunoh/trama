import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Generic sharing settings on saved views: `sharing` (visibility + per-user grants) and the public
 * link token (stored as a sha256 for lookup, plus an encrypted copy so managers can copy the link).
 * Existing shared views become `workspace` visible; private ones stay `private`.
 */
export class ViewSharing1793200000000 implements MigrationInterface {
  name = 'ViewSharing1793200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "saved_views" ADD "sharing" jsonb NOT NULL DEFAULT '{"visibility":"private","grants":[]}'`);
    await q.query(`ALTER TABLE "saved_views" ADD "publicTokenHash" character varying`);
    await q.query(`ALTER TABLE "saved_views" ADD "publicTokenEnc" text`);
    await q.query(`UPDATE "saved_views" SET "sharing" = '{"visibility":"workspace","grants":[]}' WHERE "shared" = true`);
    await q.query(`CREATE UNIQUE INDEX "UQ_views_public_token" ON "saved_views" ("publicTokenHash")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "UQ_views_public_token"`);
    await q.query(`ALTER TABLE "saved_views" DROP COLUMN "publicTokenEnc"`);
    await q.query(`ALTER TABLE "saved_views" DROP COLUMN "publicTokenHash"`);
    await q.query(`ALTER TABLE "saved_views" DROP COLUMN "sharing"`);
  }
}
