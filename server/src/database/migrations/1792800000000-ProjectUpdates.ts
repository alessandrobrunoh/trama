import { MigrationInterface, QueryRunner } from 'typeorm';

/** Project updates (health + markdown status posts) and the project fields they drive: icon, health, lastUpdateAt. */
export class ProjectUpdates1792800000000 implements MigrationInterface {
  name = 'ProjectUpdates1792800000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "projects" ADD "icon" character varying`);
    await q.query(`ALTER TABLE "projects" ADD "health" character varying`);
    await q.query(`ALTER TABLE "projects" ADD "lastUpdateAt" TIMESTAMP WITH TIME ZONE`);
    await q.query(
      `CREATE TABLE "project_updates" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "projectId" character varying NOT NULL,
        "health" character varying NOT NULL,
        "body" text NOT NULL,
        "author" jsonb NOT NULL,
        "aiDrafted" boolean NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "editedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_project_updates" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE INDEX "IDX_project_updates_project" ON "project_updates" ("projectId", "createdAt")`);
    await q.query(
      `ALTER TABLE "project_updates" ADD CONSTRAINT "FK_project_updates_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "project_updates" ADD CONSTRAINT "FK_project_updates_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "project_updates"`);
    await q.query(`ALTER TABLE "projects" DROP COLUMN "lastUpdateAt"`);
    await q.query(`ALTER TABLE "projects" DROP COLUMN "health"`);
    await q.query(`ALTER TABLE "projects" DROP COLUMN "icon"`);
  }
}
