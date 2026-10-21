import { describe, expect, it, vi } from 'vitest';
import type { IssueEntity } from '../database/entities/index.js';
import { IssuesService } from './issues.service.js';

const actor = { type: 'user' as const, id: 'usr_me' };

function setup() {
  const row = {
    id: 'in_1',
    workspaceId: 'ws_1',
    key: 'CORA-8',
    number: 8,
    kind: 'bug',
    title: 'Login issue',
    status: 'todo',
    priority: 'none',
    assigneeId: null,
    teamId: null,
    projectId: 'pj_cora',
    parentId: null,
    duplicateOfId: null,
    milestoneIds: [],
    labels: [],
    aliases: ['BUG-3'],
    startedAt: null,
    completedAt: null,
    updatedAt: new Date(0),
  } as IssueEntity;
  let relation = {
    id: row.id,
    teamId: row.teamId,
    projectId: row.projectId,
    parentId: row.parentId,
    key: row.key,
    number: row.number,
    aliases: row.aliases,
  };
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM "projects"')) return [{ key: 'TRMA' }];
    if (sql.includes('FROM "workspace_counters"')) return [{ value: 0 }];
    if (sql.includes('FROM "issues"')) return [relation];
    return [];
  });
  const save = vi.fn(async (issue: IssueEntity) => {
    relation = {
      id: issue.id,
      teamId: issue.teamId,
      projectId: issue.projectId,
      parentId: issue.parentId,
      key: issue.key,
      number: issue.number,
      aliases: issue.aliases,
    };
    return issue;
  });
  const manager = { query, save };
  const record = vi.fn(async (_event: { type: string }) => undefined);
  const next = vi.fn(async () => 1);
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
    { next } as never,
    { record } as never,
    { assign: vi.fn(async () => []) } as never,
    { findOneBy: async () => row } as never,
  );
  return { service, row, record, next, query };
}

describe('IssuesService project issue keys', () => {
  it('re-keys an issue when its project changes and retains the former key', async () => {
    const { service, row, record } = setup();

    await service.update(
      'ws_1',
      actor,
      row.id,
      { projectId: 'pj_trama' },
      async () => undefined,
    );

    expect(row).toMatchObject({
      projectId: 'pj_trama',
      key: 'TRMA-1',
      number: 1,
      aliases: ['BUG-3', 'CORA-8'],
    });
    expect(record.mock.calls.map(([event]) => event.type)).toEqual([
      'issue.rekeyed',
      'issue.updated',
    ]);
  });

  it('does not re-key when only the issue kind changes', async () => {
    const { service, row, record, next } = setup();

    await service.update(
      'ws_1',
      actor,
      row.id,
      { kind: 'feature' },
      async () => undefined,
    );

    expect(row).toMatchObject({
      kind: 'feature',
      key: 'CORA-8',
      aliases: ['BUG-3'],
    });
    expect(next).not.toHaveBeenCalled();
    expect(record.mock.calls.map(([event]) => event.type)).toEqual([
      'issue.updated',
    ]);
  });
});
