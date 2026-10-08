import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Fine-grained API tokens: `permissions` (explicit resource:action list, only for `custom` tokens),
 * `limits` (request/write budget; existing tokens get the defaults) and a per-day write counter.
 */
export class TokenPermissions1791900000000 implements MigrationInterface {
  name = 'TokenPermissions1791900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "api_tokens" ADD "permissions" jsonb`);
    await q.query(
      `ALTER TABLE "api_tokens" ADD "limits" jsonb NOT NULL DEFAULT '{"requestsPerMinute":600,"writesPerMinute":60,"writesPerDay":2000}'`,
    );
    await q.query(
      `CREATE TABLE "api_token_usage" ("tokenId" character varying NOT NULL, "day" date NOT NULL, "writes" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_api_token_usage" PRIMARY KEY ("tokenId", "day"))`,
    );
    await q.query(
      `ALTER TABLE "api_token_usage" ADD CONSTRAINT "FK_api_token_usage_token" FOREIGN KEY ("tokenId") REFERENCES "api_tokens"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "api_token_usage"`);
    await q.query(`ALTER TABLE "api_tokens" DROP COLUMN "limits"`);
    await q.query(`ALTER TABLE "api_tokens" DROP COLUMN "permissions"`);
  }
}
