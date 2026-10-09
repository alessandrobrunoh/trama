import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import { WorkspaceEntity } from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import type { WorkspaceLabel } from '../contracts/domain.js';
import { LabelsService } from './labels.service.js';

const custom = (id: string, name: string, extra: Partial<WorkspaceLabel> = {}): WorkspaceLabel => ({ id, name, color: '#2563eb', template: false, ...extra });

function setup(labels: WorkspaceLabel[] = []) {
  const ws = Object.assign(new WorkspaceEntity(), { id: 'ws_1', settings: { labels } });
  const queries: { sql: string; params: unknown[] }[] = [];
  const manager = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.includes('FROM "saved_views"')) {
        return [
          { id: 'sv_1', filters: [{ field: 'labels', op: 'in', value: ['lb_a', 'lb_b'] }] },
          { id: 'sv_2', filters: [{ field: 'status', op: 'is', value: 'todo' }] },
        ];
      }
      return [];
    },
    save: async (_target: unknown, row: unknown) => row,
  };
  const ds = {
    getRepository: () => ({ save: async (row: unknown) => row, findOneBy: async () => ws }),
    transaction: async <R>(cb: (m: typeof manager) => Promise<R>) => cb(manager),
  } as unknown as DataSource;
  const events = { publish: vi.fn() };
  const service = new LabelsService(ds, events as unknown as EventsService);
  const ctx = { workspace: ws, role: 'admin' } as unknown as WorkspaceContext;
  return { service, ctx, ws, queries, events };
}

const catalogOf = (ws: WorkspaceEntity) => (ws.settings as { labels: WorkspaceLabel[] }).labels;

describe('workspace label management', () => {
  it('archives and restores a custom label, never a template', async () => {
    const { service, ctx, ws } = setup([custom('lb_a', 'Auth')]);
    await service.update(ctx, 'lb_a', { archived: true });
    expect(catalogOf(ws).find((l) => l.id === 'lb_a')?.archived).toBe(true);
    await service.update(ctx, 'lb_a', { color: '#16a34a' });
    expect(catalogOf(ws).find((l) => l.id === 'lb_a')).toMatchObject({ archived: true, color: '#16a34a' });
    await service.update(ctx, 'lb_a', { archived: false });
    expect(catalogOf(ws).find((l) => l.id === 'lb_a')).not.toHaveProperty('archived');
    await expect(service.update(ctx, 'lb_bug', { archived: true })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('merges one label into another: records and saved views follow, the source disappears', async () => {
    const { service, ctx, ws, queries, events } = setup([custom('lb_a', 'Auth'), custom('lb_b', 'Authentication')]);
    await service.merge(ctx, 'lb_a', 'lb_b');
    expect(catalogOf(ws).map((l) => l.id)).not.toContain('lb_a');
    expect(catalogOf(ws).map((l) => l.id)).toContain('lb_b');
    const updates = queries.filter((q) => q.sql.startsWith('UPDATE') && q.sql.includes('"labels"'));
    expect(updates.map((q) => /UPDATE "(\w+)"/.exec(q.sql)?.[1])).toEqual(['workstreams', 'issues', 'projects', 'repositories']);
    for (const q of updates) expect(q.params).toEqual(['ws_1', 'lb_a', 'lb_b']);
    // Only the view that filters on the label is rewritten, and it now points at the target once.
    const viewWrites = queries.filter((q) => q.sql.includes('UPDATE "saved_views"'));
    expect(viewWrites).toHaveLength(1);
    expect(viewWrites[0]!.params).toEqual(['sv_1', JSON.stringify([{ field: 'labels', op: 'in', value: ['lb_b'] }])]);
    expect(events.publish).toHaveBeenCalledTimes(1);
  });

  it('refuses to merge a template away, into itself, into an unknown or an archived label', async () => {
    const { service, ctx } = setup([custom('lb_a', 'Auth'), custom('lb_old', 'Old', { archived: true })]);
    await expect(service.merge(ctx, 'lb_bug', 'lb_a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.merge(ctx, 'lb_a', 'lb_a')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.merge(ctx, 'lb_a', 'lb_missing')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.merge(ctx, 'lb_a', 'lb_old')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.merge(ctx, 'lb_missing', 'lb_a')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('can merge an archived label into an active one', async () => {
    const { service, ctx, ws } = setup([custom('lb_a', 'Auth'), custom('lb_old', 'Old', { archived: true })]);
    await service.merge(ctx, 'lb_old', 'lb_a');
    expect(catalogOf(ws).map((l) => l.id)).not.toContain('lb_old');
  });

  it('deleting a label strips it everywhere without a replacement', async () => {
    const { service, ctx, ws, queries } = setup([custom('lb_a', 'Auth')]);
    await service.remove(ctx, 'lb_a');
    expect(catalogOf(ws).map((l) => l.id)).not.toContain('lb_a');
    const updates = queries.filter((q) => q.sql.startsWith('UPDATE') && q.sql.includes('"labels"'));
    for (const q of updates) expect(q.params).toEqual(['ws_1', 'lb_a', null]);
    await expect(service.remove(ctx, 'lb_bug')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still refuses duplicate names, ignoring case', async () => {
    const { service, ctx } = setup([custom('lb_a', 'Auth')]);
    await expect(service.create(ctx, { name: 'auth' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create(ctx, { name: 'bug' })).rejects.toBeInstanceOf(ConflictException);
  });
});
