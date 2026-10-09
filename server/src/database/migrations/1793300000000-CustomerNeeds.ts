import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer requests become first-class and customers become companies.
 *
 * customer_requests: `issueId` becomes nullable, `projectId`, `important`, `sourceUrl` and `updatedAt` are added,
 * and exactly one of issueId / projectId must be set. The (customer, issue) uniqueness goes away: a customer can
 * ask for several things on the same issue. Existing rows keep their id, issue, note (now the markdown `body`),
 * author and timestamp; they start as not important with no source URL.
 *
 * customers: `domains` (jsonb, primary first) is backfilled from the single `domain`, which stays as the primary
 * domain and keeps its unique index. `logoUrl`, `revenue`, `size`, `tierId` are nullable; `status` defaults to `active`.
 *
 * Down removes project requests and, where a customer has several requests on one issue, keeps the oldest one
 * (it has to restore the unique pair). Everything else survives.
 */
export class CustomerNeeds1793300000000 implements MigrationInterface {
  name = 'CustomerNeeds1793300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "customers" ADD "domains" jsonb NOT NULL DEFAULT '[]'`);
    await q.query(`UPDATE "customers" SET "domains" = jsonb_build_array("domain")`);
    await q.query(`ALTER TABLE "customers" ADD "logoUrl" character varying`);
    await q.query(`ALTER TABLE "customers" ADD "revenue" double precision`);
    await q.query(`ALTER TABLE "customers" ADD "size" integer`);
    await q.query(`ALTER TABLE "customers" ADD "tierId" character varying`);
    await q.query(`ALTER TABLE "customers" ADD "status" character varying NOT NULL DEFAULT 'active'`);

    await q.query(`DROP INDEX "UQ_customer_requests_pair"`);
    await q.query(`ALTER TABLE "customer_requests" ALTER COLUMN "issueId" DROP NOT NULL`);
    await q.query(`ALTER TABLE "customer_requests" ADD "projectId" character varying`);
    await q.query(`ALTER TABLE "customer_requests" ADD "important" boolean NOT NULL DEFAULT false`);
    await q.query(`ALTER TABLE "customer_requests" ADD "sourceUrl" character varying`);
    await q.query(`ALTER TABLE "customer_requests" ADD "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`);
    await q.query(`UPDATE "customer_requests" SET "updatedAt" = "createdAt"`);
    await q.query(
      `ALTER TABLE "customer_requests" ADD CONSTRAINT "CK_customer_requests_target" CHECK (("issueId" IS NULL) <> ("projectId" IS NULL))`,
    );
    await q.query(`CREATE INDEX "IDX_customer_requests_project" ON "customer_requests" ("projectId")`);
    await q.query(
      `ALTER TABLE "customer_requests" ADD CONSTRAINT "FK_customer_requests_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "customer_requests" WHERE "issueId" IS NULL`);
    await q.query(
      `DELETE FROM "customer_requests" r USING "customer_requests" o
       WHERE r."workspaceId" = o."workspaceId" AND r."customerId" = o."customerId" AND r."issueId" = o."issueId"
         AND (o."createdAt", o."id") < (r."createdAt", r."id")`,
    );
    await q.query(`ALTER TABLE "customer_requests" DROP CONSTRAINT "FK_customer_requests_project"`);
    await q.query(`DROP INDEX "IDX_customer_requests_project"`);
    await q.query(`ALTER TABLE "customer_requests" DROP CONSTRAINT "CK_customer_requests_target"`);
    await q.query(`ALTER TABLE "customer_requests" DROP COLUMN "updatedAt"`);
    await q.query(`ALTER TABLE "customer_requests" DROP COLUMN "sourceUrl"`);
    await q.query(`ALTER TABLE "customer_requests" DROP COLUMN "important"`);
    await q.query(`ALTER TABLE "customer_requests" DROP COLUMN "projectId"`);
    await q.query(`ALTER TABLE "customer_requests" ALTER COLUMN "issueId" SET NOT NULL`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_customer_requests_pair" ON "customer_requests" ("workspaceId", "customerId", "issueId")`,
    );

    await q.query(`ALTER TABLE "customers" DROP COLUMN "status"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN "tierId"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN "size"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN "revenue"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN "logoUrl"`);
    await q.query(`ALTER TABLE "customers" DROP COLUMN "domains"`);
  }
}
