import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * An artifact may be owned by a project, a workstream and/or an issue (at least one).
 * - `workstreamId` becomes nullable; `projectId` and `issueId` are new; `description` is new.
 * - Owner FKs are `ON DELETE SET NULL`. When the last owner goes away the artifact is deleted
 *   (with its comments and dependencies) by a BEFORE UPDATE trigger, so a CHECK can guarantee "at least one owner".
 */
export class ArtifactOwners1792800000100 implements MigrationInterface {
  name = 'ArtifactOwners1792800000100';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "artifacts" ALTER COLUMN "workstreamId" DROP NOT NULL`);
    await q.query(`ALTER TABLE "artifacts" ADD "projectId" character varying`);
    await q.query(`ALTER TABLE "artifacts" ADD "issueId" character varying`);
    await q.query(`ALTER TABLE "artifacts" ADD "description" text`);
    await q.query(`CREATE INDEX "IDX_artifacts_project" ON "artifacts" ("projectId")`);
    await q.query(`CREATE INDEX "IDX_artifacts_issue" ON "artifacts" ("issueId")`);
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT IF EXISTS "FK_cac8e5a5b5bede42039a360dcbc"`);
    await q.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_workstream" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_project" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_issue" FOREIGN KEY ("issueId") REFERENCES "issues"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "CHK_artifacts_owner" CHECK ("workstreamId" IS NOT NULL OR "projectId" IS NOT NULL OR "issueId" IS NOT NULL)`,
    );
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
      WHEN (NEW."workstreamId" IS NULL AND NEW."projectId" IS NULL AND NEW."issueId" IS NULL)
      EXECUTE FUNCTION "artifacts_drop_orphan"()
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TRIGGER "TRG_artifacts_orphan" ON "artifacts"`);
    await q.query(`DROP FUNCTION "artifacts_drop_orphan"()`);
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "CHK_artifacts_owner"`);
    // Artifacts that only belong to a project/issue cannot be represented without a workstream.
    await q.query(`DELETE FROM "artifacts" WHERE "workstreamId" IS NULL`);
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_issue"`);
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_project"`);
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_workstream"`);
    await q.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_cac8e5a5b5bede42039a360dcbc" FOREIGN KEY ("workstreamId") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(`DROP INDEX "IDX_artifacts_issue"`);
    await q.query(`DROP INDEX "IDX_artifacts_project"`);
    await q.query(`ALTER TABLE "artifacts" DROP COLUMN "description"`);
    await q.query(`ALTER TABLE "artifacts" DROP COLUMN "issueId"`);
    await q.query(`ALTER TABLE "artifacts" DROP COLUMN "projectId"`);
    await q.query(`ALTER TABLE "artifacts" ALTER COLUMN "workstreamId" SET NOT NULL`);
  }
}
