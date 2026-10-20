import { MigrationInterface, QueryRunner } from 'typeorm';

/** First-class release pipelines and releases, plus a nullable issue.releaseId. */
export class Releases1793770000000 implements MigrationInterface {
  name = 'Releases1793770000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "release_pipelines" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "name" character varying NOT NULL,
        "type" character varying NOT NULL DEFAULT 'continuous',
        "teamId" character varying,
        "moveOpenIssuesToNext" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_release_pipelines" PRIMARY KEY ("id")
      )
    `);
    await q.query(
      `CREATE INDEX "IDX_release_pipelines_workspace" ON "release_pipelines" ("workspaceId")`,
    );
    await q.query(`
      ALTER TABLE "release_pipelines"
        ADD CONSTRAINT "FK_release_pipelines_workspace"
        FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await q.query(`
      ALTER TABLE "release_pipelines"
        ADD CONSTRAINT "FK_release_pipelines_team"
        FOREIGN KEY ("teamId") REFERENCES "teams"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await q.query(`
      CREATE TABLE "releases" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "pipelineId" character varying NOT NULL,
        "name" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'draft',
        "notes" text,
        "targetAt" TIMESTAMP WITH TIME ZONE,
        "releasedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_releases" PRIMARY KEY ("id")
      )
    `);
    await q.query(`CREATE INDEX "IDX_releases_workspace" ON "releases" ("workspaceId")`);
    await q.query(`CREATE INDEX "IDX_releases_pipeline" ON "releases" ("pipelineId")`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_releases_workspace_id" ON "releases" ("workspaceId", "id")`,
    );
    await q.query(`
      ALTER TABLE "releases"
        ADD CONSTRAINT "FK_releases_workspace"
        FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await q.query(`
      ALTER TABLE "releases"
        ADD CONSTRAINT "FK_releases_pipeline"
        FOREIGN KEY ("pipelineId") REFERENCES "release_pipelines"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await q.query(`ALTER TABLE "issues" ADD "releaseId" character varying`);
    await q.query(`CREATE INDEX "IDX_issues_release" ON "issues" ("releaseId")`);
    await q.query(`
      ALTER TABLE "issues"
        ADD CONSTRAINT "FK_issues_release_workspace"
        FOREIGN KEY ("workspaceId", "releaseId") REFERENCES "releases"("workspaceId", "id")
        ON DELETE SET NULL ("releaseId") ON UPDATE NO ACTION
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issues" DROP CONSTRAINT "FK_issues_release_workspace"`);
    await q.query(`DROP INDEX "IDX_issues_release"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "releaseId"`);
    await q.query(`DROP TABLE "releases"`);
    await q.query(`DROP TABLE "release_pipelines"`);
  }
}
