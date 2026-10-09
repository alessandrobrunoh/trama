import { MigrationInterface, QueryRunner } from 'typeorm';

/** Customers and the feedback that links one customer to one issue. */
export class Customers1793000000000 implements MigrationInterface {
  name = 'Customers1793000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "customers" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "name" character varying NOT NULL,
        "domain" character varying NOT NULL,
        "createdBy" jsonb NOT NULL,
        "archivedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customers" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE UNIQUE INDEX "UQ_customers_workspace_domain" ON "customers" ("workspaceId", "domain")`);
    await q.query(`CREATE INDEX "IDX_customers_workspace" ON "customers" ("workspaceId")`);
    await q.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "FK_customers_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "customer_requests" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "customerId" character varying NOT NULL,
        "issueId" character varying NOT NULL,
        "body" text,
        "createdBy" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customer_requests" PRIMARY KEY ("id")
      )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_customer_requests_pair" ON "customer_requests" ("workspaceId", "customerId", "issueId")`,
    );
    await q.query(`CREATE INDEX "IDX_customer_requests_issue" ON "customer_requests" ("issueId")`);
    await q.query(`CREATE INDEX "IDX_customer_requests_customer" ON "customer_requests" ("customerId")`);
    await q.query(
      `ALTER TABLE "customer_requests" ADD CONSTRAINT "FK_customer_requests_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "customer_requests" ADD CONSTRAINT "FK_customer_requests_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "customer_requests" ADD CONSTRAINT "FK_customer_requests_issue" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "customer_requests"`);
    await q.query(`DROP TABLE "customers"`);
  }
}
