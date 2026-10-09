import { BadRequestException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { CountersService } from '../common/counters.service.js';
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
  };
  const service = new WorkstreamsService(
    {} as DataSource,
    refs as unknown as RefsService,
    { next: async () => 1 } as unknown as CountersService,
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
