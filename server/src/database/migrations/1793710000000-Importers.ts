import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Import from and link to external trackers (GitHub Issues, Linear).
 *
 * issues.externalRef: pointer to the external issue ({provider, id, url, key, state, stateType, syncedAt, origin}).
 * The partial unique index (workspace, provider, id) is what makes an import idempotent and keeps one
 * external issue from being linked to two Trama issues.
 * tracker_credentials: tokens kept AES-GCM encrypted (aad `<id>:tracker`) so a job can resume and a link can refresh.
 * import_jobs: persisted background jobs with progress, cursor and capped error list.
 * import_links: external id -> Trama id for projects, teams, milestones, labels and comments created by an import.
 */
export class Importers1793710000000 implements MigrationInterface {
  name = 'Importers1793710000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issues" ADD "externalRef" jsonb`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_issues_external_ref" ON "issues" ("workspaceId", (("externalRef"->>'provider')), (("externalRef"->>'id'))) WHERE "externalRef" IS NOT NULL`,
    );

    await q.query(
      `CREATE TABLE "tracker_credentials" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "account" character varying NOT NULL,
        "baseUrl" character varying,
        "secret" text NOT NULL,
        "createdBy" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastUsedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_tracker_credentials" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE INDEX "IDX_tracker_credentials_workspace" ON "tracker_credentials" ("workspaceId")`);
    await q.query(
      `ALTER TABLE "tracker_credentials" ADD CONSTRAINT "FK_tracker_credentials_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "import_jobs" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'queued',
        "sourceLabel" character varying NOT NULL,
        "source" jsonb NOT NULL,
        "options" jsonb NOT NULL,
        "mapping" jsonb NOT NULL,
        "credential" jsonb NOT NULL,
        "progress" jsonb NOT NULL,
        "errors" jsonb NOT NULL DEFAULT '[]',
        "cursor" jsonb,
        "waitingUntil" TIMESTAMP WITH TIME ZONE,
        "cancelRequested" boolean NOT NULL DEFAULT false,
        "lastError" text,
        "heartbeatAt" TIMESTAMP WITH TIME ZONE,
        "createdBy" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_import_jobs" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE INDEX "IDX_import_jobs_workspace" ON "import_jobs" ("workspaceId", "createdAt")`);
    await q.query(`CREATE INDEX "IDX_import_jobs_active" ON "import_jobs" ("status")`);
    await q.query(
      `ALTER TABLE "import_jobs" ADD CONSTRAINT "FK_import_jobs_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "import_links" (
        "workspaceId" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "kind" character varying NOT NULL,
        "externalId" character varying NOT NULL,
        "tramaId" character varying NOT NULL,
        "jobId" character varying,
        CONSTRAINT "PK_import_links" PRIMARY KEY ("workspaceId", "provider", "kind", "externalId")
      )`,
    );
    await q.query(
      `ALTER TABLE "import_links" ADD CONSTRAINT "FK_import_links_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "import_links"`);
    await q.query(`DROP TABLE "import_jobs"`);
    await q.query(`DROP TABLE "tracker_credentials"`);
    await q.query(`DROP INDEX "UQ_issues_external_ref"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "externalRef"`);
  }
}
