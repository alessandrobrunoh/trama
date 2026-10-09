import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Workstreams expose delivery evidence (none / in_review / merged / released / deployed)
 * separately from the outcome status. Existing rows start at `none`; the boot-time status
 * recompute fills in the real value from their artifacts.
 */
export class WorkstreamDelivery1793100000500 implements MigrationInterface {
  name = 'WorkstreamDelivery1793100000500';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workstreams" ADD "delivery" character varying NOT NULL DEFAULT 'none'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workstreams" DROP COLUMN "delivery"`);
  }
}
