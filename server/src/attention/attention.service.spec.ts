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
  const request = {
    id: 'request-1',
    issueId: issue.id,
    question: 'Which behavior is expected?',
    assigneeUserId: null,
    state: 'open',
    createdAt: at,
  };
  const decision = {
    id: 'decision-1',
    originIssueId: issue.id,
    title: 'Choose a direction',
    statement: 'Use option A',
    status: 'proposed',
    createdAt: at,
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
    requests: { find: vi.fn().mockResolvedValue([request]) },
    decisions: { find: vi.fn().mockResolvedValue([decision]) },
    artifacts: { find: vi.fn().mockResolvedValue([artifact]) },
    states: {
      findBy: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      delete: vi.fn(),
    },
  };
  const instance = new AttentionService(
    repositories.issues as never,
    repositories.requests as never,
    repositories.decisions as never,
    repositories.artifacts as never,
    repositories.states as never,
  );
  return { instance, repositories };
}

describe('AttentionService', () => {
  it('derives issue questions, proposed decisions, and issue artifact review/CI items', async () => {
    const { instance } = service();

    const items = await instance.list('workspace-1', 'user-1');

    expect(items.map(({ kind, issueId }) => [kind, issueId])).toEqual([
      ['ci_failed', 'issue-1'],
      ['input_requested', 'issue-1'],
      ['needs_decision', 'issue-1'],
      ['review_requested', 'issue-1'],
    ]);
    expect(items.find((item) => item.kind === 'input_requested')).toMatchObject({
      id: 'input_requested:request-1',
      inputRequestId: 'request-1',
      title: 'Which behavior is expected?',
    });
  });

  it('persists per-user dismissals and snoozes against the current item timestamp', async () => {
    const { instance, repositories } = service();
    await instance.dismiss(
      'workspace-1',
      'user-1',
      'needs_decision:decision-1',
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
        itemId: 'needs_decision:decision-1',
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

  it('does not show a question assigned to another person', async () => {
    const { instance, repositories } = service();
    repositories.requests.find.mockResolvedValue([
      { issueId: 'issue-1', state: 'open', assigneeUserId: 'someone-else' },
    ]);

    const items = await instance.list('workspace-1', 'user-1');

    expect(items.some((item) => item.kind === 'input_requested')).toBe(false);
  });
});
