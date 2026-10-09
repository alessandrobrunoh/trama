import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { CountersService } from '../common/counters.service.js';
import type { RefsService } from '../common/refs.service.js';
import type { WorkstreamEntity } from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import type { WorkstreamBus } from '../events/workstream-bus.js';
import type { LabelsService } from '../workspaces/labels.service.js';
import { WorkstreamsService } from './workstreams.service.js';

function setup() {
  const refs = {
    teams: vi.fn(),
    users: vi.fn(),
    repositories: vi.fn(),
    projectRepositories: vi.fn(),
  };
  const manager = {
    findOneByOrFail: vi.fn(async () => ({ id: 'tm_1', key: 'CORE' })),
    create: (_entity: unknown, x: Partial<WorkstreamEntity>) => x,
    save: async (x: Partial<WorkstreamEntity>) => x,
    query: async () => [{ top: 0 }],
  };
  const service = new WorkstreamsService(
    {} as DataSource,
    refs as unknown as RefsService,
    { nextAbove: async () => 1 } as unknown as CountersService,
    { record: vi.fn() } as unknown as EventsService,
    { touch: vi.fn() } as unknown as WorkstreamBus,
    { assign: async () => [] } as unknown as LabelsService,
    {} as Repository<WorkstreamEntity>,
  );
  const create = (input: { deltaThreadUrl?: string; statusOverride?: 'draft' }) =>
    service.create(
      'ws_1',
      { type: 'user', id: 'usr_1' } as never,
      { title: 'Organize first', ownerTeamId: 'tm_1', ...input },
      { manager: manager as unknown as EntityManager },
    );
  return { create };
}

describe('WorkstreamsService.create Delta thread', () => {
  it('creates a workstream without a thread, not only as a draft', async () => {
    const { create } = setup();
    const row = await create({});
    expect(row.deltaThreadUrl).toBe('');
    expect(row.key).toBe('CORE-1');
    expect((await create({ deltaThreadUrl: '   ' })).deltaThreadUrl).toBe('');
    expect((await create({ statusOverride: 'draft' })).deltaThreadUrl).toBe('');
  });

  it('keeps a valid Delta thread URL', async () => {
    const { create } = setup();
    const row = await create({ deltaThreadUrl: ' https://delta.dev/t/ok ' });
    expect(row.deltaThreadUrl).toBe('https://delta.dev/t/ok');
  });

  it('still rejects a URL that is not a Delta thread link', async () => {
    const { create } = setup();
    await expect(create({ deltaThreadUrl: 'https://example.com/x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('WorkstreamsService.remove', () => {
  it('re-derives the workstreams that waited on the deleted one', async () => {
    const queries: string[] = [];
    const m = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT DISTINCT "toId"')) return [{ toId: 'wk_b' }, { toId: 'wk_a' }];
        return [];
      }),
      delete: vi.fn(),
    };
    const ds = { transaction: async (fn: (x: unknown) => Promise<unknown>) => fn(m) };
    const bus = { touch: vi.fn(), touchMany: vi.fn() };
    const service = new WorkstreamsService(
      ds as unknown as DataSource,
      {} as RefsService,
      {} as CountersService,
      { record: vi.fn(), publish: vi.fn() } as unknown as EventsService,
      bus as unknown as WorkstreamBus,
      {} as LabelsService,
      { findOne: async () => ({ id: 'wk_a', key: 'CORE-1', title: 't' }) } as unknown as Repository<WorkstreamEntity>,
    );
    await service.remove('ws_1', { type: 'user', id: 'usr_1' } as never, 'wk_a');
    // dependents are read before the edges are deleted, then touched (never the deleted one itself)
    const read = queries.findIndex((q) => q.includes('SELECT DISTINCT "toId"'));
    const del = queries.findIndex((q) => q.startsWith('DELETE FROM "dependencies"'));
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(del);
    expect(bus.touchMany).toHaveBeenCalledWith('ws_1', ['wk_b'], 'workstream.deleted');
  });
});

/**
 * In-memory stand-in for the two statements the allocation uses: the `workstreams` max(number) read and the
 * atomic `workspace_counters` upsert. Calls are serialized through a promise chain like the counter row lock.
 */
function fakeDb(existing: { key: string; number: number }[]) {
  const workstreams = [...existing];
  const counters = new Map<string, number>();
  let lock: Promise<unknown> = Promise.resolve();
  const manager = {
    teams: new Map<string, { id: string; key: string }>(),
    findOneByOrFail: async (_e: unknown, where: { id: string }) => manager.teams.get(where.id)!,
    create: (_entity: unknown, x: Partial<WorkstreamEntity>) => x,
    save: async (x: Partial<WorkstreamEntity>) => {
      if (workstreams.some((w) => w.key === x.key)) {
        throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      }
      workstreams.push({ key: x.key!, number: x.number! });
      return x;
    },
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM "workstreams"')) {
        const prefix = String(params[1]).replace('%', '');
        return [{ top: Math.max(0, ...workstreams.filter((w) => w.key.startsWith(prefix)).map((w) => w.number)) }];
      }
      const name = String(params[1]);
      const floor = Number(params[2]);
      const run = lock.then(() => {
        const value = Math.max(counters.get(name) ?? 0, floor) + 1;
        counters.set(name, value);
        return [{ value }];
      });
      lock = run;
      return run;
    },
  };
  const service = new WorkstreamsService(
    {} as DataSource,
    { teams: vi.fn(), users: vi.fn(), repositories: vi.fn(), projectRepositories: vi.fn() } as unknown as RefsService,
    new CountersService(),
    { record: vi.fn() } as unknown as EventsService,
    { touch: vi.fn() } as unknown as WorkstreamBus,
    { assign: async () => [] } as unknown as LabelsService,
    {} as Repository<WorkstreamEntity>,
  );
  const create = (ownerTeamId: string) =>
    service.create(
      'ws_1',
      { type: 'user', id: 'usr_1' } as never,
      { title: 'Work', ownerTeamId },
      { manager: manager as unknown as EntityManager },
    );
  return { manager, workstreams, counters, create };
}

describe('WorkstreamsService.create key allocation', () => {
  it('does not reuse a surviving key when a team with the same key is deleted and recreated', async () => {
    // AUTH-1 was handed to another team and kept its key; the old AUTH team was deleted and a new one created.
    const { manager, create } = fakeDb([{ key: 'AUTH-1', number: 1 }]);
    manager.teams.set('tm_new', { id: 'tm_new', key: 'AUTH' });
    const row = await create('tm_new');
    expect(row.key).toBe('AUTH-2');
    expect(row.number).toBe(2);
  });

  it('keeps counting after the highest workstream of the key was deleted', async () => {
    const { manager, counters, create } = fakeDb([]);
    manager.teams.set('tm_a', { id: 'tm_a', key: 'AUTH' });
    expect((await create('tm_a')).key).toBe('AUTH-1');
    expect((await create('tm_a')).key).toBe('AUTH-2');
    // the team is recreated under a new id: the counter belongs to the key, so the sequence continues
    manager.teams.set('tm_b', { id: 'tm_b', key: 'AUTH' });
    expect((await create('tm_b')).key).toBe('AUTH-3');
    expect(counters.get('wskey:AUTH')).toBe(3);
  });

  it('does not mix up keys that share a prefix', async () => {
    const { manager, create } = fakeDb([{ key: 'AUTHX-9', number: 9 }]);
    manager.teams.set('tm_a', { id: 'tm_a', key: 'AUTH' });
    expect((await create('tm_a')).key).toBe('AUTH-1');
  });

  it('hands out distinct keys to concurrent creates', async () => {
    const { manager, workstreams, create } = fakeDb([{ key: 'AUTH-4', number: 4 }]);
    manager.teams.set('tm_a', { id: 'tm_a', key: 'AUTH' });
    const rows = await Promise.all(Array.from({ length: 8 }, () => create('tm_a')));
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(8);
    expect(keys.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `AUTH-${i + 5}`).sort());
    expect(workstreams).toHaveLength(9);
  });

  it('answers 409, not 500, when the unique key constraint is still hit', async () => {
    const { manager, workstreams, create } = fakeDb([]);
    manager.teams.set('tm_a', { id: 'tm_a', key: 'AUTH' });
    // a row the max() read cannot see (e.g. written by a concurrent uncommitted transaction)
    const hidden = { key: 'AUTH-1', number: 1 };
    const query = manager.query;
    manager.query = async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM "workstreams"')) return [{ top: 0 }];
      return query(sql, params);
    };
    workstreams.push(hidden);
    await expect(create('tm_a')).rejects.toBeInstanceOf(ConflictException);
  });
});
