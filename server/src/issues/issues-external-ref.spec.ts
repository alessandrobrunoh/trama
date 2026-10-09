import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { ExternalRef } from '../contracts/domain.js';
import { IssuesService } from './issues.service.js';

const actor = { type: 'user' as const, id: 'usr_me' };
const ref: ExternalRef = { provider: 'github', id: 'acme/api#12', url: 'https://github.com/acme/api/issues/12', key: '#12', state: 'Open', stateType: 'open', origin: 'link' };

function makeService(options: { clash?: boolean } = {}) {
  const row = { id: 'iss_1', key: 'BUG-1', externalRef: null as ExternalRef | null, externalUrl: null as string | null, updatedAt: new Date(0) };
  const save = vi.fn(async (r: unknown) => {
    if (options.clash) throw Object.assign(new Error('duplicate key'), { code: '23505' });
    return r;
  });
  const record = vi.fn(async () => undefined);
  const publish = vi.fn();
  const other = { key: 'FEAT-9' };
  const qb = { where: () => qb, getOne: async () => other };
  const ds = { getRepository: () => ({ createQueryBuilder: () => qb }) };
  const service = new IssuesService(
    ds as never,
    {} as never,
    {} as never,
    { record, publish } as never,
    {} as never,
    {} as never,
    {} as never,
    { findOneBy: async () => row, save } as never,
  );
  return { service, row, record, publish };
}

describe('IssuesService external reference', () => {
  it('stores the pointer, fills the plain link, and records what changed', async () => {
    const { service, row, record } = makeService();
    const res = await service.setExternalRef('ws_1', actor, 'iss_1', ref);
    expect(res.externalRef).toEqual(ref);
    expect(row.externalUrl).toBe(ref.url);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'issue.updated', data: expect.objectContaining({ fields: ['externalRef'], external: { provider: 'github', key: '#12', origin: 'link' } }) }),
    );
  });

  it('keeps an external URL a person typed, and removes only the one the link set', async () => {
    const typed = makeService();
    typed.row.externalUrl = 'https://example.com/mine';
    await typed.service.setExternalRef('ws_1', actor, 'iss_1', ref);
    expect(typed.row.externalUrl).toBe('https://example.com/mine');
    await typed.service.setExternalRef('ws_1', actor, 'iss_1', null);
    expect(typed.row.externalUrl).toBe('https://example.com/mine');

    const linked = makeService();
    await linked.service.setExternalRef('ws_1', actor, 'iss_1', ref);
    await linked.service.setExternalRef('ws_1', actor, 'iss_1', null);
    expect(linked.row.externalRef).toBeNull();
    expect(linked.row.externalUrl).toBeNull();
  });

  it('answers 409 naming the issue that already carries the external issue', async () => {
    const { service } = makeService({ clash: true });
    const err = await service.setExternalRef('ws_1', actor, 'iss_1', ref).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toContain('FEAT-9');
  });

  it('refreshes the mirrored status quietly (no domain event) and refuses an unlinked issue', async () => {
    const { service, row, record, publish } = makeService();
    await expect(service.refreshExternalRef('ws_1', 'iss_1', { state: 'Closed', stateType: 'done' } as never)).rejects.toThrow('not linked');
    row.externalRef = ref;
    const res = await service.refreshExternalRef('ws_1', 'iss_1', { state: 'Closed', stateType: 'done', syncedAt: '2026-10-09T00:00:00.000Z' } as never);
    expect(res.externalRef).toMatchObject({ id: ref.id, state: 'Closed', stateType: 'done', origin: 'link' });
    expect(record).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('ws_1', { type: 'updated', entity: 'issue', id: 'iss_1' });
  });
});
