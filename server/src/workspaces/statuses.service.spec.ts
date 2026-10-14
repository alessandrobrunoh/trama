import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import {
  defaultStatusCatalog,
  resolveStatusCatalog,
  resolveStatusEntry,
  resolveWorkspaceSettings,
  type StatusEntry,
} from '../contracts/domain.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import { StatusesService } from './statuses.service.js';

function setup(
  statuses?: ReturnType<typeof defaultStatusCatalog>,
  counts: Record<string, number> = {},
) {
  const ws = Object.assign(new WorkspaceEntity(), {
    id: 'ws_1',
    settings: statuses ? { statuses } : {},
  });
  const queries: { sql: string; params: unknown[] }[] = [];
  const ds = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      const values = (params[1] as string[] | undefined) ?? [];
      const n = values.reduce((sum, value) => sum + (counts[value] ?? 0), 0);
      return [{ n }];
    },
    getRepository: () => ({ save: async (row: unknown) => row }),
  } as unknown as DataSource;
  const events = { publish: vi.fn() };
  const service = new StatusesService(ds, events as unknown as EventsService);
  const ctx = { workspace: ws, role: 'admin' } as unknown as WorkspaceContext;
  return { service, ctx, ws, queries, events };
}

const issueCatalog = (ws: WorkspaceEntity) =>
  resolveStatusCatalog(
    (ws.settings as { statuses?: ReturnType<typeof defaultStatusCatalog> })
      .statuses,
  ).issue;

describe('status catalog', () => {
  it("seeds a new workspace with today's statuses, one per type", () => {
    const settings = resolveWorkspaceSettings({});
    const seeded = defaultStatusCatalog();
    expect(settings.statuses.issue.map((entry) => entry.id)).toEqual(
      seeded.issue.map((entry) => entry.type),
    );
    for (const key of [
      'issue',
      'project',
      'decision',
      'projectHealth',
    ] as const) {
      const types = settings.statuses[key].map((entry) => entry.type);
      expect(new Set(types).size).toBe(types.length);
      expect(
        settings.statuses[key].every(
          (entry) => entry.icon && entry.color.startsWith('#'),
        ),
      ).toBe(true);
    }
  });

  it('adds a status of a chosen type, icon and color', async () => {
    const { service, ctx, ws, events } = setup();
    await service.create(ctx, 'issue', {
      type: 'in_progress',
      icon: 'bug',
      color: '#3F6BD6',
    });
    const added = issueCatalog(ws).find((entry) => entry.id !== entry.type);
    expect(added).toMatchObject({
      name: 'In Progress 2',
      icon: 'bug',
      color: '#3f6bd6',
      type: 'in_progress',
    });
    expect(added?.id.startsWith('st_')).toBe(true);
    expect(events.publish).toHaveBeenCalledTimes(1);
  });

  it('rejects retired Workstream status subjects', async () => {
    const { service, ctx } = setup();
    await expect(
      service.create(ctx, 'workstream', {
        type: 'working',
        icon: 'circle',
        color: '#334455',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects removing a status that is still in use', async () => {
    const { service, ctx, ws } = setup(undefined, { todo: 2 });
    await service.create(ctx, 'issue', {
      name: 'Ready',
      type: 'todo',
      icon: 'circle',
      color: '#5f6a7a',
    });
    await expect(service.remove(ctx, 'issue', 'todo')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(issueCatalog(ws).some((entry) => entry.id === 'todo')).toBe(true);
  });

  it('removes an unused extra status, but not the last of its type', async () => {
    const { service, ctx, ws } = setup();
    await service.create(ctx, 'issue', {
      name: 'Ready',
      type: 'todo',
      icon: 'circle',
      color: '#5f6a7a',
    });
    const extra = issueCatalog(ws).find(
      (entry) => entry.name === 'Ready',
    ) as StatusEntry;
    await service.remove(ctx, 'issue', extra.id);
    expect(issueCatalog(ws).some((entry) => entry.id === extra.id)).toBe(false);
    await expect(service.remove(ctx, 'issue', 'todo')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('resolves an old enum value to the seeded status of that type', () => {
    const rewritten = defaultStatusCatalog().issue.map((entry) => ({
      ...entry,
      id: `st_${entry.type}`,
    }));
    expect(resolveStatusEntry(rewritten, 'todo')).toMatchObject({
      id: 'st_todo',
      type: 'todo',
    });
    expect(resolveStatusEntry(rewritten, 'st_done')).toMatchObject({
      id: 'st_done',
      type: 'done',
    });
    const withExtra = [
      ...rewritten,
      {
        id: 'st_ready',
        name: 'Ready',
        icon: 'circle',
        color: '#5f6a7a',
        type: 'todo' as const,
      },
    ];
    expect(resolveStatusEntry(withExtra, 'todo')?.id).toBe('st_todo');
  });
});
