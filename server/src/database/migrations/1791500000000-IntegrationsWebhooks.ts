import { MigrationInterface, QueryRunner } from 'typeorm';

/** Webhook delivery dedupe + git coordinates of synced artifacts. */
export class IntegrationsWebhooks1791500000000 implements MigrationInterface {
  name = 'IntegrationsWebhooks1791500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "webhook_deliveries" ("id" character varying NOT NULL, "connectionId" character varying NOT NULL, "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_webhook_deliveries" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_webhook_deliveries_received" ON "webhook_deliveries" ("receivedAt")`);
    await q.query(
      `ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "FK_webhook_deliveries_connection" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE CASCADE`,
    );
    await q.query(
      `CREATE TABLE "artifact_sources" ("artifactId" character varying NOT NULL, "workspaceId" character varying NOT NULL, "repositoryId" character varying, "headSha" character varying, "headBranch" character varying, CONSTRAINT "PK_artifact_sources" PRIMARY KEY ("artifactId"))`,
    );
    await q.query(`CREATE INDEX "IDX_artifact_sources_repo_sha" ON "artifact_sources" ("repositoryId", "headSha")`);
    await q.query(
      `ALTER TABLE "artifact_sources" ADD CONSTRAINT "FK_artifact_sources_artifact" FOREIGN KEY ("artifactId") REFERENCES "artifacts"("id") ON DELETE CASCADE`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "artifact_sources"`);
    await q.query(`DROP TABLE "webhook_deliveries"`);
  }
}
