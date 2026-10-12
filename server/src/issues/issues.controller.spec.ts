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
