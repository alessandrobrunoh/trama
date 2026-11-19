import { BadRequestException } from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { RefsService } from '../common/refs.service.js';
import type { ArtifactEntity } from '../database/entities/index.js';
import type { EventsService } from '../events/events.service.js';
import { memberAccessStore } from '../auth/member-access.js';
import { ArtifactsService, isHttpUrl } from './artifacts.service.js';

const ACTOR = { type: 'user', id: 'u_1' } as const;

function setup(existing: Partial<ArtifactEntity> | null = null) {
  const record = vi.fn(async () => ({}));
  const row = existing
    ? ({
        id: 'ar_1',
        workspaceId: 'ws_1',
        kind: 'document',
        title: 'Doc',
        ...existing,
      } as ArtifactEntity)
    : null;
  const repo = {
    create: (x: Partial<ArtifactEntity>) => x as ArtifactEntity,
    save: async (x: ArtifactEntity) => x,
    findOneBy: async () => row,
  } as unknown as Repository<ArtifactEntity>;
  const exists = {
    existsBy: async () => true,
    findOne: async () => ({ projectId: null }),
  };
  const ds = {
    getRepository: () => exists,
    query: async () => [],
  } as unknown as DataSource;
  const refs = {
    repositories: async () => undefined,
  } as unknown as RefsService;
  const service = new ArtifactsService(
    ds,
    refs,
    { record } as unknown as EventsService,
    repo,
  );
  return { service, record };
}

describe('isHttpUrl', () => {
  it('accepts only http(s) urls', () => {
    expect(isHttpUrl('https://example.com/a?b=1')).toBe(true);
    expect(isHttpUrl('http://localhost:3000')).toBe(true);
    for (const v of [
      '',
      null,
      undefined,
      'example.com',
      'ftp://example.com',
      'javascript:alert(1)',
    ])
      expect(isHttpUrl(v)).toBe(false);
  });
});

describe('ArtifactsService owners', () => {
  it('requires a task owner', async () => {
    const { service } = setup();
    await expect(
      service.create('ws_1', ACTOR, { kind: 'document', title: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'document',
        title: 'x',
        projectId: 'pj_1',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a valid http(s) url for a link', async () => {
    const { service } = setup();
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'link',
        title: 'x',
        issueId: 'in_1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'link',
        title: 'x',
        issueId: 'in_1',
        url: 'ftp://x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'link',
        title: 'x',
        issueId: 'in_1',
        url: 'https://x.test',
      }),
    ).resolves.toMatchObject({ kind: 'link', state: 'published' });
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'file',
        title: 'x',
        issueId: 'in_1',
        url: '/api/w/acme/uploads/upl_abcdefghijkl',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a document carry only a description, and reports the owner in the event', async () => {
    const { service, record } = setup();
    const row = await service.create('ws_1', ACTOR, {
      kind: 'document',
      title: 'Notes',
      description: ' why ',
      issueId: 'in_1',
    });
    expect(row).toMatchObject({ description: 'why', issueId: 'in_1' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'artifact.attached',
        data: expect.objectContaining({ issueId: 'in_1' }),
      }),
    );
  });

  it('refuses to detach the task owner', async () => {
    const { service, record } = setup({ issueId: 'in_1' });
    await expect(
      service.update('ws_1', ACTOR, 'ar_1', { issueId: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(record).not.toHaveBeenCalled();
  });

  it('moves an artifact to another task', async () => {
    const { service, record } = setup({ issueId: 'in_1' });
    await expect(
      service.update('ws_1', ACTOR, 'ar_1', { issueId: 'in_2' }),
    ).resolves.toMatchObject({ issueId: 'in_2' });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'artifact.updated',
        data: expect.objectContaining({ issueId: 'in_2' }),
      }),
    );
  });

  it('needs a title', async () => {
    const { service } = setup();
    await expect(
      service.create('ws_1', ACTOR, { kind: 'document', issueId: 'in_1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ArtifactsService issue artifact counts', () => {
  function withCount(count: number) {
    const query = {
      where: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getCount: vi.fn(async () => count),
    };
    const createQueryBuilder = vi.fn(() => query);
    const repo = {
      createQueryBuilder,
    } as unknown as Repository<ArtifactEntity>;
    const service = new ArtifactsService(
      {} as DataSource,
      {} as RefsService,
      {} as EventsService,
      repo,
    );
    return { service, query, createQueryBuilder };
  }

  it.each([0, 3])(
    'returns %i for an issue without loading its artifacts',
    async (count) => {
      const { service, query, createQueryBuilder } = withCount(count);

      await expect(service.countForIssue('ws_1', 'in_1')).resolves.toBe(count);

      expect(createQueryBuilder.mock.calls).toEqual([['a']]);
      expect(query.where).toHaveBeenCalledWith('a.workspaceId = :workspaceId', {
        workspaceId: 'ws_1',
      });
      expect(query.andWhere).toHaveBeenCalledWith('a.issueId = :issueId', {
        issueId: 'in_1',
      });
      expect(query.getCount).toHaveBeenCalledOnce();
    },
  );
});

describe('ArtifactsService issue-owner visibility', () => {
  it.each([true, false])(
    'does not treat an issue in a hidden project as unassigned (includeUnassigned=%s)',
    async (includeUnassigned) => {
      const artifact = {
        id: 'ar_hidden',
        workspaceId: 'ws_1',
        issueId: 'in_hidden',
      } as ArtifactEntity;
      const repo = {
        findOneBy: async () => artifact,
      } as unknown as Repository<ArtifactEntity>;
      const issueRepo = {
        findOne: async () => ({ projectId: 'pj_hidden' }),
      };
      const service = new ArtifactsService(
        { getRepository: () => issueRepo } as unknown as DataSource,
        {} as RefsService,
        {} as EventsService,
        repo,
      );
      const access = {
        projects: { all: false, projectIds: ['pj_visible'] },
        includeUnassigned,
        grants: [],
      };

      await memberAccessStore.run(access, async () => {
        await expect(service.get('ws_1', 'ar_hidden')).rejects.toMatchObject({
          status: 404,
        });
      });
    },
  );

  it('preserves truly unassigned artifacts when includeUnassigned is enabled', async () => {
    const artifact = {
      id: 'ar_unassigned',
      workspaceId: 'ws_1',
      issueId: null,
    } as ArtifactEntity;
    const service = new ArtifactsService(
      {} as DataSource,
      {} as RefsService,
      {} as EventsService,
      {
        findOneBy: async () => artifact,
      } as unknown as Repository<ArtifactEntity>,
    );
    const access = {
      projects: { all: false, projectIds: ['pj_visible'] },
      includeUnassigned: true,
      grants: [],
    };

    await memberAccessStore.run(access, async () => {
      await expect(service.get('ws_1', 'ar_unassigned')).resolves.toBe(
        artifact,
      );
    });
  });

  it.each([true, false])(
    'excludes hidden issue owners from lists (includeUnassigned=%s)',
    async (includeUnassigned) => {
      const query = {
        where: vi.fn().mockReturnThis(),
        andWhere: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        getMany: vi.fn(async () => []),
      };
      const createQueryBuilder = vi.fn(() => query);
      const service = new ArtifactsService(
        {} as DataSource,
        {} as RefsService,
        {} as EventsService,
        { createQueryBuilder } as unknown as Repository<ArtifactEntity>,
      );
      const access = {
        projects: { all: false, projectIds: ['pj_visible'] },
        includeUnassigned,
        grants: [],
      };

      await memberAccessStore.run(access, async () => {
        await service.list('ws_1');
      });

      expect(query.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('EXISTS (SELECT 1 FROM issues'),
        expect.objectContaining({ memberProjectIds: ['pj_visible'] }),
      );
    },
  );

  it.each([true, false])(
    'rejects attaching to a hidden issue (includeUnassigned=%s)',
    async (includeUnassigned) => {
      const issueRepo = {
        findOne: async () => ({ projectId: 'pj_hidden' }),
      };
      const service = new ArtifactsService(
        { getRepository: () => issueRepo } as unknown as DataSource,
        {} as RefsService,
        {} as EventsService,
        {} as Repository<ArtifactEntity>,
      );
      const access = {
        projects: { all: false, projectIds: ['pj_visible'] },
        includeUnassigned,
        grants: [],
      };

      await memberAccessStore.run(access, async () => {
        await expect(
          service.create('ws_1', ACTOR, {
            kind: 'document',
            title: 'Hidden owner',
            issueId: 'in_hidden',
          }),
        ).rejects.toMatchObject({ status: 400 });
      });
    },
  );

  it.each([true, false])(
    'rejects moving an artifact onto a hidden issue (includeUnassigned=%s)',
    async (includeUnassigned) => {
      const access = {
        projects: { all: false, projectIds: ['pj_visible'] },
        includeUnassigned,
        grants: [],
      };
      const issueRepo = {
        findOne: async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          projectId: where.id === 'in_hidden' ? 'pj_hidden' : 'pj_visible',
        }),
      };
      const row = { id: 'ar_1', workspaceId: 'ws_1', issueId: 'in_visible' };
      const service = new ArtifactsService(
        { getRepository: () => issueRepo } as unknown as DataSource,
        {} as RefsService,
        {} as EventsService,
        {
          findOneBy: async () => row,
        } as unknown as Repository<ArtifactEntity>,
      );

      await memberAccessStore.run(access, async () => {
        await expect(
          service.update('ws_1', ACTOR, 'ar_1', { issueId: 'in_hidden' }),
        ).rejects.toMatchObject({ status: 400 });
      });
    },
  );

  it.each([true, false])(
    'blocks updates and deletes for hidden issue owners (includeUnassigned=%s)',
    async (includeUnassigned) => {
      const artifact = {
        id: 'ar_hidden',
        workspaceId: 'ws_1',
        issueId: 'in_hidden',
        kind: 'document',
        title: 'Hidden',
        url: null,
      } as ArtifactEntity;
      const repo = {
        findOneBy: async () => artifact,
      } as unknown as Repository<ArtifactEntity>;
      const issueRepo = {
        findOne: async () => ({ projectId: 'pj_hidden' }),
      };
      const service = new ArtifactsService(
        { getRepository: () => issueRepo } as unknown as DataSource,
        {} as RefsService,
        {} as EventsService,
        repo,
      );
      const access = {
        projects: { all: false, projectIds: ['pj_visible'] },
        includeUnassigned,
        grants: [],
      };

      await memberAccessStore.run(access, async () => {
        await expect(
          service.update('ws_1', ACTOR, artifact.id, { title: 'Changed' }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          service.remove('ws_1', ACTOR, artifact.id),
        ).rejects.toMatchObject({ status: 404 });
      });
    },
  );
});
