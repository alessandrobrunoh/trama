import { describe, expect, it } from 'vitest';
import { compactResult } from './assistant-tools.service.js';

describe('compactResult', () => {
  it('drops bulky fields from lists but leaves single records and non-JSON alone', () => {
    const list = JSON.stringify([
      { key: 'BUG-1', title: 'a', priority: 'high', body: 'x'.repeat(500), workspaceId: 'ws_1' },
      { key: 'BUG-2', title: 'b', priority: 'low', body: 'y' },
    ]);
    const out = compactResult(list);
    expect(out.startsWith('2 results:\n')).toBe(true);
    expect(JSON.parse(out.slice(out.indexOf('\n') + 1))).toEqual([
      { key: 'BUG-1', title: 'a', priority: 'high' },
      { key: 'BUG-2', title: 'b', priority: 'low' },
    ]);
    expect(compactResult('[]')).toBe('0 results:\n[]');
    expect(compactResult('[{"key":"A"}]')).toBe('1 result:\n[{"key":"A"}]');
    const one = JSON.stringify({ key: 'BUG-1', body: 'keep' });
    expect(compactResult(one)).toBe(one);
    expect(compactResult('# markdown')).toBe('# markdown');
  });
});
