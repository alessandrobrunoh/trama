import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { CustomerEntity, CustomerSubscriptionEntity } from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import { CustomerSubscriptionsService } from './customer-subscriptions.service.js';

type Where = Record<string, unknown>;

function setup() {
  const subs: CustomerSubscriptionEntity[] = [];
  const customers = [{ id: 'cus_1', workspaceId: 'ws_1' }, { id: 'cus_other', workspaceId: 'ws_2' }];
  const matches = (r: object, where: Where) => Object.entries(where).every(([k, v]) => (r as Where)[k] === v);
  const subRepo = {
    find: async ({ where }: { where: Where }) => subs.filter((s) => matches(s, where)),
    findOneBy: async (where: Where) => subs.find((s) => matches(s, where)) ?? null,
    findOneByOrFail: async (where: Where) => subs.find((s) => matches(s, where))!,
    create: (x: Partial<CustomerSubscriptionEntity>) => Object.assign(new CustomerSubscriptionEntity(), x),
    delete: async ({ id }: { id: string }) => {
      const i = subs.findIndex((s) => s.id === id);
      if (i >= 0) subs.splice(i, 1);
    },
    // insert ... on conflict do nothing, as the service relies on the unique index
    createQueryBuilder: () => ({
      insert: () => ({
        values: (row: CustomerSubscriptionEntity) => ({
          orIgnore: () => ({
            execute: async () => {
              if (!subs.some((s) => s.customerId === row.customerId && s.userId === row.userId)) subs.push(row);
            },
          }),
        }),
      }),
    }),
  };
  const customerRepo = { existsBy: async (where: Where) => customers.some((c) => matches(c, where)) };
  const ds = {
    getRepository: (target: unknown) => (target === CustomerSubscriptionEntity ? subRepo : target === CustomerEntity ? customerRepo : undefined),
  } as unknown as DataSource;
  const publish = vi.fn();
  const service = new CustomerSubscriptionsService(ds, { publish } as unknown as EventsService);
  return { service, subs, publish };
}

describe('CustomerSubscriptionsService', () => {
  it('follows a customer once, however often it is asked', async () => {
    const { service, subs, publish } = setup();
    const first = await service.add('ws_1', 'usr_1', 'cus_1');
    const again = await service.add('ws_1', 'usr_1', 'cus_1');
    expect(again.id).toBe(first.id);
    expect(subs).toHaveLength(1);
    expect(first.id).toMatch(/^csub_/);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('refuses a customer of another workspace', async () => {
    const { service, subs } = setup();
    await expect(service.add('ws_1', 'usr_1', 'cus_other')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.add('ws_1', 'usr_1', 'cus_nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(subs).toHaveLength(0);
  });

  it('lists only the caller\'s own subscriptions in the workspace', async () => {
    const { service } = setup();
    await service.add('ws_1', 'usr_1', 'cus_1');
    await service.add('ws_1', 'usr_2', 'cus_1');
    expect((await service.list('ws_1', 'usr_1')).map((s) => s.userId)).toEqual(['usr_1']);
    expect(await service.list('ws_2', 'usr_1')).toEqual([]);
  });

  it('unfollows idempotently and leaves other people alone', async () => {
    const { service, subs } = setup();
    await service.add('ws_1', 'usr_1', 'cus_1');
    await service.add('ws_1', 'usr_2', 'cus_1');
    await service.remove('ws_1', 'usr_1', 'cus_1');
    await service.remove('ws_1', 'usr_1', 'cus_1');
    expect(subs.map((s) => s.userId)).toEqual(['usr_2']);
  });
});
