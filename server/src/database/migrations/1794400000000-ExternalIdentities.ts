import { randomBytes } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';

const PUBLIC_HOST: Record<string, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

/** `https://git.acme.dev/` → `git.acme.dev`; the provider's public host when there is no base URL. */
function hostOf(provider: string, baseUrl: string | null): string | null {
  if (!baseUrl?.trim()) return PUBLIC_HOST[provider] ?? null;
  const host = baseUrl
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/?#]/)[0]
    ?.replace(/\.$/, '');
  return host && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/.test(host) ? host : null;
}

const validLogin = (login: string | null): login is string =>
  !!login && login.length <= 100 && /^[^\s/\\]+$/.test(login);

/**
 * `external_identities`: the logins a person has in other tools (GitHub, GitLab…), unique per
 * (provider, host, login) ignoring case. Filled from what already tells us who is who:
 * saved GitHub tracker credentials, personal integration connections, and the user mappings
 * chosen in earlier GitHub imports. Every backfill step skips a login that is already taken.
 */
export class ExternalIdentities1794400000000 implements MigrationInterface {
  name = 'ExternalIdentities1794400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "external_identities" (
        "id" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "host" character varying NOT NULL,
        "login" character varying(100) NOT NULL,
        "source" character varying NOT NULL DEFAULT 'manual',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_external_identities" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_external_identities_source" CHECK ("source" IN ('connection', 'manual'))
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_external_identities_user" ON "external_identities" ("userId")`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_external_identities_login" ON "external_identities" (lower("provider"), lower("host"), lower("login"))`,
    );
    await q.query(
      `ALTER TABLE "external_identities" ADD CONSTRAINT "FK_external_identities_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // 1. GitHub tokens saved for imports: the account is the token owner's login.
    const credentials: { userId: string; baseUrl: string | null; login: string }[] =
      await q.query(
        `SELECT c."createdBy"->>'id' AS "userId", c."baseUrl", c."account" AS "login"
           FROM "tracker_credentials" c
           JOIN "users" u ON u."id" = c."createdBy"->>'id'
          WHERE c."provider" = 'github' AND c."createdBy"->>'type' = 'user'
          ORDER BY c."createdAt" ASC`,
      );
    for (const c of credentials)
      await this.insert(q, c.userId, 'github', hostOf('github', c.baseUrl), c.login, 'connection');

    // 2. Personal integration connections, when that column exists (added by the personal
    //    connections step; this migration does not depend on it).
    const owned: unknown[] = await q.query(
      `SELECT 1 FROM "information_schema"."columns"
        WHERE "table_name" = 'integration_connections' AND "column_name" = 'ownerUserId'`,
    );
    if (owned.length) {
      const connections: {
        userId: string;
        provider: string;
        baseUrl: string | null;
        login: string;
      }[] = await q.query(
        `SELECT c."ownerUserId" AS "userId", c."provider", c."baseUrl", c."account" AS "login"
           FROM "integration_connections" c
           JOIN "users" u ON u."id" = c."ownerUserId"
          WHERE c."ownerUserId" IS NOT NULL AND c."provider" IN ('github', 'gitlab', 'bitbucket')
          ORDER BY c."createdAt" ASC`,
      );
      for (const c of connections)
        await this.insert(q, c.userId, c.provider, hostOf(c.provider, c.baseUrl), c.login, 'connection');
    }

    // 3. Who an admin mapped each GitHub login to in earlier imports (only members of that workspace).
    const mapped: { login: string; userId: string; baseUrl: string | null }[] =
      await q.query(
        `SELECT m."key" AS "login", m."value" AS "userId", COALESCE(tc."baseUrl", ic."baseUrl") AS "baseUrl"
           FROM "import_jobs" j
           CROSS JOIN LATERAL jsonb_each_text(COALESCE(j."mapping"->'users', '{}'::jsonb)) m
           LEFT JOIN "tracker_credentials" tc ON tc."id" = j."credential"->>'credentialId'
           LEFT JOIN "integration_connections" ic ON ic."id" = j."credential"->>'connectionId'
           JOIN "memberships" ms ON ms."workspaceId" = j."workspaceId" AND ms."userId" = m."value"
          WHERE j."provider" = 'github' AND m."value" IS NOT NULL
          ORDER BY j."createdAt" ASC`,
      );
    for (const m of mapped)
      await this.insert(q, m.userId, 'github', hostOf('github', m.baseUrl), m.login, 'manual');
  }

  private async insert(
    q: QueryRunner,
    userId: string,
    provider: string,
    host: string | null,
    login: string | null,
    source: 'connection' | 'manual',
  ): Promise<void> {
    if (!host || !validLogin(login)) return;
    await q.query(
      `INSERT INTO "external_identities" ("id", "userId", "provider", "host", "login", "source")
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [`xid_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`, userId, provider, host, login, source],
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "external_identities"`);
  }
}
