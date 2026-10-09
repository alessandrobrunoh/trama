import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer intake: inbound customer requests from Intercom, Zendesk, Front, Slack, email and signed webhooks.
 *
 * customer_intake_sources: one endpoint per provider connection (encrypted secret, auto-create flag, optional
 * target project). customer_intake_items: what arrived; unique per (source, externalId) so a redelivery or a second
 * message of the same ticket is ignored. `pending` items wait in the triage inbox until someone links them.
 * customer_requests gains the provenance of requests created from an item (source, externalId, requester).
 */
export class CustomerIntake1793650000000 implements MigrationInterface {
  name = 'CustomerIntake1793650000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "customer_intake_sources" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "name" character varying NOT NULL,
        "secret" text,
        "enabled" boolean NOT NULL DEFAULT true,
        "autoCreateCustomers" boolean NOT NULL DEFAULT true,
        "targetProjectId" character varying,
        "config" jsonb NOT NULL DEFAULT '{}',
        "lastReceivedAt" TIMESTAMP WITH TIME ZONE,
        "createdBy" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customer_intake_sources" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE INDEX "IDX_customer_intake_sources_workspace" ON "customer_intake_sources" ("workspaceId")`);
    await q.query(
      `ALTER TABLE "customer_intake_sources" ADD CONSTRAINT "FK_customer_intake_sources_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "customer_intake_sources" ADD CONSTRAINT "FK_customer_intake_sources_project" FOREIGN KEY ("targetProjectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "customer_intake_items" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "sourceId" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "externalId" character varying NOT NULL,
        "externalUrl" character varying,
        "requesterEmail" character varying,
        "requesterName" character varying,
        "subject" character varying,
        "body" text NOT NULL DEFAULT '',
        "status" character varying NOT NULL DEFAULT 'pending',
        "customerId" character varying,
        "issueId" character varying,
        "projectId" character varying,
        "customerRequestId" character varying,
        "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "resolvedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_customer_intake_items" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE UNIQUE INDEX "UQ_customer_intake_items_external" ON "customer_intake_items" ("sourceId", "externalId")`);
    await q.query(`CREATE INDEX "IDX_customer_intake_items_inbox" ON "customer_intake_items" ("workspaceId", "status", "receivedAt")`);
    await q.query(
      `ALTER TABLE "customer_intake_items" ADD CONSTRAINT "FK_customer_intake_items_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "customer_intake_items" ADD CONSTRAINT "FK_customer_intake_items_source" FOREIGN KEY ("sourceId") REFERENCES "customer_intake_sources"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "customer_intake_items" ADD CONSTRAINT "FK_customer_intake_items_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "customer_intake_items" ADD CONSTRAINT "FK_customer_intake_items_request" FOREIGN KEY ("customerRequestId") REFERENCES "customer_requests"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await q.query(`ALTER TABLE "customer_requests" ADD "source" character varying`);
    await q.query(`ALTER TABLE "customer_requests" ADD "externalId" character varying`);
    await q.query(`ALTER TABLE "customer_requests" ADD "requesterEmail" character varying`);
    await q.query(`ALTER TABLE "customer_requests" ADD "requesterName" character varying`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "customer_requests" DROP COLUMN "requesterName"`);
    await q.query(`ALTER TABLE "customer_requests" DROP COLUMN "requesterEmail"`);
    await q.query(`ALTER TABLE "customer_requests" DROP COLUMN "externalId"`);
    await q.query(`ALTER TABLE "customer_requests" DROP COLUMN "source"`);
    await q.query(`DROP TABLE "customer_intake_items"`);
    await q.query(`DROP TABLE "customer_intake_sources"`);
  }
}
