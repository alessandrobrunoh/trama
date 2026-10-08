import { MigrationInterface, QueryRunner } from 'typeorm';

/** Web Push subscriptions: one row per browser/device a person turned push notifications on for. */
export class PushSubscriptions1792700000000 implements MigrationInterface {
  name = 'PushSubscriptions1792700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "push_subscriptions" (
        "id" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "endpoint" text NOT NULL,
        "p256dh" character varying NOT NULL,
        "auth" character varying NOT NULL,
        "userAgent" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_push_subscriptions" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE UNIQUE INDEX "UQ_push_subscriptions_endpoint" ON "push_subscriptions" ("endpoint")`);
    await q.query(`CREATE INDEX "IDX_push_subscriptions_user" ON "push_subscriptions" ("userId")`);
    await q.query(
      `ALTER TABLE "push_subscriptions" ADD CONSTRAINT "FK_push_subscriptions_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "push_subscriptions"`);
  }
}
