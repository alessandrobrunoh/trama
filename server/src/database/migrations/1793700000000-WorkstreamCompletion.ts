import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A workstream with no acceptance criteria no longer ships by derivation (nothing defines "done").
 * To leave history untouched, every workstream whose facts currently derive `shipped` while it has
 * zero criteria is marked `legacyShipped`: the derivation keeps shipping it, so statuses, `shippedAt`
 * and dependency cascades (`resolved = shipped`) stay exactly as they were. New workstreams never
 * get the flag. `completion` is filled by the boot-time status recompute.
 */
export class WorkstreamCompletion1793700000000 implements MigrationInterface {
  name = 'WorkstreamCompletion1793700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "workstreams" ADD "completion" jsonb NOT NULL DEFAULT '{"achieved":false,"gaps":[]}'`,
    );
    await q.query(`ALTER TABLE "workstreams" ADD "legacyShipped" boolean NOT NULL DEFAULT false`);
    await q.query(
      `UPDATE "workstreams" SET "legacyShipped" = true
       WHERE "derivedStatus" = 'shipped' AND jsonb_array_length("acceptanceCriteria") = 0`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workstreams" DROP COLUMN "legacyShipped"`);
    await q.query(`ALTER TABLE "workstreams" DROP COLUMN "completion"`);
  }
}
