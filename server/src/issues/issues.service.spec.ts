import { describe, expect, it } from 'vitest';
import { claimAssignee } from './issues.service.js';

describe('claimAssignee', () => {
  it('claims an unassigned issue for a person entering in_progress', () => {
    expect(claimAssignee({ type: 'user', id: 'usr_me' }, 'todo', 'in_progress', null, false))
      .toBe('usr_me');
  });

  it('does not change explicit assignments or claim for agents', () => {
    expect(claimAssignee({ type: 'user', id: 'usr_me' }, 'todo', 'in_progress', 'usr_other', false))
      .toBe('usr_other');
    expect(claimAssignee({ type: 'agent', id: 'ag_me' }, 'todo', 'in_progress', null, false))
      .toBeNull();
  });
});
