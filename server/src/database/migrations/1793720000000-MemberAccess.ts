import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-person access, narrower than the workspace role: project scope and view/create/edit/delete grants. */
export class MemberAccess1793720000000 implements MigrationInterface {
  name = 'MemberAccess1793720000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "memberships" ADD "access" jsonb`);
    await q.query(`ALTER TABLE "invites" ADD "access" jsonb`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "invites" DROP COLUMN "access"`);
    await q.query(`ALTER TABLE "memberships" DROP COLUMN "access"`);
  }
}
