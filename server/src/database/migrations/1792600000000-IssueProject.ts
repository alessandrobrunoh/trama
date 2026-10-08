import { MigrationInterface, QueryRunner } from 'typeorm';

/** An issue may be planned under a project directly. Deleting a project detaches its issues. */
export class IssueProject1792600000000 implements MigrationInterface {
  name = 'IssueProject1792600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issues" ADD "projectId" character varying`);
    await q.query(`CREATE INDEX "IDX_issues_project" ON "issues" ("projectId")`);
    await q.query(
      `ALTER TABLE "issues" ADD CONSTRAINT "FK_issues_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issues" DROP CONSTRAINT "FK_issues_project"`);
    await q.query(`DROP INDEX "IDX_issues_project"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "projectId"`);
  }
}
