import { MigrationInterface, QueryRunner } from 'typeorm';

/** One LunaGest task per Trama issue. `remoteTaskId` is unique in the workspace when set. */
export class LunaGestIssueLinks1793810000000 implements MigrationInterface {
  name = 'LunaGestIssueLinks1793810000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "lunagest_issue_links" (
        "issueId" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "remoteTaskId" character varying,
        "state" character varying NOT NULL,
        "lastError" text,
        "lastSyncedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_lunagest_issue_links" PRIMARY KEY ("issueId")
      )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_lunagest_issue_links_remote" ON "lunagest_issue_links" ("workspaceId", "remoteTaskId") WHERE "remoteTaskId" IS NOT NULL`,
    );
    await q.query(
      `ALTER TABLE "lunagest_issue_links" ADD CONSTRAINT "FK_lunagest_issue_links_issue" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "lunagest_issue_links" ADD CONSTRAINT "FK_lunagest_issue_links_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "lunagest_issue_links"`);
  }
}
