import { MigrationInterface, QueryRunner } from 'typeorm';

/** Indexed mentions of an upload, so opening a file does not scan every body in the workspace. */
export class UploadReferences1793840000000 implements MigrationInterface {
  name = 'UploadReferences1793840000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "upload_references" (
        "workspaceId" character varying NOT NULL,
        "uploadId" character varying NOT NULL,
        "subjectType" character varying NOT NULL,
        "subjectId" character varying NOT NULL,
        "projectId" character varying,
        CONSTRAINT "PK_upload_references" PRIMARY KEY ("workspaceId", "uploadId", "subjectType", "subjectId")
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_upload_references_upload" ON "upload_references" ("workspaceId", "uploadId")`,
    );
    await q.query(
      `CREATE INDEX "IDX_upload_references_subject" ON "upload_references" ("workspaceId", "subjectType", "subjectId")`,
    );
    await q.query(
      `ALTER TABLE "upload_references" ADD CONSTRAINT "FK_upload_references_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "upload_references" ADD CONSTRAINT "FK_upload_references_upload" FOREIGN KEY ("uploadId") REFERENCES "uploads"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(`
      INSERT INTO "upload_references" ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
      SELECT DISTINCT i."workspaceId", m.match[1], 'issue', i."id", i."projectId"
      FROM "issues" i
      CROSS JOIN LATERAL regexp_matches(coalesce(i."body", ''), '/uploads/(upl_[a-z0-9]{10,24})', 'g') AS m(match)
      WHERE EXISTS (
        SELECT 1 FROM "uploads" u WHERE u."id" = m.match[1] AND u."workspaceId" = i."workspaceId"
      )
    `);
    await q.query(`
      INSERT INTO "upload_references" ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
      SELECT DISTINCT p."workspaceId", m.match[1], 'project', p."id", p."id"
      FROM "projects" p
      CROSS JOIN LATERAL regexp_matches(coalesce(p."description", ''), '/uploads/(upl_[a-z0-9]{10,24})', 'g') AS m(match)
      WHERE EXISTS (
        SELECT 1 FROM "uploads" u WHERE u."id" = m.match[1] AND u."workspaceId" = p."workspaceId"
      )
    `);
    await q.query(`
      INSERT INTO "upload_references" ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
      SELECT DISTINCT d."workspaceId", m.match[1], 'document', d."id", NULL
      FROM "documents" d
      CROSS JOIN LATERAL regexp_matches(d."body", '/uploads/(upl_[a-z0-9]{10,24})', 'g') AS m(match)
      WHERE EXISTS (
        SELECT 1 FROM "uploads" u WHERE u."id" = m.match[1] AND u."workspaceId" = d."workspaceId"
      )
    `);
    await q.query(`
      INSERT INTO "upload_references" ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
      SELECT DISTINCT r."workspaceId", m.match[1], 'document_revision', r."id", NULL
      FROM "document_revisions" r
      CROSS JOIN LATERAL regexp_matches(r."body", '/uploads/(upl_[a-z0-9]{10,24})', 'g') AS m(match)
      WHERE EXISTS (
        SELECT 1 FROM "uploads" u WHERE u."id" = m.match[1] AND u."workspaceId" = r."workspaceId"
      )
    `);
    await q.query(`
      INSERT INTO "upload_references" ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
      SELECT DISTINCT c."workspaceId", m.match[1], 'comment', c."id", NULL
      FROM "comments" c
      CROSS JOIN LATERAL regexp_matches(c."body", '/uploads/(upl_[a-z0-9]{10,24})', 'g') AS m(match)
      WHERE EXISTS (
        SELECT 1 FROM "uploads" u WHERE u."id" = m.match[1] AND u."workspaceId" = c."workspaceId"
      )
    `);
    await q.query(`
      INSERT INTO "upload_references" ("workspaceId", "uploadId", "subjectType", "subjectId", "projectId")
      SELECT a."workspaceId", a."uploadId", 'artifact', a."id", COALESCE(a."projectId", i."projectId")
      FROM "artifacts" a
      LEFT JOIN "issues" i ON i."id" = a."issueId" AND i."workspaceId" = a."workspaceId"
      WHERE a."uploadId" IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM "uploads" u WHERE u."id" = a."uploadId" AND u."workspaceId" = a."workspaceId"
        )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "upload_references"`);
  }
}
