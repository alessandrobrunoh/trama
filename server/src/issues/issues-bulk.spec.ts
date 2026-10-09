import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it, vi } from 'vitest';
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
    teamId: null,
    projectId: null,
    duplicateOfId: null,
    workstreamIds: [] as string[],
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
  const save = vi.fn(async (r: unknown) => {
    if (opts.failSave) throw new Error('db down');
    return r;
  });
  const query = vi.fn(async () => undefined);
  const del = vi.fn(async () => undefined);
  const manager = { save, query, delete: del };
  const transaction = vi.fn(async (fn: (m: unknown) => Promise<void>) => fn(manager));
  const record = vi.fn(async () => undefined);
  const touchMany = vi.fn(async () => undefined);
  const refs = {
    teams: vi.fn(async () => undefined),
    users: vi.fn(async () => undefined),
    projects: vi.fn(async () => undefined),
    workstreams: vi.fn(async () => undefined),
  };
  const labels = { assign: vi.fn(async (_w: string, ids?: string[]) => ids) };
  const byId = new Map<string, IssueEntity>();
  const repo = { findOneBy: vi.fn(async ({ id }: { id: string }) => byId.get(id) ?? null) };
  const service = new IssuesService(
    { transaction } as never,
    refs as never,
    {} as never,
    { record } as never,
    { touchMany } as never,
    {} as never,
    labels as never,
    repo as never,
  );
  return { service, byId, save, query, del, transaction, record, refs, labels, touchMany };
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
    const { service, transaction, save, record } = makeService();
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
  });

  it('validates references once per batch, not once per issue', async () => {
    const { service, refs } = makeService();
    await service.updateMany('ws_1', actor, [issue('in_a'), issue('in_b'), issue('in_c')], {
      assigneeId: 'usr_x',
      teamId: 'tm_x',
    });
    expect(refs.teams).toHaveBeenCalledTimes(1);
    expect(refs.teams).toHaveBeenCalledWith('ws_1', ['tm_x']);
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
    const { service, record, touchMany } = makeService({ failSave: true });
    await expect(
      service.updateMany('ws_1', actor, [issue('in_a')], { priority: 'low' }),
    ).rejects.toThrow('db down');
    expect(record).not.toHaveBeenCalled();
    expect(touchMany).not.toHaveBeenCalled();
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

  it('rejects a label that is both added and removed', async () => {
    const { service } = makeService();
    await expect(
      service.updateMany('ws_1', actor, [issue('in_a')], {
        addLabels: ['lb_1'],
        removeLabels: ['lb_1'],
      }),
    ).rejects.toThrow(/both added and removed/);
  });

  it('links and unlinks workstreams, keeping the others, and refreshes every touched workstream', async () => {
    const { service, touchMany } = makeService();
    const rows = [
      issue('in_a', { workstreamIds: ['wk_1'] }),
      issue('in_b', { workstreamIds: ['wk_2'] }),
    ];
    await service.updateMany('ws_1', actor, rows, {
      addWorkstreamIds: ['wk_3'],
      removeWorkstreamIds: ['wk_1'],
    });
    expect(rows.map((r) => r.workstreamIds)).toEqual([['wk_3'], ['wk_2', 'wk_3']]);
    const touched = touchMany.mock.calls.flatMap((c) => [...(c[1] as Iterable<string>)]);
    expect(new Set(touched)).toEqual(new Set(['wk_1', 'wk_2', 'wk_3']));
  });

  it('announces issue.linked on each workstream an issue was added to, not on the ones it already had', async () => {
    const { service, record } = makeService();
    await service.updateMany('ws_1', actor, [issue('in_a', { workstreamIds: ['wk_1'] })], {
      addWorkstreamIds: ['wk_1', 'wk_2'],
    });
    const linked = record.mock.calls
      .map((c) => c[0] as { type: string; workstreamId?: string })
      .filter((e) => e.type === 'issue.linked');
    expect(linked.map((e) => e.workstreamId)).toEqual(['wk_2']);
  });

  it('refuses to link duplicates', async () => {
    const { service, transaction } = makeService();
    const rows = [issue('in_a'), issue('in_b', { duplicateOfId: 'in_a' })];
    await expect(
      service.updateMany('ws_1', actor, rows, { addWorkstreamIds: ['wk_1'] }),
    ).rejects.toThrow(/Duplicates cannot be linked.*BUG-b/);
    expect(transaction).not.toHaveBeenCalled();
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
  it('deletes comments, duplicate links and issues in one transaction, then records events', async () => {
    const { service, transaction, query, del, record, touchMany } = makeService();
    await service.removeMany('ws_1', actor, [
      issue('in_a', { workstreamIds: ['wk_1'] }),
      issue('in_b'),
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0][0])).toContain('comments');
    expect(query.mock.calls[0][1]).toEqual(['ws_1', ['in_a', 'in_b']]);
    expect(del).toHaveBeenCalledTimes(1);
    expect(eventTypes(record)).toEqual(['issue.deleted', 'issue.deleted']);
    expect([...(touchMany.mock.calls[0][1] as string[])]).toEqual(['wk_1']);
  });

  it('records nothing when the transaction fails', async () => {
    const { service, record, transaction } = makeService();
    transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(service.removeMany('ws_1', actor, [issue('in_a')])).rejects.toThrow('db down');
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
    };
    const permissions = {
      assertTeamEdit: vi.fn(async (_c: unknown, team: string) => {
        if (team === 'tm_locked') throw new ForbiddenException('Team LCK only lets its members edit');
      }),
    };
    const customers = { attachCounts: vi.fn(async () => undefined) };
    const controller = new IssuesController(
      service as never,
      customers as never,
      permissions as never,
    );
    return { controller, service, permissions };
  }

  it('checks the edit policy of every team involved, including the one issues move to', async () => {
    const { controller, permissions, service } = makeController([
      issue('in_a', { teamId: 'tm_a' }),
      issue('in_b', { teamId: 'tm_a' }),
      issue('in_c'),
    ]);
    await controller.bulkUpdate(ctx, actor, {
      ids: ['in_a', 'in_b', 'in_c'],
      patch: { teamId: 'tm_b' },
    });
    expect(permissions.assertTeamEdit.mock.calls.map((c) => c[1]).sort()).toEqual(['tm_a', 'tm_b']);
    expect(service.updateMany).toHaveBeenCalledTimes(1);
  });

  it('403s without writing when one issue belongs to a team the caller cannot edit', async () => {
    const { controller, service } = makeController([
      issue('in_a'),
      issue('in_b', { teamId: 'tm_locked' }),
    ]);
    await expect(
      controller.bulkUpdate(ctx, actor, { ids: ['in_a', 'in_b'], patch: { priority: 'low' } }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.updateMany).not.toHaveBeenCalled();
  });

  it('403s a bulk delete the same way and returns the deleted ids otherwise', async () => {
    const locked = makeController([issue('in_a', { teamId: 'tm_locked' })]);
    await expect(locked.controller.bulkDelete(ctx, actor, { ids: ['in_a'] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(locked.service.removeMany).not.toHaveBeenCalled();

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
