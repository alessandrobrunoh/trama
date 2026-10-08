import { MigrationInterface, QueryRunner } from 'typeorm';

/** In-app notifications per person, and each person's notification settings. */
export class Notifications1792200000000 implements MigrationInterface {
  name = 'Notifications1792200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "users" ADD "notificationSettings" jsonb NOT NULL DEFAULT '{}'`);
    await q.query(
      `CREATE TABLE "notifications" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "kind" character varying NOT NULL,
        "title" character varying NOT NULL,
        "body" text,
        "actor" jsonb NOT NULL,
        "subject" jsonb NOT NULL,
        "link" character varying NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "readAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id")
      )`,
    );
    await q.query(
      `CREATE INDEX "IDX_notifications_user" ON "notifications" ("userId", "workspaceId", "createdAt")`,
    );
    await q.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_notifications_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "notifications" ADD CONSTRAINT "FK_notifications_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "notifications"`);
    await q.query(`ALTER TABLE "users" DROP COLUMN "notificationSettings"`);
  }
}
