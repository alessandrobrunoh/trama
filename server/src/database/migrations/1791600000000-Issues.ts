import { MigrationInterface, QueryRunner } from 'typeorm';

/** Intake items become issue-tracker issues: status workflow, assignee, `/issues`. */
export class Issues1791600000000 implements MigrationInterface {
  name = 'Issues1791600000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "intake_items" RENAME TO "issues"`);
    await q.query(`ALTER INDEX "UQ_intake_workspace_key" RENAME TO "UQ_issues_workspace_key"`);
    await q.query(`ALTER TABLE "issues" RENAME COLUMN "state" TO "status"`);
    await q.query(`
      UPDATE "issues" SET "status" = CASE "status"
        WHEN 'new' THEN 'backlog'
        WHEN 'triaged' THEN 'todo'
        WHEN 'accepted' THEN 'in_progress'
        WHEN 'declined' THEN 'canceled'
        WHEN 'duplicate' THEN 'canceled'
        ELSE "status"
      END
    `);
    await q.query(`ALTER TABLE "issues" ALTER COLUMN "status" SET DEFAULT 'backlog'`);
    await q.query(`ALTER TABLE "issues" ADD "assigneeId" character varying`);
    await q.query(
      `ALTER TABLE "issues" ADD CONSTRAINT "FK_issues_assignee" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(`UPDATE "workspace_counters" SET "name" = replace("name", 'intake:', 'issue:') WHERE "name" LIKE 'intake:%'`);
    await q.query(`UPDATE "comments" SET "subject" = jsonb_set("subject", '{type}', '"issue"') WHERE "subject"->>'type' = 'intake'`);
    await q.query(`UPDATE "domain_events" SET "subject" = jsonb_set("subject", '{type}', '"issue"') WHERE "subject"->>'type' = 'intake'`);
    await q.query(`
      UPDATE "domain_events" SET "type" = CASE "type"
        WHEN 'intake.created' THEN 'issue.created'
        WHEN 'intake.updated' THEN 'issue.updated'
        WHEN 'intake.deleted' THEN 'issue.deleted'
        WHEN 'intake.triaged' THEN 'issue.status_changed'
        ELSE "type"
      END
      WHERE "type" LIKE 'intake.%'
    `);
    await q.query(`
      UPDATE "domain_events"
      SET "data" = ("data" - 'state') || jsonb_build_object(
        'to', CASE "data"->>'state'
          WHEN 'new' THEN 'backlog'
          WHEN 'triaged' THEN 'todo'
          WHEN 'accepted' THEN 'in_progress'
          WHEN 'declined' THEN 'canceled'
          WHEN 'duplicate' THEN 'canceled'
          ELSE "data"->>'state'
        END,
        'from', 'backlog'
      )
      WHERE "type" = 'issue.status_changed' AND "data" ? 'state'
    `);
    await q.query(`
      UPDATE "saved_views" SET "filters" = COALESCE((
        SELECT jsonb_agg(
          CASE WHEN f->>'field' = 'state' THEN
            jsonb_set(
              jsonb_set(f, '{field}', '"status"'),
              '{value}',
              to_jsonb(CASE f->>'value'
                WHEN 'new' THEN 'backlog'
                WHEN 'triaged' THEN 'todo'
                WHEN 'accepted' THEN 'in_progress'
                WHEN 'declined' THEN 'canceled'
                WHEN 'duplicate' THEN 'canceled'
                ELSE f->>'value'
              END)
            )
          ELSE f END
        )
        FROM jsonb_array_elements("filters") f
      ), '[]'::jsonb)
      WHERE "entity" = 'intake'
    `);
    await q.query(`UPDATE "saved_views" SET "entity" = 'issue' WHERE "entity" = 'intake'`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`UPDATE "saved_views" SET "entity" = 'intake' WHERE "entity" = 'issue'`);
    await q.query(`UPDATE "workspace_counters" SET "name" = replace("name", 'issue:', 'intake:') WHERE "name" LIKE 'issue:%'`);
    await q.query(`ALTER TABLE "issues" DROP CONSTRAINT "FK_issues_assignee"`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN "assigneeId"`);
    await q.query(`
      UPDATE "issues" SET "status" = CASE "status"
        WHEN 'backlog' THEN 'new'
        WHEN 'todo' THEN 'triaged'
        WHEN 'in_progress' THEN 'accepted'
        WHEN 'in_review' THEN 'accepted'
        WHEN 'done' THEN 'accepted'
        WHEN 'canceled' THEN 'declined'
        ELSE 'new'
      END
    `);
    await q.query(`ALTER TABLE "issues" ALTER COLUMN "status" SET DEFAULT 'new'`);
    await q.query(`ALTER TABLE "issues" RENAME COLUMN "status" TO "state"`);
    await q.query(`ALTER INDEX "UQ_issues_workspace_key" RENAME TO "UQ_intake_workspace_key"`);
    await q.query(`ALTER TABLE "issues" RENAME TO "intake_items"`);
  }
}
