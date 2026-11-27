import { describe, expect, it, vi } from 'vitest';
import { SearchService } from './search.service.js';

describe('SearchService', () => {
  it('searches direct issue and project owners without querying workstreams', async () => {
    const queries: string[] = [];
    const service = new SearchService({
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
    } as never);

    await service.search('ws_1', 'login');

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.join('\n')).not.toMatch(
      /workstreams|workstreamId|originWorkstreamId|customers|repositories|teams|originIssueId/i,
    );
    expect(queries.join('\n')).toContain('x."issueId"');
  });

  it('finds decisions and thread records, each with its task', async () => {
    const queries: string[] = [];
    const service = new SearchService({
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM "task_decisions"'))
          return [
            { id: 'dc_1', key: 'TRM-128', title: 'Keep refresh tokens server side', subtitle: 'Refresh alerts', legacyWorkstreamKey: null, body: '["src/auth/*"]', projectId: null, issueId: 'in_1' },
          ];
        if (sql.includes('FROM "task_thread_records"'))
          return [
            { id: 'in_1', key: 'TRM-128', title: 'Refresh alerts', subtitle: 'Added metrics', legacyWorkstreamKey: null, body: 'Added metrics for refresh', projectId: null, issueId: 'in_1' },
          ];
        return [];
      }),
    } as never);

    const result = await service.search('ws_1', 'refresh', { types: ['decision', 'record'] });

    expect(queries.every((sql) => sql.includes('task_decisions') || sql.includes('task_thread_records'))).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'decision', id: 'dc_1', key: 'TRM-128', issueId: 'in_1', title: 'Keep refresh tokens server side' }),
        expect.objectContaining({ type: 'record', id: 'in_1', key: 'TRM-128', issueId: 'in_1', title: 'Refresh alerts' }),
      ]),
    );
  });

  it('returns legacy ownership as provenance, not as a live resource reference', async () => {
    const service = new SearchService({
      query: vi.fn(async (sql: string) =>
        sql.includes('FROM "artifacts"')
          ? [{ id: 'ar_1', key: null, title: 'Build', subtitle: 'build · open', legacyWorkstreamKey: 'OLD-7', body: null, projectId: null }]
          : [],
      ),
    } as never);

    const result = await service.search('ws_1', 'Build', { types: ['artifact'] });

    expect(result.results).toMatchObject([{ type: 'artifact', id: 'ar_1', legacyWorkstreamKey: 'OLD-7' }]);
  });
});
