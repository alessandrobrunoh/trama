import type { MigrationInterface, QueryRunner } from 'typeorm';

/** `issues.dueDate`: the day a task should be done (nullable, midnight UTC). */
export class IssueDueDate1793890000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "issues" ADD COLUMN "dueDate" timestamptz');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "issues" DROP COLUMN "dueDate"');
  }
}
