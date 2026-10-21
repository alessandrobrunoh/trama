import { describe, expect, it, vi } from 'vitest';
import { IssueEntity, ProjectEntity } from '../database/entities/index.js';
import { ProjectsService } from './projects.service.js';

const actor = { type: 'user' as const, id: 'usr_me' };

function project(over: Partial<ProjectEntity> = {}): ProjectEntity {
  return {
    id: 'pj_1',
    workspaceId: 'ws_1',
    name: 'Cora',
    key: 'CORA',
    summary: null,
    description: null,
    color: '#6b7280',
    icon: null,
    status: 'backlog',
    priority: 'none',
    leadId: null,
    teamIds: [],
    repositoryIds: [],
    labels: [],
    startDate: null,
    targetDate: null,
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as ProjectEntity;
}

function dependencies(
  opts: {
    existing?: ProjectEntity[];
    manager?: Record<string, unknown>;
  } = {},
) {
  const rows = [...(opts.existing ?? [])];
  const repo = {
    find: vi.fn(async () => rows.map(({ key }) => ({ key }))),
    findOneBy: vi.fn(
      async (where: { id?: string; key?: string }) =>
        rows.find((row) => row.id === where.id || row.key === where.key) ??
        null,
    ),
    create: vi.fn((value: unknown) => value),
    save: vi.fn(async (row: ProjectEntity) => {
      rows.push(row);
      return row;
    }),
  };
  const record = vi.fn(async (_event: { type: string }) => undefined);
  const refs = {
    teams: vi.fn(async () => undefined),
    repositories: vi.fn(async () => undefined),
    users: vi.fn(async () => undefined),
  };
  const labels = { assign: vi.fn(async () => undefined) };
  const dataSource = {
    getRepository: vi.fn(() => ({ findOneBy: vi.fn(async () => null) })),
    transaction: vi.fn(async (run: (manager: unknown) => Promise<unknown>) =>
      run(opts.manager ?? {}),
    ),
  };
  const service = new ProjectsService(
    dataSource as never,
    refs as never,
    { nextAbove: vi.fn(async () => 1), next: vi.fn(async () => 1) } as never,
    { record } as never,
    labels as never,
    repo as never,
  );
  return { service, rows, repo, record, refs, dataSource };
}

describe('ProjectsService project tags', () => {
  it('suggests tags on create and accepts an edited tag', async () => {
    const { service, rows } = dependencies();

    await service.create('ws_1', actor, { name: 'Trama' });
    await service.create('ws_1', actor, { name: 'Project delta', key: 'DLTA' });

    expect(rows.map((row) => row.key)).toEqual(['TRMA', 'DLTA']);
  });

  it('reserves prefixes that belong to unassigned issues and decisions', async () => {
    const { service } = dependencies();

    await expect(
      service.create('ws_1', actor, { name: 'Decision records', key: 'ADR' }),
    ).rejects.toThrow(/reserved for decision identifiers/);
    await expect(
      service.create('ws_1', actor, { name: 'Unassigned', key: 'UNPR' }),
    ).rejects.toThrow(/reserved for issues without a project/);
  });

  it('re-keys the project issues and keeps old keys as aliases when the tag changes', async () => {
    const row = project();
    const issue = {
      id: 'in_1',
      workspaceId: 'ws_1',
      key: 'CORA-8',
      number: 8,
      aliases: ['BUG-3'],
      projectId: row.id,
      updatedAt: new Date(0),
      createdAt: new Date(0),
    } as IssueEntity;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT "key" FROM "projects"'))
        return [{ key: 'CORA' }];
      if (sql.includes('"workspace_counters"')) return [];
      if (sql.includes('regexp_match')) return [{ floor: 0 }];
      return [];
    });
    const issueQuery = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      addOrderBy: vi.fn().mockReturnThis(),
      setLock: vi.fn().mockReturnThis(),
      getMany: vi.fn(async () => [issue]),
    };
    const manager = {
      query,
      getRepository: vi.fn((entity: unknown) =>
        entity === IssueEntity ? { createQueryBuilder: () => issueQuery } : {},
      ),
      save: vi.fn(async (_entity: unknown, value: unknown) => value),
    };
    const { service, record } = dependencies({
      existing: [row],
      manager,
    });

    await service.update('ws_1', actor, row.id, { key: 'TRMA' });

    expect(row.key).toBe('TRMA');
    expect(issue).toMatchObject({
      key: 'TRMA-1',
      number: 1,
      aliases: ['BUG-3', 'CORA-8'],
      projectId: row.id,
    });
    expect(record.mock.calls.map(([event]) => event.type)).toEqual([
      'issue.rekeyed',
      'project.updated',
    ]);
    expect(manager.save).toHaveBeenCalledWith(ProjectEntity, row);
    expect(manager.save).toHaveBeenCalledWith(IssueEntity, [issue]);
  });
});
