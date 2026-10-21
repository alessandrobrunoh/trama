import { BadRequestException, ConflictException } from '@nestjs/common';
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
  it('requires at least one owner', async () => {
    const { service } = setup();
    await expect(
      service.create('ws_1', ACTOR, { kind: 'document', title: 'x' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a valid http(s) url for a link', async () => {
    const { service } = setup();
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'link',
        title: 'x',
        projectId: 'pj_1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'link',
        title: 'x',
        projectId: 'pj_1',
        url: 'ftp://x',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'link',
        title: 'x',
        projectId: 'pj_1',
        url: 'https://x.test',
      }),
    ).resolves.toMatchObject({ kind: 'link', state: 'published' });
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'file',
        title: 'x',
        projectId: 'pj_1',
        url: '/api/w/acme/uploads/upl_abcdefghijkl',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a document carry only a description, and reports the owners in the event', async () => {
    const { service, record } = setup();
    const row = await service.create('ws_1', ACTOR, {
      kind: 'document',
      title: 'Notes',
      description: ' why ',
      issueId: 'in_1',
      projectId: 'pj_1',
    });
    expect(row).toMatchObject({
      description: 'why',
      issueId: 'in_1',
      projectId: 'pj_1',
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'artifact.attached',
        data: expect.objectContaining({ issueId: 'in_1', projectId: 'pj_1' }),
      }),
    );
  });

  it('refuses to detach the last owner and keeps the others when detaching one', async () => {
    const { service, record } = setup({
      projectId: 'pj_1',
      issueId: null,
    });
    await expect(
      service.update('ws_1', ACTOR, 'ar_1', { projectId: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const { service: s2, record: r2 } = setup({
      projectId: 'pj_1',
      issueId: 'in_1',
    });
    await expect(
      s2.update('ws_1', ACTOR, 'ar_1', { issueId: null }),
    ).resolves.toMatchObject({ projectId: 'pj_1', issueId: null });
    expect(r2).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'artifact.updated',
        data: expect.objectContaining({ projectId: 'pj_1' }),
      }),
    );
    expect(record).not.toHaveBeenCalled();
  });
});

describe('ArtifactsService document artifacts', () => {
  function withDocument(
    docs: { id: string; title: string; workspaceId: string }[],
    attached: Partial<ArtifactEntity>[] = [],
  ) {
    const record = vi.fn(async () => ({}));
    const repo = {
      create: (x: Partial<ArtifactEntity>) => x as ArtifactEntity,
      save: async (x: ArtifactEntity) => x,
      findOneBy: async () => null,
      existsBy: async (w: Partial<ArtifactEntity>) =>
        attached.some((a) =>
          Object.entries(w).every(
            ([k, v]) => (a as Record<string, unknown>)[k] === v,
          ),
        ),
    } as unknown as Repository<ArtifactEntity>;
    const others = {
      existsBy: async () => true,
      findOne: async ({
        where,
      }: {
        where: { id: string; workspaceId: string };
      }) =>
        docs.find(
          (d) => d.id === where.id && d.workspaceId === where.workspaceId,
        ) ??
        (where.id.startsWith('in_') ? { id: where.id, projectId: null } : null),
    };
    const ds = {
      getRepository: () => others,
      query: async () => [],
    } as unknown as DataSource;
    const refs = {
      repositories: async () => undefined,
    } as unknown as RefsService;
    return {
      service: new ArtifactsService(
        ds,
        refs,
        { record } as unknown as EventsService,
        repo,
      ),
    };
  }

  it('takes title and provider from the document and needs no url', async () => {
    const { service } = withDocument([
      { id: 'doc_1', title: 'Spec', workspaceId: 'ws_1' },
    ]);
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'document',
        documentId: 'doc_1',
        projectId: 'pj_1',
        title: 'ignored',
        url: 'https://x.test',
      }),
    ).resolves.toMatchObject({
      title: 'Spec',
      documentId: 'doc_1',
      provider: 'docs',
      url: null,
      state: 'published',
    });
  });

  it('refuses a document of another workspace, a wrong kind, and a second attach to the same owner', async () => {
    const { service } = withDocument([
      { id: 'doc_1', title: 'Spec', workspaceId: 'ws_2' },
    ]);
    await expect(
      service.create('ws_1', ACTOR, {
        kind: 'document',
        documentId: 'doc_1',
        projectId: 'pj_1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const mine = withDocument(
      [{ id: 'doc_1', title: 'Spec', workspaceId: 'ws_1' }],
      [{ documentId: 'doc_1', projectId: 'pj_1', workspaceId: 'ws_1' }],
    );
    await expect(
      mine.service.create('ws_1', ACTOR, {
        kind: 'link',
        documentId: 'doc_1',
        projectId: 'pj_1',
        url: 'https://x.test',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      mine.service.create('ws_1', ACTOR, {
        kind: 'document',
        documentId: 'doc_1',
        projectId: 'pj_1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      mine.service.create('ws_1', ACTOR, {
        kind: 'document',
        documentId: 'doc_1',
        issueId: 'in_1',
      }),
    ).resolves.toMatchObject({ issueId: 'in_1' });
  });

  it('still needs a title without a document', async () => {
    const { service } = withDocument([]);
    await expect(
      service.create('ws_1', ACTOR, { kind: 'document', projectId: 'pj_1' }),
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
    const repo = {
      createQueryBuilder: vi.fn(() => query),
    } as unknown as Repository<ArtifactEntity>;
    const service = new ArtifactsService(
      {} as DataSource,
      {} as RefsService,
      {} as EventsService,
      repo,
    );
    return { service, query, repo };
  }

  it.each([0, 3])(
    'returns %i for an issue without loading its artifacts',
    async (count) => {
      const { service, query, repo } = withCount(count);

      await expect(service.countForIssue('ws_1', 'in_1')).resolves.toBe(count);

      expect(repo.createQueryBuilder.mock.calls).toEqual([['a']]);
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
        projectId: null,
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
      projectId: null,
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
    'rejects creating or moving an artifact onto a hidden project (includeUnassigned=%s)',
    async (includeUnassigned) => {
      const access = {
        projects: { all: false, projectIds: ['pj_visible'] },
        includeUnassigned,
        grants: [],
      };
      const { service } = setup();
      const update = setup({ projectId: 'pj_visible', issueId: null });

      await memberAccessStore.run(access, async () => {
        await expect(
          service.create('ws_1', ACTOR, {
            kind: 'document',
            title: 'Hidden project artifact',
            projectId: 'pj_hidden',
          }),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
          update.service.update('ws_1', ACTOR, 'ar_1', {
            projectId: 'pj_hidden',
          }),
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
        projectId: null,
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
