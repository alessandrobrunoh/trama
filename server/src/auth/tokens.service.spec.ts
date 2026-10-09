import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../common/crypto.js';
import { LEGACY_TOKEN_PREFIX, TOKEN_PREFIX, TokensService } from './tokens.service.js';

function setup() {
  const rows = new Map<string, { id: string; lastUsedAt: Date | null; expiresAt: Date | null }>();
  const repo = {
    create: (v: Record<string, unknown>) => v,
    save: vi.fn(async (v: { id: string; tokenHash: string }) => {
      rows.set(v.tokenHash, { id: v.id, lastUsedAt: new Date(), expiresAt: null });
      return v;
    }),
    findOne: vi.fn(async ({ where }: { where: { tokenHash: string } }) => rows.get(where.tokenHash) ?? null),
    update: vi.fn(async () => undefined),
  };
  const service = new TokensService(repo as never);
  return { service, rows, repo };
}

describe('TokensService prefixes', () => {
  it('issues new tokens with the trm_ prefix', async () => {
    const { service } = setup();
    const { secret, token } = await service.create({ workspaceId: 'w1', name: 'ci', actor: { type: 'user', id: 'u1' } });
    expect(secret.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(TOKEN_PREFIX).toBe('trm_');
    expect(token.prefix).toBe(`${secret.slice(0, 8)}…`);
    expect(await service.authenticate(secret)).not.toBeNull();
  });

  it('still authenticates tokens minted with the legacy nbl_ prefix', async () => {
    const { service, rows } = setup();
    const secret = `${LEGACY_TOKEN_PREFIX}abcdefghijklmnop`;
    rows.set(sha256(secret), { id: 'tk_old', lastUsedAt: new Date(), expiresAt: null });
    expect(await service.authenticate(secret)).toMatchObject({ id: 'tk_old' });
  });

  it('rejects secrets with an unknown prefix without hitting the database', async () => {
    const { service, repo } = setup();
    expect(await service.authenticate('xyz_abcdef')).toBeNull();
    expect(repo.findOne).not.toHaveBeenCalled();
  });
});
