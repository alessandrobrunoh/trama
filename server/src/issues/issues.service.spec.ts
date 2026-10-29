import { describe, expect, it, vi } from 'vitest';
import type { IssueEntity } from '../database/entities/index.js';
import { IssuesService, claimAssignee } from './issues.service.js';

describe('claimAssignee', () => {
  it('claims an unassigned issue for a person entering in_progress', () => {
    expect(claimAssignee({ type: 'user', id: 'usr_me' }, 'todo', 'in_progress', null, false))
      .toBe('usr_me');
  });

  it('does not change explicit assignments or claim for agents', () => {
    expect(claimAssignee({ type: 'user', id: 'usr_me' }, 'todo', 'in_progress', 'usr_other', false))
      .toBe('usr_other');
    expect(claimAssignee({ type: 'agent', id: 'ag_me' }, 'todo', 'in_progress', null, false))
      .toBeNull();
  });
});

describe('IssuesService.update parent authorization', () => {
  it('authorizes the parent read under the hierarchy lock, not the stale pre-transaction parent', async () => {
    const actor = { type: 'user' as const, id: 'usr_me' };
    const issue = (id: string, over: Partial<IssueEntity> = {}) =>
      ({
        id,
        workspaceId: 'ws_1',
        key: `BUG-${id}`,
        number: 1,
        kind: 'bug',
        title: id,
        status: 'todo',
        priority: 'none',
        assigneeId: null,
        teamId: null,
        projectId: 'pj_visible',
        parentId: null,
        duplicateOfId: null,
        milestoneIds: [],
        labels: [],
        aliases: [],
        startedAt: null,
        completedAt: null,
        updatedAt: new Date(0),
        ...over,
      }) as IssueEntity;
    const initialChild = issue('in_child', { parentId: 'in_stale_parent' });
    const lockedChild = issue('in_child', { parentId: 'in_current_parent' });
    const staleParent = issue('in_stale_parent', { teamId: 'tm_allowed' });
    const currentParent = issue('in_current_parent', { teamId: 'tm_locked' });
    const nextParent = issue('in_next_parent', { teamId: 'tm_allowed' });
    const persisted = new Map([
      [initialChild.id, initialChild],
      [staleParent.id, staleParent],
      [nextParent.id, nextParent],
    ]);
    const lockedRows = new Map([
      [lockedChild.id, lockedChild],
      [currentParent.id, currentParent],
      [nextParent.id, nextParent],
    ]);
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM "workspaces"')) return [];
      if (sql.includes('WITH RECURSIVE'))
        return [{ found: true, includesChild: false, containsCycle: false }];
      if (sql.includes('"id" = ANY')) {
        const ids = params?.[1] as string[];
        return ids.flatMap((id) =>
          lockedRows.has(id) ? [lockedRows.get(id)] : [],
        );
      }
      if (sql.includes('"id" = $2')) {
        const id = params?.[1] as string;
        return lockedRows.has(id) ? [lockedRows.get(id)] : [];
      }
      return [];
    });
    const save = vi.fn(async (row: IssueEntity) => row);
    const manager = { query, save };
    const service = new IssuesService(
      {
        transaction: (run: (manager: unknown) => Promise<unknown>) =>
          run(manager),
        getRepository: () => ({ findOneBy: async () => null }),
      } as never,
      {
        teams: async () => undefined,
        users: async () => undefined,
        projects: async () => undefined,
      } as never,
      {} as never,
      { record: vi.fn(async () => undefined) } as never,
      { assign: vi.fn(async () => []) } as never,
      {
        findOneBy: async ({ id }: { id: string }) => persisted.get(id) ?? null,
      } as never,
    );
    const authorize = vi.fn(async (affected: readonly IssueEntity[]) => {
      if (affected.some((candidate) => candidate.teamId === 'tm_locked'))
        throw new Error('Current parent team is restricted');
    });

    await expect(
      service.update(
        'ws_1',
        actor,
        'in_child',
        { parentId: 'in_next_parent' },
        authorize,
      ),
    ).rejects.toThrow('Current parent team is restricted');

    const authorizedRows = authorize.mock.calls[0][0];
    expect(authorizedRows.map((row) => row.id).sort()).toEqual([
      'in_child',
      'in_current_parent',
      'in_next_parent',
    ]);
    expect(authorizedRows.map((row) => row.id)).not.toContain('in_stale_parent');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('IssuesService.list limit', () => {
  function serviceCapturingTake() {
    const take = vi.fn().mockReturnThis();
    const qb = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      take,
      getMany: vi.fn(async () => []),
    };
    const service = new IssuesService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { createQueryBuilder: () => qb } as never,
    );
    return { service, take };
  }

  it('caps an omitted limit at 500 and still honors a smaller one', async () => {
    const open = serviceCapturingTake();
    await open.service.list('ws_1', { kind: 'bug' });
    expect(open.take).toHaveBeenCalledWith(500);

    const paged = serviceCapturingTake();
    await paged.service.list('ws_1', { limit: 25 });
    expect(paged.take).toHaveBeenCalledWith(25);

    const over = serviceCapturingTake();
    await over.service.list('ws_1', { limit: 900 });
    expect(over.take).toHaveBeenCalledWith(500);
  });
});
