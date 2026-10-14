import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { memberAccessStore } from '../auth/member-access.js';
import { DecisionsService } from './decisions.service.js';

describe('DecisionsService', () => {
  it('requires a primary issue for every new decision', async () => {
    const service = new DecisionsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.create(
        'ws_1',
        { type: 'agent', id: 'ag_1' },
        {
          title: 'Choose a path',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('filters list results to decisions whose linked issues are visible', async () => {
    const visible = {
      id: 'dc_visible',
      originIssueId: 'in_visible',
      relatedIssueIds: [],
    };
    const hidden = {
      id: 'dc_hidden',
      originIssueId: 'in_visible',
      relatedIssueIds: ['in_hidden'],
    };
    const hiddenRelated = {
      id: 'dc_related_hidden',
      originIssueId: 'in_visible',
      relatedIssueIds: ['in_hidden'],
    };
    const query = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      getMany: vi.fn(async () => [visible, hidden, hiddenRelated]),
    };
    const decisionRepo = { createQueryBuilder: vi.fn(() => query) };
    const issueRepo = {
      findBy: vi.fn(async () => [
        { id: 'in_visible', projectId: 'pj_visible' },
        { id: 'in_hidden', projectId: 'pj_hidden' },
      ]),
    };
    const service = new DecisionsService(
      { getRepository: () => issueRepo } as never,
      {} as never,
      {} as never,
      {} as never,
      decisionRepo as never,
    );
    const access = {
      projects: { all: false, projectIds: ['pj_visible'] },
      includeUnassigned: false,
      grants: ['issues:view', 'decisions:view'],
    } as const;

    const rows = await memberAccessStore.run(access, () => service.list('ws_1'));

    expect(rows).toEqual([visible]);
  });

  it('blocks decision acceptance when its primary issue is outside project scope', async () => {
    const row = {
      id: 'dc_1',
      key: 'ADR-1',
      originIssueId: 'in_hidden',
      relatedIssueIds: [],
      status: 'proposed',
    };
    const repo = {
      findOneBy: vi.fn(async () => row),
      save: vi.fn(),
    };
    const issueRepo = {
      findBy: vi.fn(async () => [{ id: 'in_hidden', projectId: 'pj_hidden' }]),
    };
    const service = new DecisionsService(
      { getRepository: () => issueRepo } as never,
      {} as never,
      {} as never,
      {} as never,
      repo as never,
    );
    const access = {
      projects: { all: false, projectIds: ['pj_visible'] },
      includeUnassigned: false,
      grants: ['issues:view', 'decisions:view'],
    } as const;

    await memberAccessStore.run(access, async () => {
      await expect(
        service.accept('ws_1', { type: 'user', id: 'usr_1' }, 'ADR-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('blocks creating a decision on an issue outside project scope', async () => {
    const issueRepo = {
      findBy: vi.fn(async () => [{ id: 'in_hidden', projectId: 'pj_hidden' }]),
    };
    const counters = { next: vi.fn() };
    const refs = { issues: vi.fn(async () => undefined) };
    const service = new DecisionsService(
      { getRepository: () => issueRepo } as never,
      refs as never,
      counters as never,
      {} as never,
      {} as never,
    );
    const access = {
      projects: { all: false, projectIds: ['pj_visible'] },
      includeUnassigned: false,
      grants: ['issues:view', 'decisions:create'],
    } as const;

    await memberAccessStore.run(access, async () => {
      await expect(
        service.create(
          'ws_1',
          { type: 'agent', id: 'ag_1' },
          {
            title: 'Choose a path',
            originIssueId: 'in_hidden',
          },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    expect(counters.next).not.toHaveBeenCalled();
  });
});
