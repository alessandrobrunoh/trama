import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../auth/request-context.js';
import { INSIGHT_SIGNAL_IDS } from '../contracts/domain.js';
import { InsightsService } from './insights.service.js';

function setup() {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM teams')) return [{ id: 'tm_ok' }];
    if (sql.includes('FROM projects WHERE id')) return [{ id: 'pr_ok' }];
    return [];
  });
  const service = new InsightsService({ query } as never);
  const ctx = { workspace: { id: 'ws_test' }, access: null } as unknown as WorkspaceContext;
  return { service, ctx, query };
}

describe('InsightsService Issue-only report', () => {
  it('returns all current contract signals with empty Issue scope', async () => {
    const { service, ctx } = setup();
    const report = await service.report(ctx, {});

    expect(report.signals.map(({ id }) => id)).toEqual(INSIGHT_SIGNAL_IDS);
    expect(report.signals.every(({ count, items }) => count === 0 && items.length === 0)).toBe(true);
    expect(report.flow.throughput.length).toBeGreaterThan(0);
    expect(report.actors).toEqual({
      people: [],
      agents: [],
      share: { people: 0, agents: 0 },
      failures: [],
    });
  });

  it('applies team and project filters and returns no leaked items for empty filtered scope', async () => {
    const { service, ctx, query } = setup();
    const report = await service.report(ctx, { teamId: 'tm_ok', projectId: 'pr_ok' });

    expect(report.scope).toEqual({ teamId: 'tm_ok', projectId: 'pr_ok' });
    expect(report.signals.flatMap(({ items }) => items)).toEqual([]);
    const issueSelect = query.mock.calls.find(([sql]) => sql.includes('FROM issues i'))!;
    expect(issueSelect[0]).toContain('i."teamId" = $2');
    expect(issueSelect[0]).toContain('i."projectId" = $3');
    expect(issueSelect[1]).toEqual(['ws_test', 'tm_ok', 'pr_ok', expect.any(Date)]);
  });
});
