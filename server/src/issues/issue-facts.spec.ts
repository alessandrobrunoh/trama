import { applyStatusFacts, claimAssignee } from './issues.service.js';

describe('applyStatusFacts', () => {
  const t0 = new Date('2026-10-01T00:00:00Z');
  const t1 = new Date('2026-10-02T00:00:00Z');
  const t2 = new Date('2026-10-03T00:00:00Z');

  it('sets startedAt once, on the first in_progress / in_review', () => {
    const row = { startedAt: null as Date | null, completedAt: null as Date | null };
    applyStatusFacts(row, 'todo', t0);
    expect(row.startedAt).toBeNull();
    applyStatusFacts(row, 'in_review', t0);
    expect(row.startedAt).toEqual(t0);
    applyStatusFacts(row, 'in_progress', t1);
    applyStatusFacts(row, 'backlog', t2);
    expect(row.startedAt).toEqual(t0);
  });

  it('assigns the user who starts an unassigned issue, and nobody else', () => {
    const user = { type: 'user' as const, id: 'usr_me' };
    const agent = { type: 'agent' as const, id: 'ag_1' };
    expect(claimAssignee(user, 'backlog', 'in_progress', null, false)).toBe('usr_me');
    expect(claimAssignee(user, null, 'in_progress', null, false)).toBe('usr_me');
    expect(claimAssignee(user, 'todo', 'in_progress', 'usr_other', false)).toBe('usr_other');
    expect(claimAssignee(user, 'backlog', 'in_progress', null, true)).toBeNull();
    expect(claimAssignee(user, 'in_progress', 'in_progress', null, false)).toBeNull();
    expect(claimAssignee(user, 'backlog', 'in_review', null, false)).toBeNull();
    expect(claimAssignee(agent, 'backlog', 'in_progress', null, false)).toBeNull();
    expect(claimAssignee({ type: 'user' }, 'backlog', 'in_progress', null, false)).toBeNull();
  });

  it('sets completedAt on done / canceled and clears it on reopen', () => {
    const row = { startedAt: null as Date | null, completedAt: null as Date | null };
    applyStatusFacts(row, 'done', t1);
    expect(row.completedAt).toEqual(t1);
    applyStatusFacts(row, 'canceled', t2);
    expect(row.completedAt).toEqual(t1);
    applyStatusFacts(row, 'in_progress', t2);
    expect(row.completedAt).toBeNull();
  });
});
