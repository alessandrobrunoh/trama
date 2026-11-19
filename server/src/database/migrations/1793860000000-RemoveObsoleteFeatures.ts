import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Drops teams, the repository registry, decisions, releases, input requests,
 * and customers (including intake). Issue rows, ids, keys, project and assignee
 * stay. Artifact repository ids become the git full name, not a registry id.
 */
export class RemoveObsoleteFeatures1793860000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const q = queryRunner.query.bind(queryRunner);
    const subjects = [
      'team',
      'repository',
      'decision',
      'input_request',
      'customer',
      'customer_request',
      'release',
      'release_pipeline',
    ];
    const list = subjects.map((s) => `'${s}'`).join(', ');

    await q(`DELETE FROM "comments" WHERE subject->>'type' IN (${list})`);
    await q(`DELETE FROM "notifications" WHERE subject->>'type' IN (${list})`);
    await q(
      `DELETE FROM "favorites" WHERE type IN (${list}, 'customer_subscription', 'intake_item')`,
    );
    await q(
      `DELETE FROM "domain_events" WHERE subject->>'type' IN (${list}) OR split_part(type, '.', 1) IN ('team', 'repository', 'decision', 'input_request', 'input', 'customer', 'customer_request', 'release', 'release_pipeline', 'intake')`,
    );
    await q(
      `DELETE FROM "dependencies" WHERE "fromType" IN (${list}) OR "toType" IN (${list})`,
    );
    await q(`DELETE FROM "saved_views" WHERE entity = 'decision'`);
    await q(`
      UPDATE "saved_views"
      SET filters = COALESCE((
        SELECT jsonb_agg(f)
        FROM jsonb_array_elements(filters) f
        WHERE f->>'field' NOT IN (
          'teamId', 'team', 'releaseId', 'customerId', 'repositoryId', 'repositoryIds'
        )
      ), '[]'::jsonb)
    `);
    // Notifications of removed kinds (questions, decisions, customer events, ...) may sit on an issue
    // subject: they go too. Only the kinds that still exist stay.
    await q(
      `DELETE FROM "notifications" WHERE kind NOT IN ('assigned', 'review_requested', 'ci_failed', 'comment', 'workstream_update')`,
    );
    // Links are stored relative to the workspace (`issues/BUG-1`), some with a leading slash.
    await q(`
      UPDATE "notifications"
      SET link = regexp_replace(link, '^(/?)issues(/|$)', '\\1tasks\\2')
      WHERE subject->>'type' = 'issue' AND link ~ '^/?issues(/|$)'
    `);
    await q(`
      UPDATE "domain_events"
      SET actor = '{"type":"system"}'::jsonb
      WHERE actor->>'type' = 'team'
    `);
    await q(`
      UPDATE "comments"
      SET author = '{"type":"system"}'::jsonb
      WHERE author->>'type' = 'team'
    `);
    await q(`
      UPDATE "notifications"
      SET actor = '{"type":"system"}'::jsonb
      WHERE actor->>'type' = 'team'
    `);
    // `team` is no longer an actor type: any other stored actor reference becomes `system`.
    await q(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT table_name, column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND data_type = 'jsonb'
            AND column_name IN ('actor', 'author', 'lastEditor', 'editor', 'authorRef', 'createdBy')
        LOOP
          EXECUTE format(
            'UPDATE %I SET %I = %L::jsonb WHERE jsonb_typeof(%I) = ''object'' AND %I->>''type'' = ''team''',
            r.table_name, r.column_name, '{"type":"system"}', r.column_name, r.column_name
          );
        END LOOP;
      END $$;
    `);
    await q(
      `DELETE FROM "attention_state" WHERE split_part("itemId", ':', 1) IN ('input_request', 'decision', 'customer', 'release', 'team')`,
    );

    // Foreign keys into the removed tables go first: artifacts keep a plain string where the
    // registry id used to be.
    await q(`
      DO $$
      DECLARE r record;
      BEGIN
        FOR r IN
          SELECT con.conname, rel.relname
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_class frel ON frel.oid = con.confrelid
          WHERE con.contype = 'f'
            AND frel.relname IN (
              'teams', 'repositories', 'input_requests', 'release_pipelines',
              'releases', 'customers', 'customer_requests', 'customer_subscriptions',
              'customer_intake_sources', 'customer_intake_items', 'decisions'
            )
        LOOP
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.relname, r.conname);
        END LOOP;
      END $$;
    `);

    await q(`
      UPDATE "artifacts" a
      SET "repositoryId" = r."fullName"
      FROM "repositories" r
      WHERE a."repositoryId" = r.id
    `);
    await q(`
      UPDATE "artifact_sources" s
      SET "repositoryId" = r."fullName"
      FROM "repositories" r
      WHERE s."repositoryId" = r.id
    `);
    await q(`ALTER TABLE "artifacts" RENAME COLUMN "repositoryId" TO "repository"`);
    await q(`ALTER TABLE "artifact_sources" RENAME COLUMN "repositoryId" TO "repository"`);

    // First linked registry row, in stored array order. Later ids are discarded.
    // The kept value is the repository URL (fullName is not a URL).
    await q(`
      UPDATE "projects" p
      SET repository = picked.url
      FROM (
        SELECT p2.id,
          (
            SELECT r.url
            FROM jsonb_array_elements_text(p2."repositoryIds") WITH ORDINALITY AS e(rid, ord)
            JOIN "repositories" r ON r.id = e.rid
            ORDER BY e.ord
            LIMIT 1
          ) AS url
        FROM "projects" p2
        WHERE p2.repository IS NULL
          AND jsonb_array_length(p2."repositoryIds") > 0
      ) picked
      WHERE p.id = picked.id AND picked.url IS NOT NULL
    `);

    await q(`ALTER TABLE "issues" DROP COLUMN IF EXISTS "teamId"`);
    await q(`ALTER TABLE "issues" DROP COLUMN IF EXISTS "releaseId"`);
    await q(`DROP INDEX IF EXISTS "IDX_issues_release"`);
    await q(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "teamIds"`);
    await q(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "repositoryIds"`);

    for (const table of [
      'customer_intake_items',
      'customer_intake_sources',
      'customer_subscriptions',
      'customer_requests',
      'customers',
      'input_requests',
      'decisions',
      'releases',
      'release_pipelines',
      'repositories',
      'teams',
    ]) {
      await q(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }

    await q(
      `UPDATE "workspaces" SET settings = settings - 'customerTiers' - 'defaultTeamId' WHERE settings ?| array['customerTiers', 'defaultTeamId']`,
    );
    await q(`
      UPDATE "users"
      SET "notificationSettings" = "notificationSettings"
        - 'input_requested' - 'decision_proposed'
        - 'customer_request' - 'customer_important' - 'customer_delivered'
      WHERE "notificationSettings" ?| array[
        'input_requested', 'decision_proposed',
        'customer_request', 'customer_important', 'customer_delivered'
      ]
    `);
    await q(`
      UPDATE "api_tokens"
      SET permissions = (
        SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
        FROM jsonb_array_elements_text(permissions) AS p
        WHERE split_part(p, ':', 1) NOT IN (
          'customers', 'decisions', 'releases', 'input-requests', 'teams', 'repositories'
        )
      )
      WHERE permissions IS NOT NULL
    `);
    await q(`
      UPDATE "api_tokens"
      SET permissions = (
        SELECT COALESCE(jsonb_agg(
          CASE WHEN split_part(p, ':', 1) = 'issues'
            THEN to_jsonb('tasks:' || split_part(p, ':', 2))
            ELSE to_jsonb(p)
          END
        ), '[]'::jsonb)
        FROM jsonb_array_elements_text(permissions) AS p
      )
      WHERE permissions IS NOT NULL
    `);
    await q(`
      UPDATE "integration_connections"
      SET config = config - 'repositoryIds'
      WHERE config ? 'repositoryIds'
    `);
  }

  async down(): Promise<void> {
    throw new Error('RemoveObsoleteFeatures cannot be reversed');
  }
}
