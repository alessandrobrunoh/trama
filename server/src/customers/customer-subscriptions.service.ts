import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { notFound, uid } from '../common/util.js';
import { CustomerEntity, CustomerSubscriptionEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

/** Who follows which customer. Personal: every call is scoped to the signed-in person and the open workspace. */
@Injectable()
export class CustomerSubscriptionsService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
  ) {}

  /** The caller's subscriptions in this workspace, oldest first. */
  list(workspaceId: string, userId: string): Promise<CustomerSubscriptionEntity[]> {
    return this.ds
      .getRepository(CustomerSubscriptionEntity)
      .find({ where: { workspaceId, userId }, order: { createdAt: 'ASC', id: 'ASC' } });
  }

  /** Follow a customer. Following one already followed returns the existing subscription. */
  async add(workspaceId: string, userId: string, customerId: string): Promise<CustomerSubscriptionEntity> {
    const repo = this.ds.getRepository(CustomerSubscriptionEntity);
    const existing = await repo.findOneBy({ workspaceId, userId, customerId });
    if (existing) return existing;
    if (!(await this.ds.getRepository(CustomerEntity).existsBy({ workspaceId, id: customerId }))) {
      throw notFound('Customer', customerId);
    }
    const row = repo.create({ id: uid('csub'), workspaceId, customerId, userId });
    // A concurrent request may have inserted the same pair; the unique index decides.
    await repo.createQueryBuilder().insert().values(row).orIgnore().execute();
    const saved = await repo.findOneByOrFail({ workspaceId, userId, customerId });
    if (saved.id === row.id) {
      this.events.publish(workspaceId, { type: 'created', entity: 'customer_subscription', id: saved.id }, userId);
    }
    return saved;
  }

  /** Unfollow. Idempotent. */
  async remove(workspaceId: string, userId: string, customerId: string): Promise<void> {
    const repo = this.ds.getRepository(CustomerSubscriptionEntity);
    const existing = await repo.findOneBy({ workspaceId, userId, customerId });
    if (!existing) return;
    await repo.delete({ id: existing.id });
    this.events.publish(workspaceId, { type: 'deleted', entity: 'customer_subscription', id: existing.id }, userId);
  }
}
