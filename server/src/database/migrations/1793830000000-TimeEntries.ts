import { MigrationInterface, QueryRunner } from 'typeorm';

/** Personal time entries. At most one open timer per person in a workspace. */
export class TimeEntries1793830000000 implements MigrationInterface {
  name = 'TimeEntries1793830000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "time_entries" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "projectId" character varying,
        "issueId" character varying,
        "description" character varying NOT NULL DEFAULT '',
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "endedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_time_entries" PRIMARY KEY ("id")
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_time_entries_user" ON "time_entries" ("workspaceId", "userId", "startedAt")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_time_entries_running" ON "time_entries" ("workspaceId", "userId") WHERE "endedAt" IS NULL`,
    );
    await q.query(
      `ALTER TABLE "time_entries" ADD CONSTRAINT "FK_time_entries_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "time_entries" ADD CONSTRAINT "FK_time_entries_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "time_entries" ADD CONSTRAINT "FK_time_entries_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "time_entries" ADD CONSTRAINT "FK_time_entries_issue" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "time_entries"`);
  }
}
