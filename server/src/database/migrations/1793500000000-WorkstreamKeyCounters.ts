import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Workstream numbers are counted per team key (`wskey:<KEY>`) instead of per team row (`ws:<teamId>`), so
 * deleting a team and recreating one with the same key continues the sequence instead of restarting at 1
 * (which collided with a surviving workstream that kept its key). Backfills each counter from the old
 * per-team counters and from the highest number any workstream already uses with that key prefix.
 */
export class WorkstreamKeyCounters1793500000000 implements MigrationInterface {
  name = 'WorkstreamKeyCounters1793500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `INSERT INTO "workspace_counters" ("workspaceId","name","value")
       SELECT x."workspaceId", 'wskey:' || x."prefix", MAX(x."value")
       FROM (
         SELECT w."workspaceId", regexp_replace(w."key", '-[0-9]+$', '') AS "prefix", w."number" AS "value"
         FROM "workstreams" w
         UNION ALL
         SELECT c."workspaceId", t."key" AS "prefix", c."value"
         FROM "workspace_counters" c
         JOIN "teams" t ON t."workspaceId" = c."workspaceId" AND c."name" = 'ws:' || t."id"
       ) x
       GROUP BY x."workspaceId", x."prefix"
       ON CONFLICT ("workspaceId","name") DO UPDATE SET "value" = GREATEST("workspace_counters"."value", EXCLUDED."value")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM "workspace_counters" WHERE "name" LIKE 'wskey:%'`);
  }
}
