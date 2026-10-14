import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retires the active Workstream model after IssueFirst has detached and
 * snapshotted every historical association.
 */
export class RemoveWorkstreams1793750000000 implements MigrationInterface {
  name = 'RemoveWorkstreams1793750000000';

  public async up(q: QueryRunner): Promise<void> {
    // Workstream-backed artifacts were made safe to retain by IssueFirst's
    // legacyWorkstreamKey owner exception. Do not invoke the orphan trigger.
    await q.query(`DROP TRIGGER IF EXISTS "TRG_artifacts_orphan" ON "artifacts"`);
    await q.query(`DROP FUNCTION IF EXISTS "artifacts_drop_orphan"()`);
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "CHK_artifacts_owner"`);
    await q.query(`
      ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_owner"
      CHECK ("projectId" IS NOT NULL OR "issueId" IS NOT NULL OR "legacyWorkstreamKey" IS NOT NULL)
    `);
    await q.query(`
      CREATE FUNCTION "artifacts_drop_orphan"() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."projectId" IS NULL AND NEW."issueId" IS NULL AND NEW."legacyWorkstreamKey" IS NULL THEN
          DELETE FROM "comments" WHERE "workspaceId" = OLD."workspaceId" AND "subject"->>'id' = OLD."id";
          DELETE FROM "dependencies" WHERE "workspaceId" = OLD."workspaceId" AND ("fromId" = OLD."id" OR "toId" = OLD."id");
          DELETE FROM "artifacts" WHERE "id" = OLD."id";
        END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await q.query(`
      CREATE TRIGGER "TRG_artifacts_orphan" BEFORE UPDATE ON "artifacts" FOR EACH ROW
      WHEN (NEW."projectId" IS NULL AND NEW."issueId" IS NULL AND NEW."legacyWorkstreamKey" IS NULL)
      EXECUTE FUNCTION "artifacts_drop_orphan"()
    `);

    // These are live organizational links, not history. The issue-owned goal
    // was copied by IssueFirst where it could be inferred; never retain stale
    // Workstream identifiers on Issue rows.
    await q.query(`UPDATE "issues" SET "workstreamIds" = '[]'::jsonb`);
    await q.query(`ALTER TABLE "issues" DROP COLUMN IF EXISTS "workstreamIds"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_input_requests_workstream"`);
    await q.query(`ALTER TABLE "input_requests" DROP CONSTRAINT IF EXISTS "FK_6668744227c4c46afdab5d048fd"`);
    await q.query(`ALTER TABLE "input_requests" DROP COLUMN IF EXISTS "workstreamId"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_artifacts_workstream"`);
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "FK_artifacts_workstream"`);
    await q.query(`ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "workstreamId"`);
    await q.query(`ALTER TABLE "decisions" DROP CONSTRAINT IF EXISTS "FK_c6697a687945aabef4353ee5c19"`);
    await q.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "originWorkstreamId"`);
    await q.query(`ALTER TABLE "decisions" DROP COLUMN IF EXISTS "relatedWorkstreamIds"`);
    await q.query(`DROP INDEX IF EXISTS "IDX_events_workstream_at"`);
    await q.query(`ALTER TABLE "domain_events" DROP COLUMN IF EXISTS "workstreamId"`);

    // Dependency edges that named a Workstream stay in the database as
    // historical records. The retired API no longer reads or writes them.

    // Graph views no longer have a backing route; preserve their saved query
    // while making it available in the closest remaining layout.
    await q.query(
      `UPDATE "saved_views" SET "layout" = 'list' WHERE "layout" = 'graph'`,
    );

    // Preserve the legacy snapshot as the durable record of retired workstreams.
    await q.query(`DROP TABLE "workstreams"`);
  }

  public async down(): Promise<void> {
    throw new Error('RemoveWorkstreams migration is forward-only');
  }
}
