import { BadRequestException, ConflictException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import { CustomerEntity, WorkspaceEntity } from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import { CustomerTiersService } from './customer-tiers.service.js';

function setup(tiers: { id: string; name: string; color: string }[] = []) {
  const ws = Object.assign(new WorkspaceEntity(), { id: 'ws_1', settings: { customerTiers: tiers } });
  const customerUpdates: { where: unknown; patch: unknown }[] = [];
  const manager = {
    getRepository: (target: unknown) =>
      target === CustomerEntity ? { update: async (where: unknown, patch: unknown) => void customerUpdates.push({ where, patch }) } : undefined,
    save: async (_target: unknown, row: unknown) => row,
  };
  const ds = {
    getRepository: () => ({ save: async (row: unknown) => row }),
    transaction: async <R>(cb: (m: typeof manager) => Promise<R>) => cb(manager),
  } as unknown as DataSource;
  const events = { publish: vi.fn(), record: vi.fn() };
  const service = new CustomerTiersService(ds, events as unknown as EventsService);
  const ctx = { workspace: ws, role: 'admin' } as unknown as WorkspaceContext;
  return { service, ctx, ws, events, customerUpdates };
}

const tiersOf = (ws: WorkspaceEntity) => (ws.settings as { customerTiers: { id: string; name: string; color: string }[] }).customerTiers;

describe('customer tiers', () => {
  it('adds tiers in order, with a default colour and a stable id', async () => {
    const { service, ctx, ws, events } = setup();
    await service.create(ctx, { name: ' Enterprise ' });
    await service.create(ctx, { name: 'SMB', color: '#16A34A' });
    const tiers = tiersOf(ws);
    expect(tiers.map((t) => t.name)).toEqual(['Enterprise', 'SMB']);
    expect(tiers[0]!.id).toMatch(/^ct_/);
    expect(tiers[0]!.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(tiers[1]!.color).toBe('#16a34a');
    expect(events.publish).toHaveBeenCalledTimes(2);
  });

  it('rejects empty, over-long and duplicate names and bad colours', async () => {
    const { service, ctx } = setup([{ id: 'ct_1', name: 'Gold', color: '#eab308' }]);
    await expect(service.create(ctx, { name: '  ' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(ctx, { name: 'x'.repeat(41) })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(ctx, { name: 'gold' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.create(ctx, { name: 'Silver', color: 'red' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('caps the number of tiers', async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({ id: `ct_${i}`, name: `T${i}`, color: '#2563eb' }));
    const { service, ctx } = setup(full);
    await expect(service.create(ctx, { name: 'One more' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renames and recolors a tier, and refuses a clash or an unknown id', async () => {
    const { service, ctx, ws } = setup([
      { id: 'ct_1', name: 'Gold', color: '#eab308' },
      { id: 'ct_2', name: 'Silver', color: '#64748b' },
    ]);
    await service.update(ctx, 'ct_1', { name: 'Platinum', color: '#7C3AED' });
    expect(tiersOf(ws)[0]).toEqual({ id: 'ct_1', name: 'Platinum', color: '#7c3aed' });
    await expect(service.update(ctx, 'ct_1', { name: 'silver' })).rejects.toBeInstanceOf(ConflictException);
    await expect(service.update(ctx, 'ct_nope', { name: 'X' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removing a tier clears it from the customers that had it', async () => {
    const { service, ctx, ws, customerUpdates } = setup([
      { id: 'ct_1', name: 'Gold', color: '#eab308' },
      { id: 'ct_2', name: 'Silver', color: '#64748b' },
    ]);
    await service.remove(ctx, 'ct_1');
    expect(tiersOf(ws).map((t) => t.id)).toEqual(['ct_2']);
    expect(customerUpdates).toEqual([
      { where: { workspaceId: 'ws_1', tierId: 'ct_1' }, patch: expect.objectContaining({ tierId: null }) },
    ]);
    await expect(service.remove(ctx, 'ct_1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
