import { MigrationInterface, QueryRunner } from 'typeorm';

/** Executions go away. A workstream carries its own Delta thread link. */
export class DropExecutions1791700000000 implements MigrationInterface {
  name = 'DropExecutions1791700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workstreams" ADD "description" text`);
    await q.query(`ALTER TABLE "workstreams" ADD "deltaThreadUrl" character varying`);
    await q.query(`
      UPDATE "workstreams" w
      SET "deltaThreadUrl" = sub.url
      FROM (
        SELECT DISTINCT ON ("workstreamId") "workstreamId", "sessionUrl" AS url
        FROM "executions"
        WHERE "sessionUrl" IS NOT NULL AND "sessionUrl" <> ''
        ORDER BY "workstreamId", "updatedAt" DESC
      ) sub
      WHERE w.id = sub."workstreamId"
        AND sub.url ~* '^https://([a-z0-9-]+\.)*delta\.dev(/|$)'
    `);
    await q.query(`UPDATE "workstreams" SET "deltaThreadUrl" = 'https://delta.dev' WHERE "deltaThreadUrl" IS NULL`);
    await q.query(`ALTER TABLE "workstreams" ALTER COLUMN "deltaThreadUrl" SET NOT NULL`);

    await q.query(`ALTER TABLE "input_requests" DROP CONSTRAINT "FK_21f993cd58682aa1b2761e9af99"`);
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_771b15dfd916a9a3d1b28ba0f93"`);
    await q.query(`ALTER TABLE "decisions" DROP CONSTRAINT "FK_ef87eac1479a7a6065dfa4caeba"`);
    await q.query(`ALTER TABLE "input_requests" DROP COLUMN "executionId"`);
    await q.query(`ALTER TABLE "artifacts" DROP COLUMN "executionId"`);
    await q.query(`ALTER TABLE "decisions" DROP COLUMN "originExecutionId"`);

    await q.query(`DELETE FROM "dependencies" WHERE "fromType" = 'execution' OR "toType" = 'execution'`);
    await q.query(`DELETE FROM "comments" WHERE "subject"->>'type' = 'execution'`);
    await q.query(`DELETE FROM "saved_views" WHERE "entity" = 'execution'`);

    await q.query(`ALTER TABLE "executions" DROP CONSTRAINT "FK_a84f300c6312045ace7d0215f9b"`);
    await q.query(`ALTER TABLE "executions" DROP CONSTRAINT "FK_d17140a75ac99b25a6e706bdd94"`);
    await q.query(`ALTER TABLE "executions" DROP CONSTRAINT "FK_836070047b5e3fdc1e492e93b1f"`);
    await q.query(`ALTER TABLE "executions" DROP CONSTRAINT "FK_1d82a6925833c6a58a27de62d37"`);
    await q.query(`DROP TABLE "executions"`);
  }

  public async down(): Promise<void> {
    throw new Error('DropExecutions1791700000000 is irreversible');
  }
}
