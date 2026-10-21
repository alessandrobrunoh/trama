import { describe, expect, it, vi } from 'vitest';
import { UNASSIGNED_ISSUE_KEY_PREFIX } from '../contracts/domain.js';
import type { IssueEntity } from '../database/entities/index.js';
import {
  allocateIssueNumbers,
  issueKeyPrefix,
  rekeyIssues,
} from './issue-keys.js';

describe('issue keys', () => {
  it('uses a project tag or the reserved unassigned prefix', async () => {
    const query = vi.fn(async () => [{ key: 'CORA' }]);
    const manager = { query } as never;

    await expect(issueKeyPrefix(manager, 'ws_1', 'pj_cora')).resolves.toBe(
      'CORA',
    );
    await expect(issueKeyPrefix(manager, 'ws_1', null)).resolves.toBe(
      UNASSIGNED_ISSUE_KEY_PREFIX,
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR SHARE'), [
      'ws_1',
      'pj_cora',
    ]);
  });

  it('starts above retained aliases and then uses the atomic prefix counter', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ floor: '8' }]);
    const nextAbove = vi.fn(async () => 9);
    const next = vi.fn(async () => 10);
    const manager = { query } as never;
    const counters = { nextAbove, next } as never;

    await expect(
      allocateIssueNumbers(manager, counters, 'ws_1', 'CORA', 2),
    ).resolves.toEqual([9, 10]);
    expect(nextAbove).toHaveBeenCalledWith(
      manager,
      'ws_1',
      'issue-key:CORA',
      8,
    );
    expect(next).toHaveBeenCalledWith(manager, 'ws_1', 'issue-key:CORA');
  });

  it('keeps the previous key as an alias when an issue changes project', async () => {
    const query = vi.fn(async () => [{ value: 3 }]);
    const next = vi.fn(async () => 4);
    const manager = { query } as never;
    const counters = { next } as never;
    const issue = {
      id: 'in_1',
      key: 'CORA-3',
      number: 3,
      aliases: ['BUG-7'],
      projectId: 'pj_cora',
      updatedAt: new Date(0),
    } as IssueEntity;

    const changes = await rekeyIssues(
      manager,
      counters,
      'ws_1',
      [issue],
      'UNPR',
      null,
      'project_changed',
    );

    expect(issue).toMatchObject({
      key: 'UNPR-4',
      number: 4,
      aliases: ['BUG-7', 'CORA-3'],
    });
    expect(changes[0]).toMatchObject({
      from: 'CORA-3',
      to: 'UNPR-4',
      fromProjectId: 'pj_cora',
      toProjectId: null,
    });
  });
});
