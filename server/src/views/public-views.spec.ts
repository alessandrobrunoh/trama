import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../auth/request-context.js';
import {
  CustomerEntity,
  CustomerRequestEntity,
  DecisionEntity,
  IssueEntity,
  MembershipEntity,
  ProjectEntity,
  ReleaseEntity,
  SavedViewEntity,
  TeamEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { PublicViewsController } from './public-views.controller.js';
import {
  PUBLIC_VIEW_LIMIT,
  PUBLIC_VIEW_SCAN_LIMIT,
  PublicViewsService,
} from './public-views.service.js';
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
  labels: ['lb_ui', 'lb_gone'],
  updatedAt: new Date('2026-02-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over,
});

function setup(
  view: Partial<SavedViewEntity> | null,
  issues: Record<string, unknown>[] = [],
  demandRows: {
    requests?: Record<string, unknown>[];
    customers?: Record<string, unknown>[];
  } = {},
) {
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
  const repo = {
    findOneBy: vi.fn(async (where: { publicTokenHash: string }) =>
      row && where.publicTokenHash === row.publicTokenHash ? row : null,
    ),
  };
  const find = vi.fn(
    async (opts?: { where?: { workspaceId?: string }; take?: number }) => {
      // Every query must be scoped to the view's workspace.
      if (opts?.where) expect(opts.where.workspaceId).toBe('w1');
      return issues;
    },
  );
  const decisionFind = vi.fn(
    async (opts?: { where?: { workspaceId?: string }; take?: number }) => {
      if (opts?.where) expect(opts.where.workspaceId).toBe('w1');
      return view?.entity === 'decision' ? issues : [];
    },
  );
  const projectFind = vi.fn(
    async (opts?: { where?: { workspaceId?: string }; take?: number }) => {
      if (opts?.where) expect(opts.where.workspaceId).toBe('w1');
      return view?.entity === 'project'
        ? issues
        : [{ id: 'p1', name: 'Apollo' }];
    },
  );
  const customerRequestFind = vi.fn(
    async (_options?: unknown) => demandRows.requests ?? [],
  );
  const customerFind = vi.fn(
    async (_options?: unknown) => demandRows.customers ?? [],
  );
  const teamFind = vi.fn(async (_options?: unknown) => [
    { id: 't1', name: 'Platform' },
    { id: 't2', name: 'Other' },
  ]);
  const releaseFind = vi.fn(async (_options?: unknown) => [
    { id: 'rel_1', name: 'v1.4.0' },
  ]);
  const membershipFind = vi.fn(async (_options?: unknown) => [
    { userId: 'u1' },
  ]);
  const userFind = vi.fn(async (_options?: unknown) => [
    {
      id: 'u1',
      name: 'Ada',
      email: 'ada@example.com',
      passwordHash: 'x',
    },
  ]);
  const tables = new Map<unknown, unknown>([
    [IssueEntity, { find }],
    [DecisionEntity, { find: decisionFind }],
    [CustomerRequestEntity, { find: customerRequestFind }],
    [CustomerEntity, { find: customerFind }],
    [ProjectEntity, { find: projectFind }],
    [ReleaseEntity, { find: releaseFind }],
    [TeamEntity, { find: teamFind }],
    [MembershipEntity, { find: membershipFind }],
    [UserEntity, { find: userFind }],
    [
      WorkspaceEntity,
      {
        findOneBy: async () => ({
          id: 'w1',
          name: 'Acme',
          settings: {
            labels: [
              { id: 'lb_ui', name: 'UI', color: '#2563eb', template: false },
            ],
          },
        }),
      },
    ],
  ]);
  const ds = {
    getRepository: (e: unknown) => tables.get(e) ?? { find: async () => [] },
  };
  return {
    token,
    service: new PublicViewsService(ds as never, repo as never),
    repo,
    find,
    decisionFind,
    projectFind,
    customerRequestFind,
    customerFind,
    teamFind,
    releaseFind,
    membershipFind,
    userFind,
  };
}

describe('PublicViewsService', () => {
  it('returns the fixed result of the view with a minimal projection', async () => {
    const { token, service } = setup({}, [
      issue(1),
      issue(2, { status: 'done' }),
      issue(3),
    ]);
    const out = await service.get(token);
    expect(out).toMatchObject({
      name: 'Open bugs',
      entity: 'issue',
      layout: 'list',
      workspaceName: 'Acme',
      total: 2,
      truncated: false,
    });
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
    for (const secret of [
      'PRIVATE BODY',
      'Secret Reporter',
      'u9',
      'internal.example',
      'ada@example.com',
      'passwordHash',
      'workspaceId',
      'w1',
      'Other',
      'ownerId',
      'filters',
      'publicToken',
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('groups by the view grouping with resolved names, or by status on a board', async () => {
    const issues = [
      issue(1),
      issue(2, { teamId: null }),
      issue(3, { teamId: 't1' }),
    ];
    const byTeam = setup({ groupBy: 'teamId' }, issues);
    const grouped = await byTeam.service.get(byTeam.token);
    expect(grouped.groupBy).toBe('teamId');
    expect(grouped.groups.map((g) => [g.key, g.label, g.items.length])).toEqual(
      [
        ['t1', 'Platform', 2],
        ['', '', 1],
      ],
    );
    const board = setup({ layout: 'board', filters: [] }, [
      issue(1),
      issue(2, { status: 'done' }),
    ]);
    const out = await board.service.get(board.token);
    expect(out.groupBy).toBe('status');
    expect(out.groups.map((g) => g.key)).toEqual(['todo', 'done']);
  });

  it('applies the view sort and direct Issue project filter', async () => {
    const s = setup(
      {
        filters: [{ field: 'projectId', op: 'is', value: 'p1' }],
        sort: { field: 'title', direction: 'desc' },
      },
      [issue(1, { projectId: 'p1' }), issue(2), issue(3, { projectId: 'p1' })],
    );
    const out = await s.service.get(s.token);
    expect(out.groups[0].items.map((i) => i.key)).toEqual(['BUG-3', 'BUG-1']);
  });

  it('filters and groups issues by release with resolved names', async () => {
    const filtered = setup(
      { filters: [{ field: 'releaseId', op: 'is', value: 'rel_1' }] },
      [
        issue(1, { releaseId: 'rel_1' }),
        issue(2),
        issue(3, { releaseId: 'rel_1' }),
      ],
    );
    const filteredOut = await filtered.service.get(filtered.token);
    expect(filteredOut.groups[0].items.map((i) => i.key)).toEqual([
      'BUG-1',
      'BUG-3',
    ]);

    const grouped = setup({ groupBy: 'releaseId', filters: [] }, [
      issue(1, { releaseId: 'rel_1' }),
      issue(2),
      issue(3, { releaseId: 'rel_1' }),
    ]);
    const groupedOut = await grouped.service.get(grouped.token);
    expect(
      groupedOut.groups.map((g) => [g.key, g.label, g.items.length]),
    ).toEqual([
      ['rel_1', 'v1.4.0', 2],
      ['', '', 1],
    ]);
  });

  it('scopes demand reads to the target issues and projects', async () => {
    const request = {
      id: 'crq_1',
      workspaceId: 'w1',
      customerId: 'cus_1',
      issueId: 'in_1',
      projectId: null,
      important: true,
    };
    const customer = {
      id: 'cus_1',
      tierId: 'tier_1',
      revenue: 100,
      size: 10,
    };
    const issueView = setup({}, [issue(1)], {
      requests: [request],
      customers: [customer],
    });
    await issueView.service.get(issueView.token);
    const issueRequestQuery = issueView.customerRequestFind.mock
      .calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(issueRequestQuery.where.workspaceId).toBe('w1');
    expect(issueRequestQuery.where.issueId).toBeDefined();
    expect(issueRequestQuery.where.projectId).toBeUndefined();

    const projectView = setup(
      { entity: 'project', filters: [] },
      [issue(1, { projectId: 'p1' })],
      { requests: [request], customers: [customer] },
    );
    await projectView.service.get(projectView.token);
    const projectRequestQuery = projectView.customerRequestFind.mock
      .calls[0]?.[0] as {
      where: Record<string, unknown>[];
    };
    expect(projectRequestQuery.where).toHaveLength(2);
    expect(projectRequestQuery.where).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: 'w1',
          projectId: expect.anything(),
        }),
        expect.objectContaining({
          workspaceId: 'w1',
          issueId: expect.anything(),
        }),
      ]),
    );
    for (const service of [issueView, projectView])
      expect(service.customerFind).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: 'w1',
            id: expect.anything(),
          }),
        }),
      );
  });

  it('loads reference names only for returned rows and requested groups', async () => {
    const s = setup({ filters: [], groupBy: 'releaseId' }, [
      issue(1, { projectId: 'p1', releaseId: 'rel_1' }),
    ]);
    await s.service.get(s.token);

    for (const find of [s.teamFind, s.projectFind, s.releaseFind]) {
      expect(find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            workspaceId: 'w1',
            id: expect.anything(),
          }),
          take: PUBLIC_VIEW_SCAN_LIMIT + 1,
        }),
      );
    }
    expect(s.userFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: expect.anything() }),
        take: PUBLIC_VIEW_SCAN_LIMIT + 1,
      }),
    );
    expect(s.membershipFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: expect.anything() }),
      }),
    );
  });

  it('bounds customer-demand reads as well as candidate rows', async () => {
    const requests = Array.from(
      { length: PUBLIC_VIEW_SCAN_LIMIT + 1 },
      (_, i) => ({
        id: `cr_${i}`,
        workspaceId: 'w1',
        customerId: 'cus_1',
        issueId: 'in_1',
        projectId: null,
        important: false,
      }),
    );
    const s = setup({}, [issue(1)], { requests });

    await expect(s.service.get(s.token)).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('20,000-row evaluation limit'),
    });
    expect(s.customerRequestFind).toHaveBeenCalledWith(
      expect.objectContaining({ take: PUBLIC_VIEW_SCAN_LIMIT + 1 }),
    );
    expect(s.customerFind).not.toHaveBeenCalled();
  });

  it('truncates long results', async () => {
    const many = Array.from({ length: PUBLIC_VIEW_LIMIT + 5 }, (_, i) =>
      issue(i + 1),
    );
    const s = setup({}, many);
    const out = await s.service.get(s.token);
    expect(out.total).toBe(PUBLIC_VIEW_LIMIT + 5);
    expect(out.truncated).toBe(true);
    expect(out.groups[0].items).toHaveLength(PUBLIC_VIEW_LIMIT);
  });

  it.each(['issue', 'decision', 'project'] as const)(
    'rejects %s views that exceed the bounded evaluation size',
    async (entity) => {
      const rows = Array.from(
        { length: PUBLIC_VIEW_SCAN_LIMIT + 1 },
        (_, i) => ({ id: `row_${i}`, workspaceId: 'w1' }),
      );
      const s = setup({ entity, filters: [] }, rows);
      const find =
        entity === 'issue'
          ? s.find
          : entity === 'decision'
            ? s.decisionFind
            : s.projectFind;

      await expect(s.service.get(s.token)).rejects.toMatchObject({
        status: 422,
        message: expect.stringContaining('20,000-row evaluation limit'),
      });
      expect(find).toHaveBeenCalledWith({
        where: { workspaceId: 'w1' },
        take: PUBLIC_VIEW_SCAN_LIMIT + 1,
      });
      expect(s.customerRequestFind).not.toHaveBeenCalled();
    },
  );

  it('returns exact totals at the evaluation limit without truncating evaluation', async () => {
    const rows = Array.from({ length: PUBLIC_VIEW_SCAN_LIMIT }, (_, i) => ({
      id: `dc_${i}`,
      workspaceId: 'w1',
      key: `DEC-${i}`,
      title: `Decision ${i}`,
      status: 'todo',
      tags: [],
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    }));
    const s = setup({ entity: 'decision', filters: [] }, rows);
    const out = await s.service.get(s.token);

    expect(s.decisionFind).toHaveBeenCalledWith({
      where: { workspaceId: 'w1' },
      take: PUBLIC_VIEW_SCAN_LIMIT + 1,
    });
    expect(out.total).toBe(PUBLIC_VIEW_SCAN_LIMIT);
    expect(out.truncated).toBe(true);
    expect(out.groups[0].items).toHaveLength(PUBLIC_VIEW_LIMIT);
  });

  it('answers 404 for malformed, unknown, revoked and no-longer-public tokens', async () => {
    const s = setup({}, [issue(1)]);
    for (const bad of [
      '',
      'nope',
      'vt_x',
      generatePublicToken(),
      `${s.token}x`,
    ]) {
      await expect(s.service.get(bad)).rejects.toMatchObject({ status: 404 });
    }
    const workspaceOnly = setup(
      { sharing: { visibility: 'workspace', grants: [] } },
      [issue(1)],
    );
    await expect(
      workspaceOnly.service.get(workspaceOnly.token),
    ).rejects.toMatchObject({ status: 404 });
    const revoked = setup({ publicTokenHash: null }, [issue(1)]);
    await expect(revoked.service.get(revoked.token)).rejects.toMatchObject({
      status: 404,
    });
    expect(revoked.find).not.toHaveBeenCalled();
  });

  it('does not touch the database for a malformed token', async () => {
    const s = setup({}, []);
    await expect(s.service.get('../../etc/passwd')).rejects.toMatchObject({
      status: 404,
    });
    expect(s.repo.findOneBy).not.toHaveBeenCalled();
  });
});

describe('PublicViewsController', () => {
  it('is a single public, read-only GET taking only the token', () => {
    const proto = PublicViewsController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, PublicViewsController)).toBe(
      'public/views',
    );
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, proto.get)).toBe(true);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.get)).toBe(
      RequestMethod.GET,
    );
    expect(Reflect.getMetadata(PATH_METADATA, proto.get)).toBe(':token');
    const handlers = Object.getOwnPropertyNames(proto).filter(
      (n) => n !== 'constructor',
    );
    expect(handlers).toEqual(['get']);
    expect(proto.get.length).toBe(1);
  });
});
