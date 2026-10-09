import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Documents: markdown pages of a workspace, their revision history, and `artifacts.documentId` so a
 * document can be attached (as a `document` artifact) to projects, workstreams and issues.
 * Search is a stored `tsvector` over title (weight A) and body (weight B) with the `simple` configuration
 * (no stemming: workspaces write in several languages).
 */
export class Documents1793711000000 implements MigrationInterface {
  name = 'Documents1793711000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "documents" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "title" character varying NOT NULL,
        "body" text NOT NULL DEFAULT '',
        "icon" character varying,
        "version" integer NOT NULL DEFAULT 1,
        "author" jsonb NOT NULL,
        "lastEditor" jsonb NOT NULL,
        "archivedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "searchVector" tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
          setweight(to_tsvector('simple', coalesce("body", '')), 'B')
        ) STORED,
        CONSTRAINT "PK_documents" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE INDEX "IDX_documents_workspace_updated" ON "documents" ("workspaceId", "updatedAt")`);
    await q.query(`CREATE INDEX "IDX_documents_search" ON "documents" USING GIN ("searchVector")`);
    await q.query(
      `ALTER TABLE "documents" ADD CONSTRAINT "FK_documents_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `CREATE TABLE "document_revisions" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "documentId" character varying NOT NULL,
        "version" integer NOT NULL,
        "title" character varying NOT NULL,
        "body" text NOT NULL,
        "editor" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_revisions" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE UNIQUE INDEX "UQ_document_revisions_version" ON "document_revisions" ("documentId", "version")`);
    await q.query(
      `ALTER TABLE "document_revisions" ADD CONSTRAINT "FK_document_revisions_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "document_revisions" ADD CONSTRAINT "FK_document_revisions_document" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(`ALTER TABLE "artifacts" ADD "documentId" character varying`);
    await q.query(`CREATE INDEX "IDX_artifacts_document" ON "artifacts" ("documentId")`);
    await q.query(
      `ALTER TABLE "artifacts" ADD CONSTRAINT "FK_artifacts_document" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "artifacts" DROP CONSTRAINT "FK_artifacts_document"`);
    await q.query(`DROP INDEX "IDX_artifacts_document"`);
    await q.query(`ALTER TABLE "artifacts" DROP COLUMN "documentId"`);
    await q.query(`DROP TABLE "document_revisions"`);
    await q.query(`DROP TABLE "documents"`);
  }
}
