import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../auth/request-context.js';
import {
  DecisionEntity,
  IssueEntity,
  MembershipEntity,
  ProjectEntity,
  SavedViewEntity,
  TeamEntity,
  UserEntity,
  WorkspaceEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { PublicViewsController } from './public-views.controller.js';
import { PUBLIC_VIEW_LIMIT, PublicViewsService } from './public-views.service.js';
import { generatePublicToken, hashPublicToken } from './view-token.js';

const issue = (n: number, over: Record<string, unknown> = {}) => ({
  id: `in_${n}`,
  workspaceId: 'w1',
  key: `BUG-${n}`,
  kind: 'bug',
  title: `Issue ${n}`,
  body: 'PRIVATE BODY',
  reporterName: 'Secret Reporter',
  reporterId: 'u9',
  externalUrl: 'https://internal.example/secret',
  estimate: 3,
  status: 'todo',
  priority: 'high',
  assigneeId: 'u1',
  teamId: 't1',
  projectId: null,
  workstreamIds: [],
  labels: ['lb_ui', 'lb_gone'],
  updatedAt: new Date('2026-02-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

function setup(view: Partial<SavedViewEntity> | null, issues: Record<string, unknown>[] = []) {
  const token = generatePublicToken();
  const row = view
    ? Object.assign(new SavedViewEntity(), {
        id: 'v1',
        workspaceId: 'w1',
        ownerId: 'u1',
        name: 'Open bugs',
        entity: 'issue',
        filters: [{ field: 'status', op: 'is', value: 'todo' }],
        sort: null,
        groupBy: null,
        layout: 'list',
        sharing: { visibility: 'link', grants: [] },
        publicTokenHash: hashPublicToken(token),
        ...view,
      })
    : null;
  const repo = { findOneBy: vi.fn(async (where: { publicTokenHash: string }) => (row && where.publicTokenHash === row.publicTokenHash ? row : null)) };
  const find = vi.fn(async (opts?: { where?: { workspaceId?: string } }) => {
    // Every query must be scoped to the view's workspace.
    if (opts?.where) expect(opts.where.workspaceId).toBe('w1');
    return issues;
  });
  const tables = new Map<unknown, unknown>([
    [IssueEntity, { find }],
    [WorkstreamEntity, { find: async () => [{ id: 'wk1', title: 'Hidden stream', projectId: 'p1' }] }],
    [DecisionEntity, { find: async () => [] }],
    [ProjectEntity, { find: async () => [{ id: 'p1', name: 'Apollo' }] }],
    [TeamEntity, { find: async () => [{ id: 't1', name: 'Platform' }, { id: 't2', name: 'Other' }] }],
    [MembershipEntity, { findBy: async () => [{ userId: 'u1' }] }],
    [UserEntity, { findBy: async () => [{ id: 'u1', name: 'Ada', email: 'ada@example.com', passwordHash: 'x' }] }],
    [WorkspaceEntity, { findOneBy: async () => ({ id: 'w1', name: 'Acme', settings: { labels: [{ id: 'lb_ui', name: 'UI', color: '#2563eb', template: false }] } }) }],
  ]);
  const ds = { getRepository: (e: unknown) => tables.get(e) ?? { find: async () => [] } };
  return { token, service: new PublicViewsService(ds as never, repo as never), repo, find };
}

describe('PublicViewsService', () => {
  it('returns the fixed result of the view with a minimal projection', async () => {
    const { token, service } = setup({}, [issue(1), issue(2, { status: 'done' }), issue(3)]);
    const out = await service.get(token);
    expect(out).toMatchObject({ name: 'Open bugs', entity: 'issue', layout: 'list', workspaceName: 'Acme', total: 2, truncated: false });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].items.map((i) => i.key)).toEqual(['BUG-1', 'BUG-3']);
    expect(out.groups[0].items[0]).toEqual({
      id: 'in_1',
      key: 'BUG-1',
      title: 'Issue 1',
      kind: 'bug',
      status: 'todo',
      priority: 'high',
      team: 'Platform',
      assignee: 'Ada',
      labels: ['UI'],
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  it('never leaks private fields', async () => {
    const { token, service } = setup({}, [issue(1)]);
    const json = JSON.stringify(await service.get(token));
    for (const secret of ['PRIVATE BODY', 'Secret Reporter', 'u9', 'internal.example', 'ada@example.com', 'passwordHash', 'workspaceId', 'w1', 'Hidden stream', 'Other', 'ownerId', 'filters', 'publicToken']) {
      expect(json).not.toContain(secret);
    }
  });

  it('groups by the view grouping with resolved names, or by status on a board', async () => {
    const issues = [issue(1), issue(2, { teamId: null }), issue(3, { teamId: 't1' })];
    const byTeam = setup({ groupBy: 'teamId' }, issues);
    const grouped = await byTeam.service.get(byTeam.token);
    expect(grouped.groupBy).toBe('teamId');
    expect(grouped.groups.map((g) => [g.key, g.label, g.items.length])).toEqual([
      ['t1', 'Platform', 2],
      ['', '', 1],
    ]);
    const board = setup({ layout: 'board', filters: [] }, [issue(1), issue(2, { status: 'done' })]);
    const out = await board.service.get(board.token);
    expect(out.groupBy).toBe('status');
    expect(out.groups.map((g) => g.key)).toEqual(['todo', 'done']);
  });

  it('applies the view sort and its issue project filter through workstreams', async () => {
    const s = setup({ filters: [{ field: 'projectId', op: 'is', value: 'p1' }], sort: { field: 'title', direction: 'desc' } }, [
      issue(1, { workstreamIds: ['wk1'] }),
      issue(2),
      issue(3, { workstreamIds: ['wk1'] }),
    ]);
    const out = await s.service.get(s.token);
    expect(out.groups[0].items.map((i) => i.key)).toEqual(['BUG-3', 'BUG-1']);
  });

  it('truncates long results', async () => {
    const many = Array.from({ length: PUBLIC_VIEW_LIMIT + 5 }, (_, i) => issue(i + 1));
    const s = setup({}, many);
    const out = await s.service.get(s.token);
    expect(out.total).toBe(PUBLIC_VIEW_LIMIT + 5);
    expect(out.truncated).toBe(true);
    expect(out.groups[0].items).toHaveLength(PUBLIC_VIEW_LIMIT);
  });

  it('answers 404 for malformed, unknown, revoked and no-longer-public tokens', async () => {
    const s = setup({}, [issue(1)]);
    for (const bad of ['', 'nope', 'vt_x', generatePublicToken(), `${s.token}x`]) {
      await expect(s.service.get(bad)).rejects.toMatchObject({ status: 404 });
    }
    const workspaceOnly = setup({ sharing: { visibility: 'workspace', grants: [] } }, [issue(1)]);
    await expect(workspaceOnly.service.get(workspaceOnly.token)).rejects.toMatchObject({ status: 404 });
    const revoked = setup({ publicTokenHash: null }, [issue(1)]);
    await expect(revoked.service.get(revoked.token)).rejects.toMatchObject({ status: 404 });
    expect(revoked.find).not.toHaveBeenCalled();
  });

  it('does not touch the database for a malformed token', async () => {
    const s = setup({}, []);
    await expect(s.service.get('../../etc/passwd')).rejects.toMatchObject({ status: 404 });
    expect(s.repo.findOneBy).not.toHaveBeenCalled();
  });
});

describe('PublicViewsController', () => {
  it('is a single public, read-only GET taking only the token', () => {
    const proto = PublicViewsController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, PublicViewsController)).toBe('public/views');
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.get)).toBe(true);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.get)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, proto.get)).toBe(':token');
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(handlers).toEqual(['get']);
    expect(proto.get.length).toBe(1);
  });
});
