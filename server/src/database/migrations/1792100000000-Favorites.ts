import { MigrationInterface, QueryRunner } from 'typeorm';

/** Per-user favorites: one row per pinned issue, workstream, decision, team, repository or view. */
export class Favorites1792100000000 implements MigrationInterface {
  name = 'Favorites1792100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "favorites" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "type" character varying NOT NULL,
        "subjectId" character varying NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_favorites" PRIMARY KEY ("id")
      )`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_favorites_subject" ON "favorites" ("userId", "workspaceId", "type", "subjectId")`,
    );
    await q.query(
      `ALTER TABLE "favorites" ADD CONSTRAINT "FK_favorites_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "favorites" ADD CONSTRAINT "FK_favorites_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "favorites"`);
  }
}
