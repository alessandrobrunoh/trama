import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { memberAccessStore } from '../auth/member-access.js';
import type { MemberAccess } from '../contracts/domain.js';
import { InputRequestsService } from './input-requests.service.js';

describe('InputRequestsService', () => {
  it('requires an issue owner for every new request', async () => {
    const service = new InputRequestsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.create('ws_1', { type: 'agent', id: 'ag_1' }, {
        question: 'Which option?',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('filters request lists through the owning Issue project', async () => {
    const query = {
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      andWhere: vi.fn().mockReturnThis(),
      getMany: vi.fn(async () => []),
    };
    const service = new InputRequestsService(
      {} as never,
      {} as never,
      {} as never,
      { createQueryBuilder: vi.fn(() => query) } as never,
    );
    const access: MemberAccess = {
      projects: { all: false, projectIds: ['pj_visible'] },
      includeUnassigned: false,
      grants: ['issues:view', 'input-requests:view'],
    };

    await memberAccessStore.run(access, () => service.list('ws_1'));

    expect(query.innerJoin).toHaveBeenCalledOnce();
    expect(query.andWhere).toHaveBeenCalledWith('issue.id IS NOT NULL');
    expect(query.andWhere).toHaveBeenCalledWith(
      'issue.projectId IN (:...memberProjectIds)',
      { memberProjectIds: ['pj_visible'] },
    );
  });

  it('scopes issue-owned request reads and mutations to visible issue projects', async () => {
    const row = {
      id: 'ir_1',
      workspaceId: 'ws_1',
      issueId: 'in_hidden',
      state: 'open',
      question: 'Which option?',
    };
    const issueRepo = {
      findOneBy: vi.fn(async () => ({ id: 'in_hidden', projectId: 'pj_hidden' })),
    };
    const requestRepo = {
      findOneBy: vi.fn(async () => row),
      save: vi.fn(),
    };
    const events = { record: vi.fn() };
    const service = new InputRequestsService(
      { getRepository: () => issueRepo } as never,
      {} as never,
      events as never,
      requestRepo as never,
    );
    const access: MemberAccess = {
      projects: { all: false, projectIds: ['pj_visible'] },
      includeUnassigned: false,
      grants: ['issues:view', 'input-requests:view'],
    };

    await memberAccessStore.run(access, async () => {
      await expect(service.get('ws_1', 'ir_1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        service.answer('ws_1', { type: 'user', id: 'usr_1' }, 'ir_1', 'A'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    expect(requestRepo.save).not.toHaveBeenCalled();
    expect(events.record).not.toHaveBeenCalled();
  });
});
