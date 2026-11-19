import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Removes project updates, documents, project-level artifacts (project context) and the task goal.
 * `projects.health` is kept (now a manual field); `projects.lastUpdateAt` goes.
 * Data for these features is purged, not exported. Issue rows, ids and keys stay. Artifacts attached to a
 * task (PRs, CI, commits, links) stay; artifacts owned only by a project, and artifacts that point at a
 * Trama document, are deleted. `artifacts.projectId` goes away: an artifact is owned by a task.
 */
export class RemoveProjectUpdatesDocumentsContext1793870000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const q = queryRunner.query.bind(queryRunner);
    const subjects = `'project_update', 'document', 'document_revision'`;

    // Artifacts that go: owned only by a project, or pointing at a Trama document.
    await q(`DROP TABLE IF EXISTS "_removed_artifacts"`);
    await q(`
      CREATE TEMP TABLE "_removed_artifacts" AS
      SELECT "id", "uploadId" FROM "artifacts"
      WHERE ("projectId" IS NOT NULL AND "issueId" IS NULL) OR "documentId" IS NOT NULL
    `);
    const removedIds = `SELECT "id" FROM "_removed_artifacts"`;

    // Rows that point at a removed subject.
    await q(
      `DELETE FROM "comments" WHERE subject->>'type' IN (${subjects}) OR (subject->>'type' = 'artifact' AND subject->>'id' IN (${removedIds}))`,
    );
    await q(
      `DELETE FROM "notifications" WHERE subject->>'type' IN (${subjects}) OR (subject->>'type' = 'artifact' AND subject->>'id' IN (${removedIds}))`,
    );
    await q(
      `DELETE FROM "domain_events" WHERE subject->>'type' IN (${subjects}) OR split_part(type, '.', 1) IN (${subjects}) OR (subject->>'type' = 'artifact' AND subject->>'id' IN (${removedIds}))`,
    );
    await q(`DELETE FROM "favorites" WHERE type IN (${subjects})`);
    await q(
      `DELETE FROM "dependencies" WHERE "fromType" IN (${subjects}) OR "toType" IN (${subjects}) OR "fromId" IN (${removedIds}) OR "toId" IN (${removedIds})`,
    );
    await q(
      `DELETE FROM "attention_state" WHERE split_part("itemId", ':', 2) IN (${removedIds})`,
    );

    // Upload references of removed records, then files nothing mentions any more.
    await q(`DROP TABLE IF EXISTS "_released_uploads"`);
    await q(`
      CREATE TEMP TABLE "_released_uploads" AS
      WITH gone AS (
        DELETE FROM "upload_references"
        WHERE "subjectType" IN (${subjects})
           OR ("subjectType" = 'artifact' AND "subjectId" IN (${removedIds}))
        RETURNING "uploadId"
      )
      SELECT DISTINCT "uploadId" FROM gone
      UNION
      SELECT "uploadId" FROM "_removed_artifacts" WHERE "uploadId" IS NOT NULL
    `);

    await q(`DELETE FROM "artifacts" WHERE "id" IN (${removedIds})`);
    await q(`
      DELETE FROM "uploads" u
      WHERE u."id" IN (SELECT "uploadId" FROM "_released_uploads")
        AND u."referenced" = true
        AND NOT EXISTS (SELECT 1 FROM "upload_references" r WHERE r."uploadId" = u."id")
        AND NOT EXISTS (SELECT 1 FROM "artifacts" a WHERE a."uploadId" = u."id")
    `);
    await q(`DROP TABLE "_released_uploads"`);
    await q(`DROP TABLE "_removed_artifacts"`);

    // Artifacts belong to a task. The orphan trigger and owner check named `projectId`.
    await q(`DROP TRIGGER IF EXISTS "TRG_artifacts_orphan" ON "artifacts"`);
    await q(`DROP FUNCTION IF EXISTS "artifacts_drop_orphan"()`);
    await q(`ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "CHK_artifacts_owner"`);
    await q(`ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "FK_artifacts_project"`);
    await q(`ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "FK_artifacts_document"`);
    await q(`DROP INDEX IF EXISTS "IDX_artifacts_project"`);
    await q(`DROP INDEX IF EXISTS "IDX_artifacts_document"`);
    await q(`ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "projectId"`);
    await q(`ALTER TABLE "artifacts" DROP COLUMN IF EXISTS "documentId"`);
    await q(`
      ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_owner"
      CHECK ("issueId" IS NOT NULL OR "legacyWorkstreamKey" IS NOT NULL)
    `);
    await q(`
      CREATE FUNCTION "artifacts_drop_orphan"() RETURNS trigger AS $fn$
      BEGIN
        IF NEW."issueId" IS NULL AND NEW."legacyWorkstreamKey" IS NULL THEN
          DELETE FROM "comments" WHERE "workspaceId" = OLD."workspaceId" AND "subject"->>'id' = OLD."id";
          DELETE FROM "dependencies" WHERE "workspaceId" = OLD."workspaceId" AND ("fromId" = OLD."id" OR "toId" = OLD."id");
          DELETE FROM "artifacts" WHERE "id" = OLD."id";
        END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await q(`
      CREATE TRIGGER "TRG_artifacts_orphan" BEFORE UPDATE ON "artifacts" FOR EACH ROW
      WHEN (NEW."issueId" IS NULL AND NEW."legacyWorkstreamKey" IS NULL)
      EXECUTE FUNCTION "artifacts_drop_orphan"()
    `);

    await q(`DROP TABLE IF EXISTS "document_revisions" CASCADE`);
    await q(`DROP TABLE IF EXISTS "documents" CASCADE`);
    await q(`DROP TABLE IF EXISTS "project_updates" CASCADE`);
    await q(`ALTER TABLE "issues" DROP COLUMN IF EXISTS "goal"`);
    // `projects.health` stays: it is now set by hand (the last value a project update wrote is kept).
    await q(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "lastUpdateAt"`);

    // Permissions and subscriptions for the removed resources and events.
    await q(`
      UPDATE "api_tokens"
      SET permissions = (
        SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
        FROM jsonb_array_elements_text(permissions) AS p
        WHERE split_part(p, ':', 1) <> 'documents'
      )
      WHERE permissions IS NOT NULL AND jsonb_typeof(permissions) = 'array'
    `);
    await q(`
      UPDATE "workspaces"
      SET settings = jsonb_set(settings, '{roles}', (
        SELECT COALESCE(jsonb_agg(
          CASE WHEN jsonb_typeof(r->'grants') = 'array'
            THEN jsonb_set(r, '{grants}', COALESCE((
              SELECT jsonb_agg(g)
              FROM jsonb_array_elements_text(r->'grants') AS g
              WHERE g NOT LIKE 'documents:%'
            ), '[]'::jsonb))
            ELSE r
          END
        ), '[]'::jsonb)
        FROM jsonb_array_elements(settings->'roles') AS r
      ))
      WHERE jsonb_typeof(settings->'roles') = 'array'
    `);
    await q(`
      UPDATE "memberships"
      SET access = jsonb_set(access, '{grants}', COALESCE((
        SELECT jsonb_agg(g)
        FROM jsonb_array_elements_text(access->'grants') AS g
        WHERE g NOT LIKE 'documents:%'
      ), '[]'::jsonb))
      WHERE access IS NOT NULL AND jsonb_typeof(access->'grants') = 'array'
    `);
    await q(`
      UPDATE "outgoing_webhooks"
      SET events = COALESCE((
            SELECT jsonb_agg(e)
            FROM jsonb_array_elements_text(events) AS e
            WHERE e NOT LIKE 'document.%' AND e NOT LIKE 'project\\_update.%'
          ), '[]'::jsonb),
          enabled = CASE
            WHEN EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(events) AS e
              WHERE e NOT LIKE 'document.%' AND e NOT LIKE 'project\\_update.%'
            ) THEN enabled
            ELSE false
          END
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(events) AS e
        WHERE e LIKE 'document.%' OR e LIKE 'project\\_update.%'
      )
    `);
    await q(
      `DELETE FROM "outgoing_webhook_deliveries" WHERE event LIKE 'document.%' OR event LIKE 'project\\_update.%'`,
    );
  }

  async down(): Promise<void> {
    throw new Error('RemoveProjectUpdatesDocumentsContext cannot be reversed');
  }
}
