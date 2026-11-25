import { randomBytes } from 'node:crypto';
import type { MigrationInterface, QueryRunner } from 'typeorm';
import { hostOfConnection, parseRepositoryReference } from '../../routing/source-path.js';
import type { GitProvider } from '../../contracts/domain.js';

const HEALTHY = new Set(['connected', 'ok']);
const ruleId = (): string => `rr_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;

/**
 * Routing rules: which external source (repository, group) sends work to which project, and through
 * which connection. `routing_rule_items` remembers what a rule placed (idempotent ingestion, task counts,
 * two-way sync).
 *
 * Backfill: a project with a `repository` string gets an inbound rule through the workspace's connection
 * for that provider and host, when there is one. `projects.repository` stays as it was.
 */
export class RoutingRules1794300000000 implements MigrationInterface {
  name = 'RoutingRules1794300000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "routing_rules" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "projectId" character varying NOT NULL,
        "connectionId" character varying,
        "provider" character varying NOT NULL,
        "host" character varying NOT NULL,
        "sourcePath" character varying(2048) NOT NULL,
        "filters" jsonb NOT NULL DEFAULT '{}',
        "filterKey" character varying(1024) NOT NULL DEFAULT '',
        "direction" character varying NOT NULL DEFAULT 'inbound',
        "createdBy" jsonb NOT NULL,
        "migratedFrom" character varying(2048),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lastSyncAt" TIMESTAMP WITH TIME ZONE,
        "lastError" text,
        CONSTRAINT "PK_routing_rules" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_routing_rules_direction" CHECK ("direction" IN ('inbound', 'two_way'))
      )`,
    );
    await q.query(`CREATE INDEX "IDX_routing_rules_project" ON "routing_rules" ("projectId")`);
    await q.query(`CREATE INDEX "IDX_routing_rules_connection" ON "routing_rules" ("connectionId")`);
    // One source, one destination: the same source (any letter case) with the same filters twice is a duplicate.
    // Different filters that could still match the same item are refused by the service.
    await q.query(
      `CREATE UNIQUE INDEX "UQ_routing_rules_source" ON "routing_rules" ("workspaceId", lower("provider"), lower("host"), lower("sourcePath"), "filterKey")`,
    );
    await q.query(
      `ALTER TABLE "routing_rules" ADD CONSTRAINT "FK_routing_rules_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "routing_rules" ADD CONSTRAINT "FK_routing_rules_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // A removed connection leaves the rule in a visible error state instead of deleting it.
    await q.query(
      `ALTER TABLE "routing_rules" ADD CONSTRAINT "FK_routing_rules_connection" FOREIGN KEY ("connectionId") REFERENCES "integration_connections"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await q.query(
      `CREATE TABLE "routing_rule_items" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "ruleId" character varying,
        "provider" character varying NOT NULL,
        "host" character varying NOT NULL,
        "repository" character varying(2048) NOT NULL,
        "kind" character varying NOT NULL,
        "externalId" character varying NOT NULL,
        "issueId" character varying,
        "url" character varying(2048),
        "externalState" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_routing_rule_items" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE INDEX "IDX_routing_rule_items_rule" ON "routing_rule_items" ("ruleId", "createdAt")`);
    await q.query(`CREATE INDEX "IDX_routing_rule_items_issue" ON "routing_rule_items" ("issueId")`);
    await q.query(
      `CREATE UNIQUE INDEX "UQ_routing_rule_items_external" ON "routing_rule_items" ("workspaceId", "provider", "host", "repository", "kind", "externalId")`,
    );
    await q.query(
      `ALTER TABLE "routing_rule_items" ADD CONSTRAINT "FK_routing_rule_items_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "routing_rule_items" ADD CONSTRAINT "FK_routing_rule_items_rule" FOREIGN KEY ("ruleId") REFERENCES "routing_rules"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "routing_rule_items" ADD CONSTRAINT "FK_routing_rule_items_issue" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await this.backfill(q);
  }

  /** One inbound rule per project that names a repository, via the workspace connection that reaches it. */
  private async backfill(q: QueryRunner): Promise<void> {
    const projects = (await q.query(
      `SELECT "id", "workspaceId", "repository" FROM "projects" WHERE "repository" IS NOT NULL AND btrim("repository") <> '' ORDER BY "createdAt", "id"`,
    )) as { id: string; workspaceId: string; repository: string }[];
    if (!projects.length) return;
    // Another change adds personal connections; those never serve a rule created on someone's behalf.
    const personal = (await q.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'integration_connections' AND column_name = 'ownerType'`,
    )) as unknown[];
    const workspaceOnly = personal.length ? `AND ("ownerType" IS NULL OR "ownerType" = 'workspace')` : '';
    for (const project of projects) {
      const ref = parseRepositoryReference(project.repository);
      if (!ref) continue;
      const connections = (await q.query(
        `SELECT "id", "baseUrl", "status" FROM "integration_connections"
         WHERE "workspaceId" = $1 AND "provider" = $2 ${workspaceOnly} ORDER BY "createdAt", "id"`,
        [project.workspaceId, ref.provider],
      )) as { id: string; baseUrl: string | null; status: string }[];
      const reaching = connections.filter((c) => hostOfConnection(ref.provider as GitProvider, c.baseUrl) === ref.host);
      const connection = reaching.find((c) => HEALTHY.has(c.status)) ?? reaching[0];
      if (!connection) continue;
      await q.query(
        `INSERT INTO "routing_rules" ("id", "workspaceId", "projectId", "connectionId", "provider", "host", "sourcePath", "createdBy", "migratedFrom")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          ruleId(),
          project.workspaceId,
          project.id,
          connection.id,
          ref.provider,
          ref.host,
          ref.path,
          JSON.stringify({ type: 'system' }),
          project.repository.trim().slice(0, 2048),
        ],
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS "routing_rule_items"`);
    await q.query(`DROP TABLE IF EXISTS "routing_rules"`);
  }
}
