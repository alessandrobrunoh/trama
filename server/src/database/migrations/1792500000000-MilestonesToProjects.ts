import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Milestones move from workstreams to projects. Every workstream that has milestones but no
 * project gets a project of its own (named after it, same team, lead, repositories and dates), so no
 * milestone is orphaned; the milestone then follows its workstream's project.
 */
export class MilestonesToProjects1792500000000 implements MigrationInterface {
  name = 'MilestonesToProjects1792500000000';

  public async up(q: QueryRunner): Promise<void> {
    const needsProject = `w."projectId" IS NULL AND EXISTS (SELECT 1 FROM "milestones" ms WHERE ms."workstreamId" = w."id")`;
    await q.query(
      `INSERT INTO "projects" ("id", "workspaceId", "name", "description", "status", "priority", "leadId", "teamIds", "repositoryIds", "startDate", "targetDate", "createdAt", "updatedAt", "completedAt")
       SELECT 'pj_' || substr(md5(w."id" || ':project'), 1, 12), w."workspaceId", w."title", w."description",
         CASE w."status" WHEN 'shipped' THEN 'completed' WHEN 'canceled' THEN 'canceled' WHEN 'draft' THEN 'backlog' WHEN 'planned' THEN 'planned' ELSE 'in_progress' END,
         w."priority", w."accountableUserId",
         jsonb_build_array(w."ownerTeamId") || w."participatingTeamIds", w."repositoryIds",
         w."startDate", w."targetDate", w."createdAt", now(), w."shippedAt"
       FROM "workstreams" w WHERE ${needsProject}`,
    );
    await q.query(
      `UPDATE "workstreams" w SET "projectId" = 'pj_' || substr(md5(w."id" || ':project'), 1, 12) WHERE ${needsProject}`,
    );

    await q.query(`ALTER TABLE "milestones" ADD "projectId" character varying`);
    await q.query(
      `UPDATE "milestones" ms SET "projectId" = w."projectId" FROM "workstreams" w WHERE w."id" = ms."workstreamId"`,
    );
    // Several workstreams of one project may each have had milestones: renumber per project.
    await q.query(
      `UPDATE "milestones" ms SET "sortOrder" = n.rn FROM (
         SELECT ms2."id", (ROW_NUMBER() OVER (PARTITION BY ms2."projectId" ORDER BY w."createdAt", ms2."sortOrder", ms2."createdAt") - 1) AS rn
         FROM "milestones" ms2 JOIN "workstreams" w ON w."id" = ms2."workstreamId"
       ) n WHERE n."id" = ms."id"`,
    );
    await q.query(`ALTER TABLE "milestones" ALTER COLUMN "projectId" SET NOT NULL`);
    await q.query(`ALTER TABLE "milestones" DROP CONSTRAINT "FK_milestones_workstream"`);
    await q.query(`DROP INDEX "IDX_milestones_workstream"`);
    await q.query(`ALTER TABLE "milestones" DROP COLUMN "workstreamId"`);
    await q.query(`CREATE INDEX "IDX_milestones_project" ON "milestones" ("projectId")`);
    await q.query(
      `ALTER TABLE "milestones" ADD CONSTRAINT "FK_milestones_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  /** Milestones return to the oldest workstream of their project; those of a project without workstreams are dropped. */
  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "milestones" DROP CONSTRAINT "FK_milestones_project"`);
    await q.query(`DROP INDEX "IDX_milestones_project"`);
    await q.query(`ALTER TABLE "milestones" ADD "workstreamId" character varying`);
    await q.query(
      `UPDATE "milestones" ms SET "workstreamId" = (SELECT w."id" FROM "workstreams" w WHERE w."projectId" = ms."projectId" ORDER BY w."createdAt" LIMIT 1)`,
    );
    await q.query(`DELETE FROM "milestones" WHERE "workstreamId" IS NULL`);
    await q.query(`ALTER TABLE "milestones" ALTER COLUMN "workstreamId" SET NOT NULL`);
    await q.query(`ALTER TABLE "milestones" DROP COLUMN "projectId"`);
    await q.query(`CREATE INDEX "IDX_milestones_workstream" ON "milestones" ("workstreamId")`);
    await q.query(
      `ALTER TABLE "milestones" ADD CONSTRAINT "FK_milestones_workstream" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }
}
