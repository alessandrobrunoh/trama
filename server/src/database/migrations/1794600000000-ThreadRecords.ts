import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `task_thread_records`: the record an agent keeps of the thread linked to a task (one row per task).
 * `task_decisions`: the decisions it recorded, scoped to repository paths. Both go with the task and
 * with the workspace.
 */
export class ThreadRecords1794600000000 implements MigrationInterface {
  name = 'ThreadRecords1794600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "task_thread_records" (
        "issueId" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "threadUrl" character varying(2048),
        "summary" text,
        "files" jsonb NOT NULL DEFAULT '[]',
        "turns" integer,
        "syncCount" integer NOT NULL DEFAULT 0,
        "lastSyncAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastSyncBy" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_task_thread_records" PRIMARY KEY ("issueId")
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_task_thread_records_workspace" ON "task_thread_records" ("workspaceId")`,
    );
    await q.query(
      `ALTER TABLE "task_thread_records" ADD CONSTRAINT "FK_task_thread_records_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "task_thread_records" ADD CONSTRAINT "FK_task_thread_records_issue" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "task_decisions" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "issueId" character varying NOT NULL,
        "text" text NOT NULL,
        "paths" jsonb NOT NULL DEFAULT '[]',
        "threadUrl" character varying(2048),
        "createdBy" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_task_decisions" PRIMARY KEY ("id")
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_task_decisions_issue" ON "task_decisions" ("workspaceId", "issueId")`,
    );
    await q.query(
      `ALTER TABLE "task_decisions" ADD CONSTRAINT "FK_task_decisions_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "task_decisions" ADD CONSTRAINT "FK_task_decisions_issue" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "task_decisions"`);
    await q.query(`DROP TABLE IF EXISTS "task_thread_records"`);
  }
}
