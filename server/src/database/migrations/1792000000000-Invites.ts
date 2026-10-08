import { MigrationInterface, QueryRunner } from 'typeorm';

/** Invitations by email: a hashed secret token per invite, valid until `expiresAt`. */
export class Invites1792000000000 implements MigrationInterface {
  name = 'Invites1792000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "invites" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "email" character varying NOT NULL,
        "role" character varying NOT NULL,
        "tokenHash" character varying NOT NULL,
        "invitedByUserId" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "emailedAt" TIMESTAMP WITH TIME ZONE,
        "acceptedAt" TIMESTAMP WITH TIME ZONE,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_invites" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE INDEX "IDX_invites_workspace" ON "invites" ("workspaceId")`);
    await q.query(`CREATE INDEX "IDX_invites_email" ON "invites" ("email")`);
    await q.query(`CREATE UNIQUE INDEX "UQ_invites_token" ON "invites" ("tokenHash")`);
    await q.query(
      `ALTER TABLE "invites" ADD CONSTRAINT "FK_invites_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "invites" ADD CONSTRAINT "FK_invites_invitedBy" FOREIGN KEY ("invitedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "invites"`);
  }
}
