import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { IssueEntity } from '../database/entities/index.js';
import { ReleaseEntity } from '../database/entities/index.js';
import { IssuesService } from './issues.service.js';

const ACTOR = { type: 'user' as const, id: 'usr_me' };

function issue(id: string, over: Partial<IssueEntity> = {}): IssueEntity {
  return {
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
    projectId: 'pj_1',
    parentId: null,
    duplicateOfId: null,
    milestoneIds: [],
    releaseId: null,
    labels: [],
    aliases: [],
    startedAt: null,
    completedAt: null,
    updatedAt: new Date(0),
    ...over,
  } as IssueEntity;
}

function setup(opts: {
  issues?: IssueEntity[];
  releases?: { id: string; workspaceId: string; status: string }[];
}) {
  const persisted = new Map((opts.issues ?? []).map((row) => [row.id, row]));
  const releases = opts.releases ?? [];
  const save = vi.fn(async (row: IssueEntity) => {
    persisted.set(row.id, row);
    return row;
  });
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM "workspaces"')) return [];
    if (sql.includes('"id" = ANY')) {
      const ids = params?.[1] as string[];
      return ids.flatMap((id) => {
        const row = persisted.get(id);
        return row
          ? [
              {
                id: row.id,
                teamId: row.teamId,
                projectId: row.projectId,
                parentId: row.parentId,
              },
            ]
          : [];
      });
    }
    if (sql.includes('"id" = $2')) {
      const id = params?.[1] as string;
      const row = persisted.get(id);
      return row
        ? [
            {
              id: row.id,
              teamId: row.teamId,
              projectId: row.projectId,
              parentId: row.parentId,
            },
          ]
        : [];
    }
    return [];
  });
  const manager = {
    query,
    save,
    create: (_e: unknown, x: unknown) => x,
  };
  const service = new IssuesService(
    {
      transaction: (run: (m: unknown) => Promise<unknown>) => run(manager),
      getRepository: (entity: unknown) => {
        if (entity === ReleaseEntity)
          return {
            findOneBy: async (where: { id: string; workspaceId: string }) =>
              releases.find(
                (row) =>
                  row.id === where.id && row.workspaceId === where.workspaceId,
              ) ?? null,
          };
        return { findOneBy: async () => null, findBy: async () => [] };
      },
    } as never,
    {
      teams: async () => undefined,
      users: async () => undefined,
      projects: async () => undefined,
    } as never,
    { next: async () => 1 } as never,
    { record: vi.fn(async () => undefined) } as never,
    { assign: vi.fn(async () => []) } as never,
    {
      findOneBy: async ({ id }: { id: string }) => persisted.get(id) ?? null,
    } as never,
  );
  return { service, save, persisted };
}

describe('IssuesService release assignment', () => {
  it('assigns an issue to a draft release in the same workspace', async () => {
    const child = issue('in_1');
    const { service, persisted } = setup({
      issues: [child],
      releases: [{ id: 'rel_1', workspaceId: 'ws_1', status: 'draft' }],
    });
    await service.update('ws_1', ACTOR, 'in_1', { releaseId: 'rel_1' }, async () => undefined);
    expect(persisted.get('in_1')?.releaseId).toBe('rel_1');
  });

  it('rejects a release from another workspace', async () => {
    const { service } = setup({
      issues: [issue('in_1')],
      releases: [{ id: 'rel_other', workspaceId: 'ws_2', status: 'draft' }],
    });
    await expect(
      service.update(
        'ws_1',
        ACTOR,
        'in_1',
        { releaseId: 'rel_other' },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects joining a released or unknown release', async () => {
    const { service } = setup({
      issues: [issue('in_1')],
      releases: [{ id: 'rel_1', workspaceId: 'ws_1', status: 'released' }],
    });
    await expect(
      service.update(
        'ws_1',
        ACTOR,
        'in_1',
        { releaseId: 'rel_1' },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(
        'ws_1',
        ACTOR,
        'in_1',
        { releaseId: 'rel_missing' },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears the assignment', async () => {
    const { service, persisted } = setup({
      issues: [issue('in_1', { releaseId: 'rel_1' })],
      releases: [{ id: 'rel_1', workspaceId: 'ws_1', status: 'draft' }],
    });
    await service.update('ws_1', ACTOR, 'in_1', { releaseId: null }, async () => undefined);
    expect(persisted.get('in_1')?.releaseId).toBeNull();
  });
});
