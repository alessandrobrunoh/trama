import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import type { Role } from '../contracts/domain.js';
import { IntegrationConnectionEntity, type UserEntity } from '../database/entities/index.js';
import { SnapshotService } from './snapshot.service.js';

const connection = { id: 'ic_1', provider: 'github', account: 'acme', status: 'connected', lastError: null };

function build(role: Role, manageIntegrations: Role = 'admin') {
  const queried: unknown[] = [];
  const ds = {
    getRepository: (entity: unknown) => {
      queried.push(entity);
      const rows = entity === IntegrationConnectionEntity ? [connection] : [];
      return { find: vi.fn().mockResolvedValue(rows), findBy: vi.fn().mockResolvedValue([]) };
    },
  };
  const service = new SnapshotService(
    ds as never,
    { list: vi.fn().mockResolvedValue([]) } as never,
    { forUser: vi.fn().mockResolvedValue([]) } as never,
    {
      attachProjectCounts: vi.fn().mockImplementation((_ws: string, rows: unknown[]) => rows),
      attachCounts: vi.fn().mockImplementation((_ws: string, rows: unknown[]) => rows),
    } as never,
    { listAll: vi.fn().mockResolvedValue([]), index: vi.fn().mockResolvedValue([]) } as never,
  );
  const ctx = {
    role,
    workspace: { id: 'ws_1', resolved: () => ({ permissions: { manageIntegrations } }) },
  } as unknown as WorkspaceContext;
  return { run: () => service.build(ctx, { id: 'usr_1' } as UserEntity, role), queried };
}

describe('SnapshotService integrations', () => {
  it('lists connections for roles that may manage integrations', async () => {
    for (const role of ['admin', 'owner'] as const) {
      const { run } = build(role);
      expect((await run()).integrations).toEqual([connection]);
    }
  });

  it('hides them from viewers and members, without even querying', async () => {
    for (const role of ['viewer', 'member'] as const) {
      const { run, queried } = build(role);
      expect((await run()).integrations).toEqual([]);
      expect(queried).not.toContain(IntegrationConnectionEntity);
    }
  });

  it('follows the workspace permission setting', async () => {
    expect((await build('member', 'member').run()).integrations).toEqual([connection]);
    expect((await build('member', 'owner').run()).integrations).toEqual([]);
  });
});
