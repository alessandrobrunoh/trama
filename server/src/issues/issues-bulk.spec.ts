import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
import { memberAccessStore } from '../auth/member-access.js';
import type { MemberAccess } from '../contracts/domain.js';
import type { IssueEntity } from '../database/entities/index.js';
import {
  BULK_ISSUES_MAX,
  BulkDeleteIssuesDto,
  BulkUpdateIssuesDto,
  IssuesController,
} from './issues.controller.js';
import { IssuesService } from './issues.service.js';

const actor = { type: 'user' as const, id: 'usr_me' };

function issue(id: string, over: Partial<IssueEntity> = {}): IssueEntity {
  return {
    id,
    workspaceId: 'ws_1',
    key: `BUG-${id.slice(-1)}`,
    kind: 'bug',
    title: id,
    status: 'todo',
    priority: 'none',
    assigneeId: null,
    projectId: null,
    parentId: null,
    duplicateOfId: null,
    milestoneIds: [] as string[],
    labels: [] as string[],
    aliases: [] as string[],
    startedAt: null,
    completedAt: null,
    updatedAt: new Date(0),
    ...over,
  } as unknown as IssueEntity;
}

function makeService(opts: { failSave?: boolean } = {}) {
  const byId = new Map<string, IssueEntity>();
  const save = vi.fn(async (r: unknown) => {
    if (opts.failSave) throw new Error('db down');
    return r;
  });
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM "projects"')) return [{ key: 'BUG' }];
    if (sql.startsWith('SELECT "id", "projectId"')) {
      const ids = params?.[1] as string[];
      return ids.map((id) => {
        const row = byId.get(id) ?? issue(id);
        return {
          id,
          projectId: row.projectId,
          parentId: row.parentId,
          key: row.key,
          number: row.number,
          aliases: row.aliases,
        };
      });
    }
    if (sql.startsWith('SELECT "id", "parentId"')) {
      const ids = params?.[1] as string[];
      return ids.map((id) => ({
        id,
        parentId: byId.get(id)?.parentId ?? null,
      }));
    }
    if (sql.startsWith('SELECT * FROM "issues"')) {
      const ids = params?.[1] as string[];
      if (sql.includes('"parentId" = ANY')) {
        const parentIds = params?.[2] as string[];
        return [...byId.values()].filter(
          (row) =>
            ids.includes(row.id) ||
            ids.includes(row.parentId ?? '') ||
            parentIds.includes(row.id),
        );
      }
      return [...byId.values()].filter((row) => ids.includes(row.id));
    }
    return [];
  });
  const del = vi.fn(async () => undefined);
  const update = vi.fn(async () => undefined);
  const manager = { save, query, update, delete: del };
  const transaction = vi.fn(async (fn: (m: unknown) => Promise<void>) => fn(manager));
  const record = vi.fn(async (_event: { type: string }) => undefined);
  const refs = {
    users: vi.fn(async () => undefined),
    projects: vi.fn(async () => undefined),
  };
  const labels = { assign: vi.fn(async (_w: string, ids?: string[]) => ids) };
  const qb = {
    where: vi.fn(() => qb),
    andWhere: vi.fn((_sql: string, extra?: Record<string, unknown>) => {
      Object.assign(qb.params, extra);
      return qb;
    }),
    getMany: vi.fn(async () => {
      const ids = (qb.params.ids as string[] | undefined) ?? [];
      const keys = (qb.params.keys as string[] | undefined) ?? [];
      return [...byId.values()].filter(
        (row) =>
          ids.includes(row.id) ||
          keys.includes(row.key) ||
          keys.some((key) => row.aliases.includes(key)),
      );
    }),
    params: {} as Record<string, unknown>,
  };
  const repo = {
    findOneBy: vi.fn(async ({ id }: { id: string }) => byId.get(id) ?? null),
    createQueryBuilder: vi.fn(() => {
      qb.params = {};
      return qb;
    }),
  };
  const workspaceFind = vi.fn(async () => null);
  const service = new IssuesService(
    {
      transaction,
      getRepository: () => ({ findOneBy: workspaceFind, findBy: vi.fn(async () => []) }),
    } as never,
    refs as never,
    { next: vi.fn(async () => 1), nextAbove: vi.fn(async () => 1) } as never,
    { record } as never,
    labels as never,
    repo as never,
  );
  return {
    service,
    byId,
    save,
    query,
    update,
    del,
    transaction,
    record,
    refs,
    labels,
    repo,
    workspaceFind,
  };
}

const eventTypes = (record: ReturnType<typeof vi.fn>) =>
  record.mock.calls.map((c) => (c[0] as { type: string }).type);

describe('IssuesService.getMany', () => {
  it('returns rows in input order and folds duplicate references', async () => {
    const { service, byId } = makeService();
    byId.set('in_a', issue('in_a'));
    byId.set('in_b', issue('in_b'));
    const rows = await service.getMany('ws_1', ['in_b', 'in_a', 'in_b']);
    expect(rows.map((r) => r.id)).toEqual(['in_b', 'in_a']);
  });

  it('404s naming every unknown reference', async () => {
    const { service, byId } = makeService();
    byId.set('in_a', issue('in_a'));
    const err = await service.getMany('ws_1', ['in_a', 'in_x', 'in_y']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as Error).message).toContain('in_x, in_y');
  });

  it('resolves ids, keys, and aliases in one query and hides projects', async () => {
    const { service, byId, repo } = makeService();
    byId.set('in_a', issue('in_a', { key: 'AUTH-1', aliases: ['OLD-1'], projectId: 'pj_ok' }));
    byId.set('in_b', issue('in_b', { key: 'AUTH-2', projectId: 'pj_ok' }));
    byId.set('in_h', issue('in_h', { key: 'AUTH-3', projectId: 'pj_hidden' }));
    const access: MemberAccess = {
      projects: { all: false, projectIds: ['pj_ok'] },
      includeUnassigned: true,
      grants: [],
    };
    const rows = await memberAccessStore.run(access, () =>
      service.getMany('ws_1', ['auth-2', 'OLD-1', 'in_a', 'AUTH-3', 'auth-2']),
    ).catch((e: unknown) => e);
    expect(rows).toBeInstanceOf(NotFoundException);
    expect((rows as Error).message).toContain('AUTH-3');
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(repo.findOneBy).not.toHaveBeenCalled();

    const ok = await memberAccessStore.run(access, () =>
      service.getMany('ws_1', ['auth-2', 'OLD-1', 'in_a', 'auth-2']),
    );
    expect(ok.map((r) => r.id)).toEqual(['in_b', 'in_a']);
    expect(repo.createQueryBuilder).toHaveBeenCalledTimes(2);
  });
});

describe('IssuesService.updateMany', () => {
  it('rejects an empty patch', async () => {
    const { service, save } = makeService();
    await expect(service.updateMany('ws_1', actor, [issue('in_a')], {})).rejects.toThrow(
      /at least one field/,
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('applies status and priority to every issue in a single transaction', async () => {
    const { service, transaction, save, record, workspaceFind } = makeService();
    const rows = [issue('in_a'), issue('in_b')];
    const out = await service.updateMany('ws_1', actor, rows, {
      status: 'in_review',
      priority: 'high',
    });
    expect(out.map((r) => [r.status, r.priority])).toEqual([
      ['in_review', 'high'],
      ['in_review', 'high'],
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toHaveLength(2);
    // events follow the commit, one set per issue
    expect(eventTypes(record).filter((t) => t === 'issue.status_changed')).toHaveLength(2);
    expect(eventTypes(record).filter((t) => t === 'issue.updated')).toHaveLength(2);
    expect(workspaceFind).toHaveBeenCalledTimes(1);
  });

  it('validates references once per batch, not once per issue', async () => {
    const { service, refs } = makeService();
    await service.updateMany('ws_1', actor, [issue('in_a'), issue('in_b'), issue('in_c')], {
      assigneeId: 'usr_x',
      projectId: 'pj_x',
    });
    expect(refs.projects).toHaveBeenCalledTimes(1);
    expect(refs.projects).toHaveBeenCalledWith('ws_1', ['pj_x']);
    expect(refs.users).toHaveBeenCalledWith('ws_1', ['usr_x']);
  });

  it('an unknown reference rejects the whole batch before anything is written', async () => {
    const { service, refs, transaction, record } = makeService();
    refs.users.mockRejectedValueOnce(new Error('Not workspace members: usr_x'));
    await expect(
      service.updateMany('ws_1', actor, [issue('in_a'), issue('in_b')], { assigneeId: 'usr_x' }),
    ).rejects.toThrow(/Not workspace members/);
    expect(transaction).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records no event when the transaction fails', async () => {
    const { service, record } = makeService({ failSave: true });
    await expect(
      service.updateMany('ws_1', actor, [issue('in_a')], { priority: 'low' }),
    ).rejects.toThrow('db down');
    expect(record).not.toHaveBeenCalled();
  });

  it('adds and removes labels per issue instead of replacing them', async () => {
    const { service } = makeService();
    const rows = [
      issue('in_a', { labels: ['lb_1', 'lb_2'] }),
      issue('in_b', { labels: ['lb_2'] }),
    ];
    await service.updateMany('ws_1', actor, rows, { addLabels: ['lb_3'], removeLabels: ['lb_2'] });
    expect(rows.map((r) => r.labels)).toEqual([['lb_1', 'lb_3'], ['lb_3']]);
  });

  it('preserves the current parent when a bulk update saves a stale issue row', async () => {
    const { service, byId } = makeService();
    const stale = issue('in_child', { parentId: 'in_old_parent' });
    byId.set('in_child', issue('in_child', { parentId: 'in_current_parent' }));

    await service.updateMany('ws_1', actor, [stale], { priority: 'high' });

    expect(stale.parentId).toBe('in_current_parent');
  });

  it('rejects a label that is both added and removed', async () => {
    const { service } = makeService();
    await expect(
      service.updateMany('ws_1', actor, [issue('in_a')], {
        addLabels: ['lb_1'],
        removeLabels: ['lb_1'],
      }),
    ).rejects.toThrow(/both added and removed/);
  });

  it('the acting user claims unassigned issues moved to in_progress, others keep their assignee', async () => {
    const { service } = makeService();
    const rows = [issue('in_a'), issue('in_b', { assigneeId: 'usr_other' })];
    await service.updateMany('ws_1', actor, rows, { status: 'in_progress' });
    expect(rows.map((r) => r.assigneeId)).toEqual(['usr_me', 'usr_other']);
  });

  it('skips the status event when the status does not change', async () => {
    const { service, record } = makeService();
    const rows = [issue('in_a', { status: 'done' })];
    await service.updateMany('ws_1', actor, rows, { status: 'done' });
    expect(eventTypes(record)).not.toContain('issue.status_changed');
  });
});

describe('IssuesService.removeMany', () => {
  it('checks related issues, then deletes comments, duplicate links and issues in one transaction', async () => {
    const { service, transaction, query, del, record, byId } = makeService();
    const rows = [
      issue('in_a'),
      issue('in_b'),
    ];
    for (const row of rows) byId.set(row.id, row);
    const authorize = vi.fn(async () => undefined);
    await service.removeMany('ws_1', actor, rows, authorize);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledWith(expect.arrayContaining(rows));
    const commentDelete = query.mock.calls.find((call) =>
      String(call[0]).includes('"comments"'),
    );
    expect(commentDelete?.[1]).toEqual(['ws_1', ['in_a', 'in_b']]);
    expect(
      query.mock.calls.some((call) => String(call[0]).includes('"duplicateOfId"')),
    ).toBe(true);
    expect(del).toHaveBeenCalledTimes(1);
    expect(eventTypes(record)).toEqual(['issue.deleted', 'issue.deleted']);
  });

  it('leaves issues untouched when authorization rejects a hierarchy delete', async () => {
    const { service, byId, del, record } = makeService();
    const parent = issue('in_parent');
    const child = issue('in_child', { parentId: parent.id });
    byId.set(parent.id, parent);
    byId.set(child.id, child);
    const authorize = vi.fn(async (affected: readonly { id: string }[]) => {
      expect(affected.map((row) => row.id).sort()).toEqual(['in_child', 'in_parent']);
      throw new ForbiddenException('project hidden');
    });

    await expect(
      service.removeMany('ws_1', actor, [child], authorize),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(del).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('detaches surviving children and records the hierarchy change when deleting a parent', async () => {
    const { service, byId, update, record } = makeService();
    const parent = issue('in_parent');
    const child = issue('in_child', { parentId: parent.id });
    byId.set(parent.id, parent);
    byId.set(child.id, child);

    await service.removeMany('ws_1', actor, [parent], async () => undefined);

    expect(child.parentId).toBeNull();
    expect(update).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ parentId: null, updatedAt: expect.any(Date) }),
    );
    expect(eventTypes(record)).toEqual(['issue.deleted', 'issue.updated']);
    expect(record.mock.calls[1][0]).toMatchObject({
      subject: { type: 'issue', id: 'in_child' },
      data: { fields: ['parentId'] },
    });
  });

  it('records nothing when the transaction fails', async () => {
    const { service, record, transaction } = makeService();
    transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.removeMany('ws_1', actor, [issue('in_a')], async () => undefined),
    ).rejects.toThrow('db down');
    expect(record).not.toHaveBeenCalled();
  });
});

describe('IssuesController bulk', () => {
  const ctx = { workspace: { id: 'ws_1' } } as never;
  function makeController(rows: IssueEntity[]) {
    const service = {
      getMany: vi.fn(async () => rows),
      updateMany: vi.fn(async (_w: string, _a: unknown, r: IssueEntity[]) => r),
      removeMany: vi.fn(async () => undefined),
      visibleParentIds: vi.fn(async () => new Set<string>()),
    };
    const controller = new IssuesController(service as never, {} as never);
    return { controller, service };
  }

  it('updates the batch without a team policy', async () => {
    const { controller, service } = makeController([issue('in_a'), issue('in_b')]);
    await controller.bulkUpdate(ctx, actor, {
      ids: ['in_a', 'in_b'],
      patch: { priority: 'low' },
    });
    expect(service.updateMany).toHaveBeenCalledTimes(1);
  });

  it('returns the deleted ids', async () => {
    const ok = makeController([issue('in_a'), issue('in_b')]);
    expect(await ok.controller.bulkDelete(ctx, actor, { ids: ['in_a', 'in_b'] })).toEqual({
      deleted: ['in_a', 'in_b'],
    });
  });
});

describe('bulk DTOs', () => {
  const update = async (body: Record<string, unknown>) =>
    validate(plainToInstance(BulkUpdateIssuesDto, body), { whitelist: true });
  const remove = async (body: Record<string, unknown>) =>
    validate(plainToInstance(BulkDeleteIssuesDto, body), { whitelist: true });

  it('accepts a well-formed request, including null to clear a field', async () => {
    expect(
      await update({
        ids: ['BUG-1', 'in_b'],
        patch: { status: 'done', assigneeId: null, addLabels: ['lb_1'] },
      }),
    ).toHaveLength(0);
  });

  it('requires ids and a patch', async () => {
    expect(await update({ patch: { status: 'done' } })).not.toHaveLength(0);
    expect(await update({ ids: [], patch: { status: 'done' } })).not.toHaveLength(0);
    expect(await update({ ids: ['in_a'] })).not.toHaveLength(0);
  });

  it('caps the batch and rejects repeated ids', async () => {
    const many = Array.from({ length: BULK_ISSUES_MAX + 1 }, (_, i) => `in_${i}`);
    expect(await update({ ids: many, patch: { status: 'done' } })).not.toHaveLength(0);
    expect(await remove({ ids: many.slice(0, BULK_ISSUES_MAX) })).toHaveLength(0);
    expect(await remove({ ids: ['in_a', 'in_a'] })).not.toHaveLength(0);
  });

  it('rejects invalid enum values, null on non-clearable fields and non-string ids', async () => {
    expect(await update({ ids: ['in_a'], patch: { status: 'nope' } })).not.toHaveLength(0);
    expect(await update({ ids: ['in_a'], patch: { priority: null } })).not.toHaveLength(0);
    expect(await update({ ids: ['in_a'], patch: { addLabels: [1] } })).not.toHaveLength(0);
    expect(await remove({ ids: [5] })).not.toHaveLength(0);
  });
});
