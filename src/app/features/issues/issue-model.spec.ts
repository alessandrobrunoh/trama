import { quietToggleStatus } from './issue-model';
import type { StatusEntry, IssueStatus } from '../../core';

describe('quietToggleStatus', () => {
  const entries: StatusEntry<IssueStatus>[] = [
    { id: 'st_todo', name: 'Ready', icon: 'circle', color: '#888888', type: 'todo' },
    { id: 'st_done', name: 'Shipped', icon: 'check', color: '#228833', type: 'done' },
  ];

  it('uses the catalog id for the semantic type', () => {
    expect(quietToggleStatus(entries, false)).toBe('st_done');
    expect(quietToggleStatus(entries, true)).toBe('st_todo');
  });

  it('falls back to the legacy enum when that type is missing', () => {
    expect(quietToggleStatus([], false)).toBe('done');
    expect(quietToggleStatus(undefined, true)).toBe('todo');
  });
});
