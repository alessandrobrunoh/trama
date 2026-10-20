import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource, Repository } from 'typeorm';
import {
  defaultStatusCatalog,
  type ActorRef,
  type StatusCatalog,
} from '../contracts/domain.js';
import {
  IssueEntity,
  type ReleaseEntity,
  type ReleasePipelineEntity,
  TeamEntity,
} from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import type { IssuesService } from '../issues/issues.service.js';
import { loadStatusCatalog } from '../status/status-catalog.js';
import {
  nextDraftReleaseName,
  ReleasesService,
} from './releases.service.js';

vi.mock('../status/status-catalog.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../status/status-catalog.js')>();
  return { ...actual, loadStatusCatalog: vi.fn(actual.loadStatusCatalog) };
});

const ACTOR: ActorRef = { type: 'user', id: 'usr_1' };
const WS = 'ws_1';

function catalog(issue: StatusCatalog['issue']): StatusCatalog {
  return { issue, project: [], decision: [], projectHealth: [] };
}

const TODO = {
  id: 'todo',
  name: 'Todo',
  icon: 'circle',
  color: '#5f6a7a',
  type: 'todo' as const,
};
const DONE = {
  id: 'done',
  name: 'Done',
  icon: 'circle-check',
  color: '#28793f',
  type: 'done' as const,
};

function memoryRepo<T extends { id: string }>(rows: T[]) {
  const matches = (row: T, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
  return {
    create: (x: Partial<T>) => ({ ...x } as T),
    save: async (x: T) => {
      const i = rows.findIndex((r) => r.id === x.id);
      if (i >= 0) rows[i] = x;
      else rows.push(x);
      return x;
    },
    find: async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => matches(r, where)),
    findOneBy: async (where: Record<string, unknown>) =>
      rows.find((r) => matches(r, where)) ?? null,
    findBy: async (where: Record<string, unknown>) =>
      rows.filter((r) => matches(r, where)),
    countBy: async (where: Record<string, unknown>) =>
      rows.filter((r) => matches(r, where)).length,
    delete: async (where: Record<string, unknown>) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
    },
  } as unknown as Repository<T>;
}

function setup(opts: {
  pipelines?: Partial<ReleasePipelineEntity>[];
  releases?: Partial<ReleaseEntity>[];
  issues?: Partial<IssueEntity>[];
  teams?: string[];
} = {}) {
  const pipelines = (opts.pipelines ?? []).map(
    (p) =>
      ({
        id: 'rpl_1',
        workspaceId: WS,
        name: 'App',
        type: 'continuous',
        teamId: null,
        moveOpenIssuesToNext: false,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...p,
      }) as ReleasePipelineEntity,
  );
  const releases = (opts.releases ?? []).map(
    (r) =>
      ({
        id: 'rel_1',
        workspaceId: WS,
        pipelineId: 'rpl_1',
        name: 'v1.0.0',
        status: 'draft',
        notes: null,
        targetAt: null,
        releasedAt: null,
        createdAt: new Date('2026-01-02'),
        updatedAt: new Date('2026-01-02'),
        ...r,
      }) as ReleaseEntity,
  );
  const issues = (opts.issues ?? []).map(
    (i) =>
      ({
        id: 'in_1',
        workspaceId: WS,
        key: 'BUG-1',
        status: 'todo',
        releaseId: 'rel_1',
        ...i,
      }) as IssueEntity,
  );
  const updateMany = vi.fn(async (_w: string, _a: ActorRef, rows: IssueEntity[]) => rows);
  const record = vi.fn(async () => ({}));
  const issueUpdate = vi.fn(async () => undefined);
  const teams = new Set(opts.teams ?? []);
  const ds = {
    getRepository: (entity: unknown) => {
      if (entity === IssueEntity)
        return {
          findBy: async (where: Record<string, unknown>) =>
            issues.filter((i) =>
              Object.entries(where).every(
                ([k, v]) => (i as Record<string, unknown>)[k] === v,
              ),
            ),
          update: issueUpdate,
        };
      if (entity === TeamEntity)
        return {
          existsBy: async (where: { id: string; workspaceId: string }) =>
            where.workspaceId === WS && teams.has(where.id),
        };
      return {};
    },
    query: async () => [] as { id: string; n: number }[],
  } as unknown as DataSource;
  const service = new ReleasesService(
    ds,
    { record } as unknown as EventsService,
    { updateMany } as unknown as IssuesService,
    memoryRepo(pipelines),
    memoryRepo(releases),
  );
  return { service, pipelines, releases, issues, updateMany, record, issueUpdate };
}

describe('nextDraftReleaseName', () => {
  it('bumps a patch version and otherwise appends next', () => {
    expect(nextDraftReleaseName('v1.4.0')).toBe('v1.4.1');
    expect(nextDraftReleaseName('1.0.9')).toBe('1.0.10');
    expect(nextDraftReleaseName('Sprint 12')).toBe('Sprint 12 next');
  });
});

describe('ReleasesService pipelines', () => {
  it('creates, lists, updates and deletes an empty pipeline', async () => {
    const { service, pipelines, record } = setup();
    const created = await service.createPipeline(WS, ACTOR, { name: ' App ' });
    expect(created).toMatchObject({
      name: 'App',
      type: 'continuous',
      moveOpenIssuesToNext: false,
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'release_pipeline.created' }),
    );
    expect(await service.listPipelines(WS)).toHaveLength(1);
    const updated = await service.updatePipeline(WS, ACTOR, created.id, {
      type: 'scheduled',
      moveOpenIssuesToNext: true,
    });
    expect(updated).toMatchObject({ type: 'scheduled', moveOpenIssuesToNext: true });
    await service.removePipeline(WS, ACTOR, created.id);
    expect(pipelines).toHaveLength(0);
  });

  it('rejects an unknown team and a missing pipeline', async () => {
    const { service } = setup();
    await expect(
      service.createPipeline(WS, ACTOR, { name: 'App', teamId: 'tm_x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.getPipeline(WS, 'rpl_missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to delete a pipeline that still has draft or released releases', async () => {
    const { service } = setup({
      pipelines: [{ id: 'rpl_1' }],
      releases: [{ id: 'rel_1', status: 'draft' }],
    });
    await expect(service.removePipeline(WS, ACTOR, 'rpl_1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const canceled = setup({
      pipelines: [{ id: 'rpl_1' }],
      releases: [{ id: 'rel_1', status: 'canceled' }],
    });
    await canceled.service.removePipeline(WS, ACTOR, 'rpl_1');
    expect(canceled.pipelines).toHaveLength(0);
    expect(canceled.releases).toHaveLength(0);
  });
});

describe('ReleasesService releases', () => {
  it('creates a draft in a pipeline and lists it', async () => {
    const { service } = setup({ pipelines: [{ id: 'rpl_1' }] });
    const row = await service.createRelease(WS, ACTOR, {
      pipelineId: 'rpl_1',
      name: ' v1.0.0 ',
    });
    expect(row).toMatchObject({
      name: 'v1.0.0',
      status: 'draft',
      pipelineId: 'rpl_1',
      issueCount: 0,
    });
    const listed = await service.listReleases(WS, { pipelineId: 'rpl_1' });
    expect(listed).toHaveLength(1);
  });

  it('does not mark a release released via PATCH', async () => {
    const { service } = setup({
      pipelines: [{ id: 'rpl_1' }],
      releases: [{ id: 'rel_1', status: 'draft' }],
    });
    await expect(
      service.updateRelease(WS, ACTOR, 'rel_1', { status: 'released' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ReleasesService.complete', () => {
  beforeEach(() => {
    vi.mocked(loadStatusCatalog).mockResolvedValue(defaultStatusCatalog());
  });

  it('marks the release released without moving issues when not requested', async () => {
    const { service, updateMany, releases } = setup({
      pipelines: [{ id: 'rpl_1', type: 'continuous' }],
      releases: [{ id: 'rel_1', status: 'draft', name: 'v1.0.0' }],
      issues: [{ id: 'in_1', status: 'todo', releaseId: 'rel_1' }],
    });
    const row = await service.complete(WS, ACTOR, 'rel_1');
    expect(row.status).toBe('released');
    expect(row.releasedAt).toBeInstanceOf(Date);
    expect(updateMany).not.toHaveBeenCalled();
    expect(releases[0].status).toBe('released');
  });

  it('moves open issues to the workspace done status when requested', async () => {
    const { service, updateMany } = setup({
      pipelines: [{ id: 'rpl_1' }],
      releases: [{ id: 'rel_1', status: 'draft' }],
      issues: [
        { id: 'in_open', status: 'todo', releaseId: 'rel_1' },
        { id: 'in_done', status: 'done', releaseId: 'rel_1' },
      ],
    });
    await service.complete(WS, ACTOR, 'rel_1', { moveOpenIssuesToDone: true });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const moved = updateMany.mock.calls[0][2] as IssueEntity[];
    expect(moved.map((i) => i.id)).toEqual(['in_open']);
    expect(updateMany.mock.calls[0][3]).toEqual({ status: 'done' });
  });

  it('requires targetStatusId when the catalog has no done status', async () => {
    vi.mocked(loadStatusCatalog).mockResolvedValue(catalog([TODO]));
    const { service, updateMany } = setup({
      pipelines: [{ id: 'rpl_1' }],
      releases: [{ id: 'rel_1', status: 'draft' }],
      issues: [{ id: 'in_1', status: 'todo', releaseId: 'rel_1' }],
    });
    await expect(
      service.complete(WS, ACTOR, 'rel_1', { moveOpenIssuesToDone: true }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('targetStatusId'),
    });
    expect(updateMany).not.toHaveBeenCalled();
    const shipped = { ...DONE, id: 'st_shipped' };
    vi.mocked(loadStatusCatalog).mockResolvedValue(catalog([TODO, shipped]));
    const again = setup({
      pipelines: [{ id: 'rpl_1' }],
      releases: [{ id: 'rel_1', status: 'draft' }],
      issues: [{ id: 'in_1', status: 'todo', releaseId: 'rel_1' }],
    });
    await again.service.complete(WS, ACTOR, 'rel_1', {
      moveOpenIssuesToDone: true,
      targetStatusId: 'st_shipped',
    });
    expect(again.updateMany.mock.calls[0][3]).toEqual({ status: 'st_shipped' });
  });

  it('moves leftover open issues to the next draft, creating one if needed', async () => {
    const { service, issueUpdate, releases } = setup({
      pipelines: [{ id: 'rpl_1', type: 'scheduled', moveOpenIssuesToNext: true }],
      releases: [{ id: 'rel_1', status: 'draft', name: 'v1.0.0' }],
      issues: [{ id: 'in_1', key: 'BUG-1', status: 'todo', releaseId: 'rel_1' }],
    });
    await service.complete(WS, ACTOR, 'rel_1');
    expect(releases.map((r) => r.status).sort()).toEqual(['draft', 'released']);
    const next = releases.find((r) => r.status === 'draft');
    expect(next?.name).toBe('v1.0.1');
    expect(issueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({ releaseId: next!.id }),
    );
  });

  it('reuses an existing next draft instead of creating another', async () => {
    const { service, issueUpdate, releases } = setup({
      pipelines: [{ id: 'rpl_1', type: 'scheduled', moveOpenIssuesToNext: true }],
      releases: [
        { id: 'rel_1', status: 'draft', name: 'v1.0.0', createdAt: new Date('2026-01-02') },
        { id: 'rel_next', status: 'draft', name: 'v1.1.0', createdAt: new Date('2026-01-03') },
      ],
      issues: [{ id: 'in_1', status: 'in_progress', releaseId: 'rel_1' }],
    });
    await service.complete(WS, ACTOR, 'rel_1');
    expect(releases.filter((r) => r.status === 'draft')).toHaveLength(1);
    expect(issueUpdate.mock.calls[0][1]).toMatchObject({ releaseId: 'rel_next' });
  });

  it('refuses completing a canceled or already released release', async () => {
    const canceled = setup({
      pipelines: [{ id: 'rpl_1' }],
      releases: [{ id: 'rel_1', status: 'canceled' }],
    });
    await expect(canceled.service.complete(WS, ACTOR, 'rel_1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const released = setup({
      pipelines: [{ id: 'rpl_1' }],
      releases: [{ id: 'rel_1', status: 'released' }],
    });
    await expect(released.service.complete(WS, ACTOR, 'rel_1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
