import { describe, expect, it, vi } from 'vitest';
import { NotificationsService } from './notifications.service.js';
import {
  CustomerEntity,
  CustomerRequestEntity,
  CustomerSubscriptionEntity,
  IssueEntity,
  MembershipEntity,
  NotificationEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';

function serviceWith(ds: object): NotificationsService {
  return new NotificationsService(
    ds as never,
    {} as never,
    {} as never,
    {
      enabled: false,
    } as never,
  );
}

describe('notification fanout batching', () => {
  it('batch-loads users and memberships once for unique recipients', async () => {
    const userFind = vi.fn().mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    const membershipFind = vi
      .fn()
      .mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
    const service = serviceWith({
      getRepository: (entity: unknown) => {
        if (entity === WorkspaceEntity)
          return { findOneBy: vi.fn().mockResolvedValue({ id: 'w1' }) };
        if (entity === UserEntity) return { find: userFind };
        if (entity === MembershipEntity) return { find: membershipFind };
        throw new Error('Unexpected repository');
      },
    });
    const context = {
      event: {
        type: 'issue.created',
        actor: { type: 'user', id: 'actor' },
        subject: { type: 'issue', id: 'i1' },
        data: { assigneeId: 'u1' },
        workspaceId: 'w1',
      },
      actorName: 'Actor',
      issue: { id: 'i1', key: 'ABC-1', title: 'Issue' },
    };
    (service as unknown as { context: () => Promise<unknown> }).context = vi
      .fn()
      .mockResolvedValue(context);
    (service as unknown as { deliver: ReturnType<typeof vi.fn> }).deliver = vi
      .fn()
      .mockResolvedValue(undefined);
    await (
      service as unknown as { handle: (event: object) => Promise<void> }
    ).handle({
      workspaceId: 'w1',
      actor: context.event.actor,
    });
    expect(userFind).toHaveBeenCalledOnce();
    expect(membershipFind).toHaveBeenCalledOnce();
  });

  it('never runs more than eight deliveries concurrently', async () => {
    const service = serviceWith({
      getRepository: (entity: unknown) =>
        entity === WorkspaceEntity
          ? { findOneBy: vi.fn().mockResolvedValue({ id: 'w1' }) }
          : entity === UserEntity
            ? {
                find: vi
                  .fn()
                  .mockResolvedValue(
                    Array.from({ length: 10 }, (_, i) => ({ id: `u${i}` })),
                  ),
              }
            : entity === MembershipEntity
              ? {
                  find: vi.fn().mockResolvedValue(
                    Array.from({ length: 10 }, (_, i) => ({
                      userId: `u${i}`,
                    })),
                  ),
                }
              : {},
    });
    const context = {
      event: {
        type: 'customer_request.linked',
        actor: { type: 'user', id: 'actor' },
        subject: { type: 'customer_request', id: 'r1' },
        data: {},
        workspaceId: 'w1',
      },
      actorName: 'Actor',
      customer: {
        id: 'c1',
        name: 'Customer',
        subscriberIds: Array.from({ length: 10 }, (_, i) => `u${i}`),
      },
    };
    (service as unknown as { context: () => Promise<unknown> }).context = vi
      .fn()
      .mockResolvedValue(context);
    let active = 0;
    let maximum = 0;
    (service as unknown as { deliver: ReturnType<typeof vi.fn> }).deliver = vi
      .fn()
      .mockImplementation(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
      });
    await (
      service as unknown as { handle: (event: object) => Promise<void> }
    ).handle({
      workspaceId: 'w1',
      actor: context.event.actor,
    });
    expect(maximum).toBe(8);
  });

  it('groups subscriptions by customer in one pass', async () => {
    const service = serviceWith({
      getRepository: (entity: unknown) => {
        if (entity === CustomerSubscriptionEntity)
          return {
            find: vi.fn().mockResolvedValue([
              { customerId: 'c1', userId: 'u1' },
              { customerId: 'c2', userId: 'u2' },
              { customerId: 'c1', userId: 'u3' },
            ]),
          };
        if (entity === CustomerRequestEntity)
          return {
            find: vi.fn().mockResolvedValue([
              { customerId: 'c1', createdBy: { type: 'agent' } },
              { customerId: 'c2', createdBy: { type: 'agent' } },
            ]),
          };
        if (entity === IssueEntity)
          return {
            findOneBy: vi
              .fn()
              .mockResolvedValue({ key: 'ABC-1', title: 'Issue' }),
          };
        if (entity === CustomerEntity)
          return {
            find: vi.fn().mockResolvedValue([
              { id: 'c1', name: 'One' },
              { id: 'c2', name: 'Two' },
            ]),
          };
        throw new Error('Unexpected repository');
      },
    });
    const result = await (
      service as unknown as {
        delivery: (
          workspaceId: string,
          type: 'issue',
          id: string,
        ) => Promise<{
          customers: { id: string; subscriberIds: string[] }[];
        }>;
      }
    ).delivery('w1', 'issue', 'i1');
    expect(result?.customers).toEqual([
      { id: 'c1', name: 'One', subscriberIds: ['u1', 'u3'] },
      { id: 'c2', name: 'Two', subscriberIds: ['u2'] },
    ]);
  });

  it('uses a transaction-scoped lock and preserves the dedupe key and time window', async () => {
    const transaction = vi.fn(
      async (work: (manager: object) => Promise<unknown>) =>
        work({
          query: vi.fn(),
          getRepository: () => ({
            existsBy: vi.fn().mockResolvedValue(true),
            create: vi.fn(),
            save: vi.fn(),
          }),
        }),
    );
    const ds = {
      transaction,
      getRepository: (entity: unknown) =>
        entity === NotificationEntity ? { delete: vi.fn() } : {},
    };
    const events = { publish: vi.fn() };
    const service = new NotificationsService(
      ds as never,
      events as never,
      { enabled: false } as never,
      { enabled: false } as never,
    );
    const workspace = { id: 'w1', slug: 'acme' };
    const user = {
      id: 'u1',
      email: 'x@example.test',
      notificationSettings: {},
    };
    const draft = {
      userId: 'u1',
      kind: 'assigned',
      title: 'Assigned',
      subject: { type: 'issue', id: 'i1' },
      link: 'issues/ABC-1',
    };
    await (
      service as unknown as {
        deliver: (
          w: unknown,
          a: unknown,
          d: unknown,
          l: unknown,
        ) => Promise<void>;
      }
    ).deliver(workspace, { type: 'user', id: 'actor' }, draft, {
      user,
      isMember: true,
    });
    expect(transaction).toHaveBeenCalledOnce();
    const query = vi.fn();
    transaction.mockImplementationOnce(async (work) =>
      work({
        query,
        getRepository: () => ({
          existsBy: vi.fn().mockResolvedValue(true),
          create: vi.fn(),
          save: vi.fn(),
        }),
      }),
    );
    await (
      service as unknown as {
        deliver: (
          w: unknown,
          a: unknown,
          d: unknown,
          l: unknown,
        ) => Promise<void>;
      }
    ).deliver(workspace, { type: 'user', id: 'actor' }, draft, {
      user,
      isMember: true,
    });
    expect(query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['["w1","u1","assigned","Assigned"]'],
    );
    const repository = {
      existsBy: vi.fn().mockResolvedValue(true),
      create: vi.fn(),
      save: vi.fn(),
    };
    transaction.mockImplementationOnce(async (work) =>
      work({ query, getRepository: () => repository }),
    );
    const firstQuery = query.mock.calls.length;
    await (
      service as unknown as {
        deliver: (
          w: unknown,
          a: unknown,
          d: unknown,
          l: unknown,
        ) => Promise<void>;
      }
    ).deliver(workspace, { type: 'user', id: 'actor' }, draft, {
      user,
      isMember: true,
    });
    expect(repository.existsBy).toHaveBeenCalledWith({
      workspaceId: 'w1',
      userId: 'u1',
      kind: 'assigned',
      title: 'Assigned',
      createdAt: expect.anything(),
    });
    expect(repository.save).not.toHaveBeenCalled();
    expect(query.mock.calls.length).toBe(firstQuery + 1);
  });

  it('serializes competing duplicate deliveries through the database transaction boundary', async () => {
    let inserted = false;
    const query = vi.fn();
    const existsBy = vi.fn(async () => inserted);
    const save = vi.fn(async (row: object) => {
      inserted = true;
      return row;
    });
    const repo = {
      existsBy,
      create: (row: object) => row,
      save,
    };
    let transactionQueue = Promise.resolve();
    const ds = {
      transaction: (work: (manager: object) => Promise<unknown>) => {
        const next = transactionQueue.then(() =>
          work({ query, getRepository: () => repo }),
        );
        transactionQueue = next.then(() => undefined);
        return next;
      },
      getRepository: () => ({ delete: vi.fn() }),
    };
    const service = new NotificationsService(
      ds as never,
      { publish: vi.fn() } as never,
      { enabled: false } as never,
      { enabled: false } as never,
    );
    const workspace = { id: 'w1', slug: 'acme' };
    const user = {
      id: 'u1',
      email: 'x@example.test',
      notificationSettings: {},
    };
    const draft = {
      userId: 'u1',
      kind: 'assigned',
      title: 'Assigned',
      subject: { type: 'issue', id: 'i1' },
      link: 'issues/ABC-1',
    };
    const deliver = (
      service as unknown as {
        deliver: (
          w: unknown,
          a: unknown,
          d: unknown,
          l: unknown,
        ) => Promise<void>;
      }
    ).deliver.bind(service);
    const first = deliver(workspace, { type: 'user', id: 'actor' }, draft, {
      user,
      isMember: true,
    });
    const second = deliver(workspace, { type: 'user', id: 'actor' }, draft, {
      user,
      isMember: true,
    });
    await Promise.all([first, second]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(existsBy).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledOnce();
  });
});
