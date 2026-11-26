import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Connections can belong to a person as well as to a workspace.
 *
 * - `ownerType` ('workspace' | 'user'), `ownerUserId`, `label` and `host` are added; `workspaceId`
 *   becomes nullable (null for personal connections).
 * - Every existing row becomes a workspace connection. Its label is "<Provider> · <account>" and its
 *   host comes from the base URL (or the provider's public host), so nothing changes for users.
 * - `disconnected` (never written by the app) becomes `revoked`.
 * - Several accounts per provider: there was never a unique (workspace, provider) constraint, only a
 *   check in the service. The uniqueness is now (owner, provider, host, account, baseUrl).
 */
export class ConnectionOwnership1794200000000 implements MigrationInterface {
  name = 'ConnectionOwnership1794200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE "integration_connections" ADD "ownerType" character varying NOT NULL DEFAULT 'workspace'`,
    );
    await q.query(`ALTER TABLE "integration_connections" ADD "ownerUserId" character varying`);
    await q.query(`ALTER TABLE "integration_connections" ADD "label" character varying`);
    await q.query(`ALTER TABLE "integration_connections" ADD "host" character varying`);

    await q.query(`
      UPDATE "integration_connections" SET
        "host" = lower(COALESCE(
          NULLIF(substring("baseUrl" from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+)'), ''),
          CASE "provider"
            WHEN 'github' THEN 'github.com'
            WHEN 'gitlab' THEN 'gitlab.com'
            WHEN 'bitbucket' THEN 'bitbucket.org'
            ELSE "provider"
          END
        )),
        "label" = CASE "provider"
          WHEN 'github' THEN 'GitHub'
          WHEN 'gitlab' THEN 'GitLab'
          WHEN 'bitbucket' THEN 'Bitbucket'
          ELSE 'Delta'
        END || ' · ' || "account"
    `);
    await q.query(`UPDATE "integration_connections" SET "status" = 'revoked' WHERE "status" = 'disconnected'`);

    await q.query(`ALTER TABLE "integration_connections" ALTER COLUMN "label" SET NOT NULL`);
    await q.query(`ALTER TABLE "integration_connections" ALTER COLUMN "host" SET NOT NULL`);
    await q.query(`ALTER TABLE "integration_connections" ALTER COLUMN "workspaceId" DROP NOT NULL`);

    await q.query(
      `ALTER TABLE "integration_connections" ADD CONSTRAINT "FK_integration_connections_owner_user" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(`CREATE INDEX "IDX_integrations_owner_user" ON "integration_connections" ("ownerUserId")`);
    await q.query(`
      ALTER TABLE "integration_connections" ADD CONSTRAINT "CHK_integration_connections_owner" CHECK (
        ("ownerType" = 'workspace' AND "workspaceId" IS NOT NULL)
        OR ("ownerType" = 'user' AND "ownerUserId" IS NOT NULL)
      )
    `);
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integrations_workspace_account"
      ON "integration_connections" ("workspaceId", "provider", "host", "account", (COALESCE("baseUrl", '')))
      WHERE "ownerType" = 'workspace'
    `);
    await q.query(`
      CREATE UNIQUE INDEX "UQ_integrations_user_account"
      ON "integration_connections" ("ownerUserId", "provider", "host", "account", (COALESCE("baseUrl", '')))
      WHERE "ownerType" = 'user'
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "UQ_integrations_user_account"`);
    await q.query(`DROP INDEX "UQ_integrations_workspace_account"`);
    await q.query(`ALTER TABLE "integration_connections" DROP CONSTRAINT "CHK_integration_connections_owner"`);
    await q.query(`DROP INDEX "IDX_integrations_owner_user"`);
    await q.query(`ALTER TABLE "integration_connections" DROP CONSTRAINT "FK_integration_connections_owner_user"`);
    // Personal connections have no workspace to go back to.
    await q.query(`DELETE FROM "integration_connections" WHERE "ownerType" = 'user'`);
    await q.query(`ALTER TABLE "integration_connections" ALTER COLUMN "workspaceId" SET NOT NULL`);
    await q.query(`UPDATE "integration_connections" SET "status" = 'disconnected' WHERE "status" = 'revoked'`);
    await q.query(`ALTER TABLE "integration_connections" DROP COLUMN "host"`);
    await q.query(`ALTER TABLE "integration_connections" DROP COLUMN "label"`);
    await q.query(`ALTER TABLE "integration_connections" DROP COLUMN "ownerUserId"`);
    await q.query(`ALTER TABLE "integration_connections" DROP COLUMN "ownerType"`);
  }
}
