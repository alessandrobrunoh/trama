import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Milestones inside workstreams, issue estimates / start+completion facts / key aliases,
 * workstream start date, and the removal of `commit` / `branch` artifacts.
 */
export class MilestonesEstimates1791810000000 implements MigrationInterface {
  name = 'MilestonesEstimates1791810000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workstreams" ADD "startDate" TIMESTAMP WITH TIME ZONE`);

    await q.query(
      `CREATE TABLE "milestones" ("id" character varying NOT NULL, "workspaceId" character varying NOT NULL, "workstreamId" character varying NOT NULL, "name" character varying NOT NULL, "description" text, "targetDate" TIMESTAMP WITH TIME ZONE, "sortOrder" double precision NOT NULL DEFAULT 0, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_milestones" PRIMARY KEY ("id"))`,
    );
    await q.query(`CREATE INDEX "IDX_milestones_workspace" ON "milestones" ("workspaceId")`);
    await q.query(`CREATE INDEX "IDX_milestones_workstream" ON "milestones" ("workstreamId")`);
    await q.query(
      `ALTER TABLE "milestones" ADD CONSTRAINT "FK_milestones_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "milestones" ADD CONSTRAINT "FK_milestones_workstream" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await q.query(`ALTER TABLE "issues" ADD "milestoneIds" jsonb NOT NULL DEFAULT '[]'`);
    await q.query(`ALTER TABLE "issues" ADD "estimate" double precision`);
    await q.query(`ALTER TABLE "issues" ADD "startedAt" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "issues" ADD "completedAt" TIMESTAMP WITH TIME ZONE`);
    await q.query(`ALTER TABLE "issues" ADD "aliases" jsonb NOT NULL DEFAULT '[]'`);

    // Backfill from the event log: first entry into in_progress / in_review, and the latest
    // done / canceled transition for issues that are currently finished. Unknown stays null.
    await q.query(`
      UPDATE "issues" i SET "startedAt" = e."at"
      FROM (
        SELECT "subject"->>'id' AS id, min("at") AS "at"
        FROM "domain_events"
        WHERE "type" = 'issue.status_changed' AND "data"->>'to' IN ('in_progress', 'in_review')
        GROUP BY 1
      ) e
      WHERE e.id = i."id"
    `);
    await q.query(`
      UPDATE "issues" i SET "completedAt" = e."at"
      FROM (
        SELECT "subject"->>'id' AS id, max("at") AS "at"
        FROM "domain_events"
        WHERE "type" = 'issue.status_changed' AND "data"->>'to' IN ('done', 'canceled')
        GROUP BY 1
      ) e
      WHERE e.id = i."id" AND i."status" IN ('done', 'canceled')
    `);

    // `commit` and `branch` artifacts are covered by pull requests.
    await q.query(`
      DELETE FROM "comments"
      WHERE "subject"->>'type' = 'artifact'
        AND "subject"->>'id' IN (SELECT "id" FROM "artifacts" WHERE "kind" IN ('commit', 'branch'))
    `);
    await q.query(
      `DELETE FROM "artifact_sources" WHERE "artifactId" IN (SELECT "id" FROM "artifacts" WHERE "kind" IN ('commit', 'branch'))`,
    );
    await q.query(`DELETE FROM "artifacts" WHERE "kind" IN ('commit', 'branch')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    // Deleted commit/branch artifacts are not restored.
    await q.query(`ALTER TABLE "issues" DROP COLUMN "aliases"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "completedAt"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "startedAt"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "estimate"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "milestoneIds"`);
    await q.query(`ALTER TABLE "milestones" DROP CONSTRAINT "FK_milestones_workstream"`);
    await q.query(`ALTER TABLE "milestones" DROP CONSTRAINT "FK_milestones_workspace"`);
    await q.query(`DROP INDEX "IDX_milestones_workstream"`);
    await q.query(`DROP INDEX "IDX_milestones_workspace"`);
    await q.query(`DROP TABLE "milestones"`);
    await q.query(`ALTER TABLE "workstreams" DROP COLUMN "startDate"`);
  }
}
