import { describe, expect, it, vi } from 'vitest';
import type { AuthInfo, WorkspaceContext } from '../auth/request-context.js';
import type { IssueEntity } from '../database/entities/index.js';
import { IssuesController } from './issues.controller.js';

function makeController(count: number) {
  const issue = { id: 'in_1' } as IssueEntity;
  const service = {
    get: vi.fn(async () => issue),
    visibleParentIds: vi.fn(async () => new Set<string>()),
  };
  const artifacts = { countForIssue: vi.fn(async () => count) };
  const controller = new IssuesController(service as never, artifacts as never);
  return { controller, issue, artifacts };
}

const ctx = { workspace: { id: 'ws_1' } } as unknown as WorkspaceContext;
const session = {
  actor: { type: 'user', id: 'usr_1' },
  method: 'session',
} as AuthInfo;

describe('IssuesController.get', () => {
  it('includes a zero artifact count for a caller who can read artifacts', async () => {
    const { controller, issue, artifacts } = makeController(0);

    await expect(controller.get(ctx, session, 'BUG-1')).resolves.toBe(issue);

    expect(issue).toHaveProperty('artifactCount', 0);
    expect(artifacts.countForIssue).toHaveBeenCalledWith('ws_1', 'in_1');
  });

  it('includes the count for a custom token with artifact read access', async () => {
    const auth = {
      actor: { type: 'agent', id: 'agt_1' },
      method: 'token',
      token: {
        scope: 'custom',
        permissions: ['issues:read', 'artifacts:read'],
      },
    } as unknown as AuthInfo;
    const { controller, issue, artifacts } = makeController(2);

    await controller.get(ctx, auth, 'BUG-1');

    expect(issue).toHaveProperty('artifactCount', 2);
    expect(artifacts.countForIssue).toHaveBeenCalledWith('ws_1', 'in_1');
  });

  it('does not reveal artifact counts to a custom token without artifact read access', async () => {
    const auth = {
      actor: { type: 'agent', id: 'agt_1' },
      method: 'token',
      token: { scope: 'custom', permissions: ['issues:read'] },
    } as unknown as AuthInfo;
    const { controller, issue, artifacts } = makeController(2);

    await controller.get(ctx, auth, 'BUG-1');

    expect(issue).not.toHaveProperty('artifactCount');
    expect(artifacts.countForIssue).not.toHaveBeenCalled();
  });

  it('hides a parent id when the caller cannot see the parent issue', async () => {
    const issue = { id: 'in_child', parentId: 'in_hidden' } as IssueEntity;
    const visibleParentIds = vi.fn(async () => new Set<string>());
    const controller = new IssuesController(
      {
        get: vi.fn(async () => issue),
        visibleParentIds,
      } as never,
      { countForIssue: vi.fn(async () => 0) } as never,
    );

    await controller.get(ctx, session, 'BUG-1');

    expect(visibleParentIds).toHaveBeenCalledWith('ws_1', ['in_hidden']);
    expect(issue.parentId).toBeNull();
  });
});

describe('IssuesController.context', () => {
  it('hides a parent id when the caller cannot see the parent issue', async () => {
    const issue = { id: 'in_child', parentId: 'in_hidden' } as IssueEntity;
    const visibleParentIds = vi.fn(async () => new Set<string>());
    const controller = new IssuesController(
      {
        get: vi.fn(async () => issue),
        visibleParentIds,
      } as never,
      { list: vi.fn(async () => []) } as never,
    );

    const result = await controller.context(ctx, session, 'BUG-1');

    expect(visibleParentIds).toHaveBeenCalledWith('ws_1', ['in_hidden']);
    expect(result).toMatchObject({ issue: { parentId: null } });
  });

  it('returns issue-owned artifacts and an optional plan summary', async () => {
    const issue = { id: 'in_1' } as IssueEntity;
    const artifact = {
      id: 'ar_1',
      kind: 'document',
      title: 'Plan: rollout',
      updatedAt: new Date(0),
    };
    const controller = new IssuesController(
      { get: vi.fn(async () => issue) } as never,
      { list: vi.fn(async () => [artifact]) } as never,
    );
    const result = await controller.context(ctx, session, 'BUG-1');

    expect(result).toEqual({
      issue,
      planSummary: { artifactCount: 1, latestArtifact: artifact },
      artifacts: [artifact],
    });
  });

  it('omits planSummary when issue-owned artifacts are not plans', async () => {
    const artifact = { id: 'ar_1', kind: 'pull_request', title: 'Fix', updatedAt: new Date(0) };
    const controller = new IssuesController(
      { get: vi.fn(async () => ({ id: 'in_1' })) } as never,
      { list: vi.fn(async () => [artifact]) } as never,
    );

    const result = await controller.context(ctx, session, 'BUG-1');
    expect(result).toEqual({
      issue: { id: 'in_1' },
      planSummary: undefined,
      artifacts: [artifact],
    });
  });

  it('returns a markdown briefing when markdown is requested', async () => {
    const issue = {
      id: 'in_1',
      key: 'BUG-1',
      title: 'Broken',
      kind: 'bug',
      status: 'todo',
      priority: 'none',
    };
    const controller = new IssuesController(
      { get: vi.fn(async () => issue) } as never,
      { list: vi.fn(async () => []) } as never,
    );
    const res = { type: vi.fn() };

    const result = await controller.context(
      ctx,
      session,
      'BUG-1',
      { format: 'markdown' },
      undefined,
      res as never,
    );

    expect(res.type).toHaveBeenCalledWith('text/markdown; charset=utf-8');
    expect(result).toContain('# BUG-1 — Broken');
    expect(result).not.toContain('Answered');
  });
});
