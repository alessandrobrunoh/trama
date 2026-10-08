import { MigrationInterface, QueryRunner } from 'typeorm';

/** A workstream carries out at most one project. Deleting a project detaches its workstreams. */
export class WorkstreamProject1792400000000 implements MigrationInterface {
  name = 'WorkstreamProject1792400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workstreams" ADD "projectId" character varying`);
    await q.query(`CREATE INDEX "IDX_workstreams_project" ON "workstreams" ("projectId")`);
    await q.query(
      `ALTER TABLE "workstreams" ADD CONSTRAINT "FK_workstreams_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "workstreams" DROP CONSTRAINT "FK_workstreams_project"`);
    await q.query(`DROP INDEX "IDX_workstreams_project"`);
    await q.query(`ALTER TABLE "workstreams" DROP COLUMN "projectId"`);
  }
}
