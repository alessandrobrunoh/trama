import { describe, expect, it, vi } from 'vitest';
import type { AuthInfo, WorkspaceContext } from '../auth/request-context.js';
import type { IssueEntity } from '../database/entities/index.js';
import { IssuesController } from './issues.controller.js';

function makeController(count: number) {
  const issue = { id: 'in_1' } as IssueEntity;
  const service = { get: vi.fn(async () => issue) };
  const customers = { attachCounts: vi.fn(async () => undefined) };
  const permissions = { assertTeamEdit: vi.fn(async () => undefined) };
  const artifacts = { countForIssue: vi.fn(async () => count) };
  const controller = new IssuesController(
    service as never,
    customers as never,
    permissions as never,
    artifacts as never,
    {} as never,
    {} as never,
  );
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
});

describe('IssuesController.context', () => {
  it('returns issue-owned context with open requests and an optional plan summary', async () => {
    const issue = { id: 'in_1' } as IssueEntity;
    const artifact = { id: 'ar_1', kind: 'document', title: 'Plan: rollout' };
    const decision = { id: 'dc_1', title: 'Plan approval' };
    const inputRequest = { id: 'ir_1', state: 'open', issueId: 'in_1' };
    const controller = new IssuesController(
      { get: vi.fn(async () => issue) } as never,
      { attachCounts: vi.fn(async () => undefined) } as never,
      {} as never,
      { list: vi.fn(async () => [artifact]) } as never,
      { list: vi.fn(async () => [decision]) } as never,
      { list: vi.fn(async () => [inputRequest]) } as never,
    );
    const result = await controller.context(ctx, session, 'BUG-1');

    expect(result).toEqual({
      issue,
      planSummary: { artifactCount: 1, latestArtifact: artifact, decisions: [decision] },
      decisions: [decision],
      inputRequests: [inputRequest],
      artifacts: [artifact],
    });
  });

  it('omits planSummary when issue-owned artifacts and decisions have no plans', async () => {
    const controller = new IssuesController(
      { get: vi.fn(async () => ({ id: 'in_1' })) } as never,
      { attachCounts: vi.fn(async () => undefined) } as never,
      {} as never,
      { list: vi.fn(async () => []) } as never,
      { list: vi.fn(async () => [{ id: 'dc_1', title: 'Decision', tags: [] }]) } as never,
      { list: vi.fn(async () => []) } as never,
    );

    const result = await controller.context(ctx, session, 'BUG-1');
    expect(result.planSummary).toBeUndefined();
    expect(result.decisions).toEqual([{ id: 'dc_1', title: 'Decision', tags: [] }]);
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
    const answered = { id: 'ir_1', state: 'answered', question: 'Which?', answer: 'B' };
    const documentVersions = vi.fn(async () => new Map<string, number>());
    const controller = new IssuesController(
      { get: vi.fn(async () => issue), documentVersions } as never,
      {} as never,
      {} as never,
      { list: vi.fn(async () => []) } as never,
      { list: vi.fn(async () => []) } as never,
      { list: vi.fn(async () => [answered]) } as never,
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
    expect(result).toContain('- Answered: Which? → B');
  });
});
