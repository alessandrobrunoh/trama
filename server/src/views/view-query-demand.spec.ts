import { describe, expect, it } from 'vitest';
import { applyFilters, fieldValues, groupItems } from './view-query.js';

describe('retired view fields', () => {
  const issue = {
    id: 'in_a',
    title: 'A',
    teamId: 't1',
    releaseId: 'rel_1',
    customerCount: 4,
  };

  it('does not filter, read, or group by team, release, or customer demand', () => {
    for (const field of [
      'teamId',
      'releaseId',
      'customerId',
      'customerCount',
      'teamIds',
      'repositoryIds',
    ]) {
      expect(fieldValues('issue', issue, field)).toEqual([]);
      expect(
        applyFilters('issue', [issue], [{ field, op: 'is', value: 't1' }]),
      ).toEqual([]);
      expect(groupItems('issue', [issue], field)).toEqual([
        { key: '', items: [issue] },
      ]);
    }
  });
});
