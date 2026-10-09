import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer subscriptions: a person follows a customer and is notified about new, important and delivered requests.
 * One row per (customer, person). Deleting the workspace, the customer or the person removes the row.
 */
export class CustomerSubscriptions1793400000000 implements MigrationInterface {
  name = 'CustomerSubscriptions1793400000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `CREATE TABLE "customer_subscriptions" (
        "id" character varying NOT NULL,
        "workspaceId" character varying NOT NULL,
        "customerId" character varying NOT NULL,
        "userId" character varying NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_customer_subscriptions" PRIMARY KEY ("id")
      )`,
    );
    await q.query(`CREATE UNIQUE INDEX "UQ_customer_subscriptions_pair" ON "customer_subscriptions" ("customerId", "userId")`);
    await q.query(`CREATE INDEX "IDX_customer_subscriptions_user" ON "customer_subscriptions" ("workspaceId", "userId")`);
    await q.query(
      `ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "FK_customer_subscriptions_workspace" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "FK_customer_subscriptions_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await q.query(
      `ALTER TABLE "customer_subscriptions" ADD CONSTRAINT "FK_customer_subscriptions_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE "customer_subscriptions"`);
  }
}
