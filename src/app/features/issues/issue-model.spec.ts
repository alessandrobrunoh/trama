import { issueFlow, quietToggleStatus, subtaskStatus } from './issue-model';
import type { StatusEntry, IssueStatus } from '../../core';

describe('subtaskStatus', () => {
  const entries: StatusEntry<IssueStatus>[] = [
    { id: 'st_todo', name: 'Ready', icon: 'circle', color: '#888888', type: 'todo' },
    { id: 'st_doing', name: 'Doing', icon: 'circle-dot', color: '#2255cc', type: 'in_progress' },
    { id: 'st_review', name: 'Review', icon: 'circle-ellipsis', color: '#7733cc', type: 'in_review' },
    { id: 'st_done', name: 'Shipped', icon: 'check', color: '#228833', type: 'done' },
  ];

  it('inherits the status of an open parent', () => {
    expect(subtaskStatus({ status: 'st_doing' }, entries)).toBe('st_doing');
    expect(subtaskStatus({ status: 'backlog' }, undefined)).toBe('backlog');
  });

  it('starts as todo when the parent is finished or in review', () => {
    expect(subtaskStatus({ status: 'st_done' }, entries)).toBe('st_todo');
    expect(subtaskStatus({ status: 'st_review' }, entries)).toBe('st_todo');
  });
});

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

describe('issueFlow', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');
  const day = 86_400_000;
  const at = (daysAgo: number): string => new Date(now - daysAgo * day).toISOString();

  it('counts open and in progress tasks and the week delta', () => {
    const flow = issueFlow(
      [
        { status: 'todo', createdAt: at(2), updatedAt: at(2) },
        { status: 'in_progress', createdAt: at(30), updatedAt: at(1) },
        { status: 'done', createdAt: at(30), updatedAt: at(1), completedAt: at(3) },
        { status: 'canceled', createdAt: at(30), updatedAt: at(20) },
        { status: 'done', createdAt: at(10), updatedAt: at(9), completedAt: at(9) },
      ],
      undefined,
      now,
    );
    expect(flow).toEqual({ open: 2, inProgress: 1, opened: 1, closed: 1 });
  });
});
