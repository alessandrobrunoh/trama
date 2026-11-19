import { describe, expect, it, vi } from 'vitest';
import { AttentionService } from './attention.service.js';

const at = new Date('2025-01-01T00:00:00.000Z');

function service() {
  const issue = {
    id: 'issue-1',
    workspaceId: 'workspace-1',
    key: 'BUG-1',
    title: 'Broken thing',
    projectId: null,
  };
  const artifact = {
    id: 'artifact-1',
    issueId: issue.id,
    title: 'Pull request',
    review: 'requested',
    ci: 'failing',
    updatedAt: at,
  };
  const repositories = {
    issues: { findBy: vi.fn().mockResolvedValue([issue]) },
    artifacts: { find: vi.fn().mockResolvedValue([artifact]) },
    states: {
      findBy: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      delete: vi.fn(),
    },
  };
  const instance = new AttentionService(
    repositories.issues as never,
    repositories.artifacts as never,
    repositories.states as never,
  );
  return { instance, repositories };
}

describe('AttentionService', () => {
  it('derives issue artifact review and CI items', async () => {
    const { instance } = service();

    const items = await instance.list('workspace-1', 'user-1');

    expect(items.map(({ kind, issueId }) => [kind, issueId])).toEqual([
      ['ci_failed', 'issue-1'],
      ['review_requested', 'issue-1'],
    ]);
  });

  it('persists per-user dismissals and snoozes against the current item timestamp', async () => {
    const { instance, repositories } = service();
    await instance.dismiss(
      'workspace-1',
      'user-1',
      'review_requested:artifact-1',
    );
    await instance.snooze(
      'workspace-1',
      'user-1',
      'ci_failed:artifact-1',
      '2030-01-01T00:00:00.000Z',
    );

    expect(repositories.states.save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: 'workspace-1',
        userId: 'user-1',
        itemId: 'review_requested:artifact-1',
        state: 'dismissed',
        since: at,
      }),
    );
    expect(repositories.states.save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        itemId: 'ci_failed:artifact-1',
        state: 'snoozed',
        snoozedUntil: new Date('2030-01-01T00:00:00.000Z'),
      }),
    );
  });

  it('only restores the requesting user’s attention state', async () => {
    const { instance, repositories } = service();
    await instance.restore(
      'workspace-1',
      'user-1',
      'review_requested:artifact-1',
    );

    expect(repositories.states.delete).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      itemId: 'review_requested:artifact-1',
    });
  });

});
