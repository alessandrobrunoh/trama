import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One LunaGest connection per workspace. `secret` is AES-GCM (aad `<id>:lunagest`) of
 * `{ username, password, apiKey }`. A Trama project may bind one remote project; the remote id
 * is unique in the workspace. Deleting the connection deletes its project links.
 */
export class LunaGest1793800000000 implements MigrationInterface {
  name = 'LunaGest1793800000000';

  public async up(q: QueryRunner): Promise<void> {
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
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "lunagest_project_links"`);
    await q.query(`DROP TABLE "lunagest_connections"`);
  }
}
