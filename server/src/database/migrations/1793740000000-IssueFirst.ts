import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Introduces issue ownership for new human input and decisions while keeping
 * their Workstream-only predecessors as unlinked history with former keys.
 *
 * It copies an objective into an Issue Goal only for an unambiguous one-to-one
 * association. It does not delete rows or assign historical records to an
 * Issue. Artifact orphan cleanup is adjusted before detaching its former
 * Workstream owner so the existing trigger cannot delete history.
 */
export class IssueFirst1793740000000 implements MigrationInterface {
  name = 'IssueFirst1793740000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE "legacy_workstream_history" (
        "id" character varying PRIMARY KEY,
        "key" character varying NOT NULL,
        "title" character varying NOT NULL,
        "objective" text NOT NULL DEFAULT '',
        "payload" jsonb NOT NULL DEFAULT '{}',
        "retiredAt" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await q.query(`
      INSERT INTO "legacy_workstream_history" ("id", "key", "title", "objective", "payload")
      SELECT
        w."id",
        w."key",
        w."title",
        COALESCE(w."objective", ''),
        to_jsonb(w) || jsonb_build_object(
          'linkedIssueIds',
          COALESCE((
            SELECT jsonb_agg(i."id" ORDER BY i."id")
            FROM "issues" i
            WHERE i."workspaceId" = w."workspaceId"
              AND i."workstreamIds" @> jsonb_build_array(w."id")
          ), '[]'::jsonb)
        )
      FROM "workstreams" w
    `);
    await q.query(`ALTER TABLE "issues" ADD "goal" text`);
    // Copy only when this Issue has one Workstream and that Workstream has one Issue.
    await q.query(`
      UPDATE "issues" i
      SET "goal" = w."objective"
      FROM "workstreams" w
      WHERE jsonb_array_length(i."workstreamIds") = 1
        AND i."workstreamIds"->>0 = w."id"
        AND i."goal" IS NULL
        AND btrim(w."objective") <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM "issues" linked
          WHERE linked."id" <> i."id"
            AND linked."workstreamIds" @> jsonb_build_array(w."id")
        )
    `);

    await q.query(
      `ALTER TABLE "input_requests" ADD "issueId" character varying`,
    );
    await q.query(
      `ALTER TABLE "input_requests" ADD "legacyWorkstreamKey" character varying`,
    );
    await q.query(`
      UPDATE "input_requests" r
      SET "legacyWorkstreamKey" = w."key", "workstreamId" = NULL
      FROM "workstreams" w
      WHERE w."id" = r."workstreamId"
    `);
    await q.query(
      `ALTER TABLE "input_requests" ALTER COLUMN "workstreamId" DROP NOT NULL`,
    );
    await q.query(
      `ALTER TABLE "input_requests" DROP CONSTRAINT IF EXISTS "FK_6668744227c4c46afdab5d048fd"`,
    );
    await q.query(`
      ALTER TABLE "input_requests" ADD CONSTRAINT "FK_input_requests_issue"
      FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await q.query(
      `CREATE INDEX "IDX_input_requests_issue" ON "input_requests" ("issueId")`,
    );

    await q.query(
      `ALTER TABLE "decisions" ADD "originIssueId" character varying`,
    );
    await q.query(
      `ALTER TABLE "decisions" ADD "relatedIssueIds" jsonb NOT NULL DEFAULT '[]'`,
    );
    await q.query(
      `ALTER TABLE "decisions" ADD "legacyWorkstreamKey" character varying`,
    );
    await q.query(
      `ALTER TABLE "decisions" ADD "legacyWorkstreamKeys" jsonb NOT NULL DEFAULT '[]'`,
    );
    await q.query(`
      UPDATE "decisions" d
      SET "legacyWorkstreamKeys" = COALESCE((
            SELECT jsonb_agg(w."key" ORDER BY w."key")
            FROM "workstreams" w
            WHERE w."id" = d."originWorkstreamId"
               OR d."relatedWorkstreamIds" @> jsonb_build_array(w."id")
          ), '[]'::jsonb),
          "legacyWorkstreamKey" = (
            SELECT w."key" FROM "workstreams" w
            WHERE w."id" = d."originWorkstreamId"
            LIMIT 1
          ),
          "originWorkstreamId" = NULL,
          "relatedWorkstreamIds" = '[]'::jsonb
      WHERE d."originWorkstreamId" IS NOT NULL
         OR d."relatedWorkstreamIds" <> '[]'::jsonb
    `);
    await q.query(
      `ALTER TABLE "decisions" DROP CONSTRAINT IF EXISTS "FK_c6697a687945aabef4353ee5c19"`,
    );
    await q.query(`
      ALTER TABLE "decisions" ADD CONSTRAINT "FK_decisions_origin_issue"
      FOREIGN KEY ("originIssueId") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await q.query(
      `ALTER TABLE "artifacts" ADD "legacyWorkstreamKey" character varying`,
    );
    await q.query(
      `DROP TRIGGER IF EXISTS "TRG_artifacts_orphan" ON "artifacts"`,
    );
    await q.query(`DROP FUNCTION IF EXISTS "artifacts_drop_orphan"()`);
    await q.query(
      `ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "CHK_artifacts_owner"`,
    );
    await q.query(`
      UPDATE "artifacts" a
      SET "legacyWorkstreamKey" = w."key", "workstreamId" = NULL
      FROM "workstreams" w
      WHERE w."id" = a."workstreamId"
    `);
    await q.query(
      `ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "FK_artifacts_workstream"`,
    );
    await q.query(`
      ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_owner"
      CHECK ("workstreamId" IS NOT NULL OR "projectId" IS NOT NULL OR "issueId" IS NOT NULL OR "legacyWorkstreamKey" IS NOT NULL)
    `);
    await q.query(`
      CREATE FUNCTION "artifacts_drop_orphan"() RETURNS trigger AS $fn$
      BEGIN
        DELETE FROM "comments" WHERE "workspaceId" = OLD."workspaceId" AND "subject"->>'id' = OLD."id";
        DELETE FROM "dependencies" WHERE "workspaceId" = OLD."workspaceId" AND ("fromId" = OLD."id" OR "toId" = OLD."id");
        DELETE FROM "artifacts" WHERE "id" = OLD."id";
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await q.query(`
      CREATE TRIGGER "TRG_artifacts_orphan" BEFORE UPDATE ON "artifacts" FOR EACH ROW
      WHEN (NEW."workstreamId" IS NULL AND NEW."projectId" IS NULL AND NEW."issueId" IS NULL AND NEW."legacyWorkstreamKey" IS NULL)
      EXECUTE FUNCTION "artifacts_drop_orphan"()
    `);

    await q.query(
      `ALTER TABLE "domain_events" ADD "legacyWorkstreamKey" character varying`,
    );
    await q.query(`
      UPDATE "domain_events" e
      SET "legacyWorkstreamKey" = w."key", "workstreamId" = NULL
      FROM "workstreams" w
      WHERE w."id" = e."workstreamId"
    `);
  }

  public async down(): Promise<void> {
    // The new issue-first associations may have been written after migration;
    // reverting would discard them, so this migration is intentionally forward-only.
    throw new Error(
      'IssueFirst migration cannot be reverted without losing issue ownership data',
    );
  }
}
