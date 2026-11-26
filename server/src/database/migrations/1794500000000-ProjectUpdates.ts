import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `project_updates`: written status updates on a project (markdown body, the health its author
 * reported, who wrote it). They go with the project and with the workspace.
 */
export class ProjectUpdates1794500000000 implements MigrationInterface {
  name = 'ProjectUpdates1794500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "project_updates" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "projectId" character varying NOT NULL,
        "author" jsonb NOT NULL,
        "body" text NOT NULL,
        "health" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "editedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_project_updates" PRIMARY KEY ("id")
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_project_updates_project" ON "project_updates" ("projectId", "createdAt")`,
    );
    await q.query(
      `ALTER TABLE "project_updates" ADD CONSTRAINT "FK_project_updates_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "project_updates" ADD CONSTRAINT "FK_project_updates_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "project_updates"`);
  }
}
