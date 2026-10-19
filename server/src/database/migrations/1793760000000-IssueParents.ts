import { MigrationInterface, QueryRunner } from 'typeorm';

/** Add a flat, self-referencing parent link to issues. */
export class IssueParents1793760000000 implements MigrationInterface {
  name = 'IssueParents1793760000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "issues" ADD "parentId" character varying`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_issues_workspace_id" ON "issues" ("workspaceId", "id")`,
    );
    await q.query(
      `ALTER TABLE "issues" ADD CONSTRAINT "FK_issues_parent_workspace"
       FOREIGN KEY ("workspaceId", "parentId") REFERENCES "issues"("workspaceId", "id")
       ON DELETE SET NULL ("parentId") ON UPDATE NO ACTION`,
    );
    await q.query(`CREATE INDEX "IDX_issues_parent" ON "issues" ("parentId")`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "IDX_issues_parent"`);
    await q.query(
      `ALTER TABLE "issues" DROP CONSTRAINT "FK_issues_parent_workspace"`,
    );
    await q.query(`DROP INDEX "UQ_issues_workspace_id"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "parentId"`);
  }
}
