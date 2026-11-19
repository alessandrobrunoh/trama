import type { MigrationInterface, QueryRunner } from 'typeorm';

/** `issues.threadUrl`: link to the Delta thread the user works on for the task (http/https, nullable). */
export class IssueThreadUrl1793880000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "issues" ADD COLUMN "threadUrl" varchar(2048)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "issues" DROP COLUMN "threadUrl"');
  }
}
