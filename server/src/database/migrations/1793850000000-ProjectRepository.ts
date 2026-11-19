import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ProjectRepository1793850000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "projects" ADD COLUMN "repository" varchar(2048)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "projects" DROP COLUMN "repository"');
  }
}
