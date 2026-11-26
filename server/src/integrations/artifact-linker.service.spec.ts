import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type {
  ArtifactEntity,
} from '../database/entities/index.js';
import {
  ArtifactEntity as ArtifactEntityClass,
  IssueEntity,
  MembershipEntity,
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
      { id: 'rp_1' },
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

describe('ArtifactLinkerService with external identities', () => {
  const candidate = {
    kind: 'pull_request' as const,
    provider: 'github' as const,
    externalId: '#12',
    title: 'Fix BUG-1',
    texts: ['Fix BUG-1'],
    branchTexts: [],
    review: 'requested' as const,
    reviewerLogins: ['Bob-GH'],
    actorLogin: 'Ada-GH',
  };

  function setup(access: unknown = null, issueProject: string | null = 'p1') {
    const issuesRepo = {
      find: vi.fn(async () => [{ id: 'in_1', key: 'BUG-1' }]),
      findOne: vi.fn(async () => ({ id: 'in_1', projectId: issueProject })),
    };
    const ds = {
      getRepository: (entity: unknown) => {
        if (entity === IssueEntity) return issuesRepo;
        if (entity === ArtifactEntityClass) return { findBy: vi.fn(async () => []) };
        if (entity === ArtifactSourceEntity) return { upsert: vi.fn(async () => undefined) };
        if (entity === MembershipEntity)
          return { findBy: vi.fn(async () => [{ userId: 'u_bob', access }]) };
        throw new Error('Unexpected repository');
      },
    } as unknown as DataSource;
    const create = vi.fn(
      async (_workspaceId: string, _actor: unknown, _input: unknown) =>
        ({ id: 'ar_1', updatedAt: new Date() }) as ArtifactEntity,
    );
    const identities = {
      resolveMembersByLogins: vi.fn(async () => new Map([['bob-gh', 'u_bob']])),
      resolveMemberByLogin: vi.fn(async () => 'u_ada' as string | null),
    };
    const linker = new ArtifactLinkerService(ds, { create } as never, identities as never);
    return { linker, create, identities };
  }

  it('asks the people the provider named, and credits a verified sender', async () => {
    const { linker, create, identities } = setup();
    await linker.upsert('ws_1', { id: 'rp_1' }, candidate, { host: 'https://ghe.acme.dev' });

    expect(identities.resolveMembersByLogins).toHaveBeenCalledWith(
      'ws_1', 'github', 'https://ghe.acme.dev', ['Bob-GH'],
    );
    expect(identities.resolveMemberByLogin).toHaveBeenCalledWith(
      'ws_1', 'github', 'https://ghe.acme.dev', 'Ada-GH', { verifiedOnly: true },
    );
    expect(create).toHaveBeenCalledWith(
      'ws_1',
      { type: 'user', id: 'u_ada' },
      expect.objectContaining({ issueId: 'in_1', reviewerUserIds: ['u_bob'] }),
    );
  });

  it('does not tell a reviewer who is limited to other projects', async () => {
    const limited = { projects: { all: false, projectIds: ['p9'] }, includeUnassigned: false };
    const hidden = setup(limited, 'p1');
    await hidden.linker.upsert('ws_1', { id: 'rp_1' }, candidate);
    const input = hidden.create.mock.calls[0]?.[2] as { reviewerUserIds?: string[] };
    expect(input.reviewerUserIds).toBeUndefined();

    const allowed = setup(limited, 'p9');
    await allowed.linker.upsert('ws_1', { id: 'rp_1' }, candidate);
    expect(allowed.create).toHaveBeenCalledWith(
      'ws_1', expect.anything(), expect.objectContaining({ reviewerUserIds: ['u_bob'] }),
    );
  });

  it('keeps the system actor when nobody is linked', async () => {
    const { linker, create, identities } = setup();
    identities.resolveMemberByLogin.mockResolvedValue(null);
    identities.resolveMembersByLogins.mockResolvedValue(new Map());
    await linker.upsert('ws_1', { id: 'rp_1' }, candidate);
    expect(create).toHaveBeenCalledWith('ws_1', { type: 'system' }, expect.anything());
  });
});
