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
    expect(queries.join('\n')).not.toMatch(/workstreams|workstreamId|originWorkstreamId/i);
    expect(queries.join('\n')).toContain('x."originIssueId"');
    expect(queries.join('\n')).toContain('x."issueId"');
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
