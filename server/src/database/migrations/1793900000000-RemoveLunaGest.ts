import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops the LunaGest integration tables (connections, project links, issue links). Their indexes
 * and foreign keys go with them. `down` recreates the final schema the three LunaGest migrations
 * produced (1793800000000, 1793810000000, 1793820000000), without any data.
 */
export class RemoveLunaGest1793900000000 implements MigrationInterface {
  name = 'RemoveLunaGest1793900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "lunagest_issue_links"`);
    await q.query(`DROP TABLE IF EXISTS "lunagest_project_links"`);
    await q.query(`DROP TABLE IF EXISTS "lunagest_connections"`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "lunagest_connections" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "baseUrl" character varying NOT NULL,
        "account" character varying NOT NULL,
        "secret" text NOT NULL,
        "createdBy" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lunagest_connections" PRIMARY KEY ("id")
      )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_lunagest_connections_workspace" ON "lunagest_connections" ("workspaceId")`,
    );
    await q.query(
      `ALTER TABLE "lunagest_connections" ADD CONSTRAINT "FK_lunagest_connections_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "lunagest_project_links" (
        "projectId" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "connectionId" character varying NOT NULL,
        "remoteProjectId" character varying NOT NULL,
        "remoteProjectName" character varying NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "syncedName" text,
        "syncedDescription" text,
        CONSTRAINT "PK_lunagest_project_links" PRIMARY KEY ("projectId")
      )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_lunagest_project_links_remote" ON "lunagest_project_links" ("workspaceId", "remoteProjectId")`,
    );
    await q.query(
      `ALTER TABLE "lunagest_project_links" ADD CONSTRAINT "FK_lunagest_project_links_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "lunagest_project_links" ADD CONSTRAINT "FK_lunagest_project_links_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "lunagest_project_links" ADD CONSTRAINT "FK_lunagest_project_links_connection" FOREIGN KEY ("connectionId") REFERENCES "lunagest_connections"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "lunagest_issue_links" (
        "issueId" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "remoteTaskId" character varying,
        "state" character varying NOT NULL,
        "lastError" text,
        "lastSyncedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "syncedTitle" text,
        "syncedBody" text,
        CONSTRAINT "PK_lunagest_issue_links" PRIMARY KEY ("issueId")
      )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_lunagest_issue_links_remote" ON "lunagest_issue_links" ("workspaceId", "remoteTaskId") WHERE "remoteTaskId" IS NOT NULL`,
    );
    await q.query(
      `ALTER TABLE "lunagest_issue_links" ADD CONSTRAINT "FK_lunagest_issue_links_issue" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "lunagest_issue_links" ADD CONSTRAINT "FK_lunagest_issue_links_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
