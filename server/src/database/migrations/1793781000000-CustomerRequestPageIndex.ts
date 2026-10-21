import { MigrationInterface, QueryRunner } from 'typeorm';

export class CustomerRequestPageIndex1793781000000 implements MigrationInterface {
  name = 'CustomerRequestPageIndex1793781000000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE INDEX "IDX_customer_requests_workspace_page" ON "customer_requests" ("workspaceId", "createdAt" DESC, "id" ASC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "IDX_customer_requests_workspace_page"`);
  }
}
