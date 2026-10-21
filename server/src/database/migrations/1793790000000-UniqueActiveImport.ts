import { MigrationInterface, QueryRunner } from 'typeorm';

export class UniqueActiveImport1793790000000 implements MigrationInterface {
  name = 'UniqueActiveImport1793790000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE UNIQUE INDEX "UQ_import_jobs_one_active_workspace" ON "import_jobs" ("workspaceId") WHERE "status" IN ('queued', 'running')`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "UQ_import_jobs_one_active_workspace"`);
  }
}
