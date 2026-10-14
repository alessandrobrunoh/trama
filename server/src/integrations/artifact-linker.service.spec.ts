import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type {
  ArtifactEntity,
  RepositoryEntity,
} from '../database/entities/index.js';
import {
  ArtifactEntity as ArtifactEntityClass,
  IssueEntity,
} from '../database/entities/index.js';
import { ArtifactSourceEntity } from './entities.js';
import { ArtifactLinkerService } from './artifact-linker.service.js';

describe('ArtifactLinkerService', () => {
  it('attaches webhook artifacts to matching Issues, not retired Workstreams', async () => {
    const artifactRepo = {
      findBy: vi.fn(async () => []),
    };
    const issuesRepo = {
      find: vi.fn(async () => [{ id: 'in_1', key: 'BUG-1' }]),
    };
    const sourceRepo = { upsert: vi.fn(async () => undefined) };
    const ds = {
      getRepository: (entity: unknown) => {
        if (entity === IssueEntity) return issuesRepo;
        if (entity === ArtifactEntityClass) return artifactRepo;
        if (entity === ArtifactSourceEntity) return sourceRepo;
        throw new Error('Unexpected repository');
      },
    } as unknown as DataSource;
    const create = vi.fn(
      async (_workspaceId: string, _actor: unknown, _input: unknown) =>
        ({
          id: 'ar_1',
          updatedAt: new Date(),
        }) as ArtifactEntity,
    );
    const linker = new ArtifactLinkerService(ds, { create } as never);

    const result = await linker.upsert(
      'ws_1',
      { id: 'rp_1' } as RepositoryEntity,
      {
        kind: 'pull_request',
        provider: 'github',
        externalId: '#12',
        title: 'Fix BUG-1',
        texts: ['Fix BUG-1'],
        branchTexts: [],
      },
    );

    expect(result).toEqual({ created: 1, updated: 0, issueKeys: ['BUG-1'] });
    expect(create).toHaveBeenCalledWith(
      'ws_1',
      { type: 'system' },
      expect.objectContaining({ issueId: 'in_1' }),
    );
    expect(create.mock.calls[0]?.[2]).not.toHaveProperty('workstreamId');
  });
});
