import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Roles & permissions, token scopes and outgoing webhooks:
 * workspaces.settings (partial jsonb), teams.leadIds / editPolicy, api_tokens.scope
 * (existing tokens keep working as `write`), outgoing_webhooks + outgoing_webhook_deliveries.
 */
export class AccessWebhooks1791820000000 implements MigrationInterface {
  name = 'AccessWebhooks1791820000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workspaces" ADD "settings" jsonb NOT NULL DEFAULT '{}'`);
    await q.query(`ALTER TABLE "teams" ADD "leadIds" jsonb NOT NULL DEFAULT '[]'`);
    await q.query(`ALTER TABLE "teams" ADD "editPolicy" character varying NOT NULL DEFAULT 'workspace'`);
    await q.query(`ALTER TABLE "api_tokens" ADD "scope" character varying NOT NULL DEFAULT 'write'`);

    await q.query(
      `CREATE TABLE "outgoing_webhooks" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "name" character varying NOT NULL, "url" character varying NOT NULL, "secret" text NOT NULL, "events" jsonb NOT NULL DEFAULT '[]', "enabled" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastDeliveryAt" TIMESTAMP WITH TIME ZONE, "lastStatus" integer, CONSTRAINT "PK_outgoing_webhooks" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_outgoing_webhooks_workspace" ON "outgoing_webhooks" ("workspaceId")`);
    await q.query(
      `ALTER TABLE "outgoing_webhooks" ADD CONSTRAINT "FK_outgoing_webhooks_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "outgoing_webhook_deliveries" ("id" character varying NOT NULL, "webhookId" character varying NOT NULL, "event" character varying NOT NULL, "status" integer NOT NULL DEFAULT 0, "ok" boolean NOT NULL DEFAULT false, "durationMs" integer NOT NULL DEFAULT 0, "error" text, "attempt" integer NOT NULL DEFAULT 1, "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_outgoing_webhook_deliveries" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_outgoing_deliveries_webhook_at" ON "outgoing_webhook_deliveries" ("webhookId", "at")`);
    await q.query(
      `ALTER TABLE "outgoing_webhook_deliveries" ADD CONSTRAINT "FK_outgoing_deliveries_webhook" FOREIGN KEY ("webhookId") REFERENCES "outgoing_webhooks"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "outgoing_webhook_deliveries"`);
    await q.query(`DROP TABLE "outgoing_webhooks"`);
    await q.query(`ALTER TABLE "api_tokens" DROP COLUMN "scope"`);
    await q.query(`ALTER TABLE "teams" DROP COLUMN "editPolicy"`);
    await q.query(`ALTER TABLE "teams" DROP COLUMN "leadIds"`);
    await q.query(`ALTER TABLE "workspaces" DROP COLUMN "settings"`);
  }
}
