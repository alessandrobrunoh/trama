import { MigrationInterface, QueryRunner } from 'typeorm';

/** Projects: the Linear-style planning layer above workstreams (workstreams and milestones are linked in later migrations). */
export class Projects1792300000000 implements MigrationInterface {
  name = 'Projects1792300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "projects" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "name" character varying NOT NULL,
        "summary" character varying,
        "description" text,
        "color" character varying NOT NULL DEFAULT '#6b7280',
        "status" character varying NOT NULL DEFAULT 'backlog',
        "priority" character varying NOT NULL DEFAULT 'none',
        "leadId" character varying,
        "teamIds" jsonb NOT NULL DEFAULT '[]',
        "repositoryIds" jsonb NOT NULL DEFAULT '[]',
        "startDate" TIMESTAMP WITH TIME ZONE,
        "targetDate" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "completedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_projects" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE INDEX "IDX_projects_workspace" ON "projects" ("workspaceId")`);
    await q.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "FK_projects_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "projects" ADD CONSTRAINT "FK_projects_lead" FOREIGN KEY ("leadId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "projects"`);
  }
}
