import { MigrationInterface, QueryRunner } from 'typeorm';

/** Uploaded images and files. Bytes stay in Postgres; `artifacts.uploadId` points at one from an artifact. */
export class Uploads1793730000000 implements MigrationInterface {
  name = 'Uploads1793730000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "uploads" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "filename" character varying NOT NULL,
        "contentType" character varying NOT NULL,
        "byteSize" integer NOT NULL,
        "bytes" bytea NOT NULL,
        "referenced" boolean NOT NULL DEFAULT false,
        "createdBy" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_uploads" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_uploads_size" CHECK ("byteSize" > 0 AND "byteSize" <= 8388608)
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_uploads_workspace" ON "uploads" ("workspaceId", "createdAt")`,
    );
    await q.query(
      `ALTER TABLE "uploads" ADD CONSTRAINT "FK_uploads_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(`ALTER TABLE "artifacts" ADD "uploadId" character varying`);
    await q.query(
      `CREATE INDEX "IDX_artifacts_upload" ON "artifacts" ("uploadId")`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX "IDX_artifacts_upload"`);
    await q.query(`ALTER TABLE "artifacts" DROP COLUMN "uploadId"`);
    await q.query(`DROP TABLE "uploads"`);
  }
}
