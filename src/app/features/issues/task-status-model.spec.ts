import { DAY_MS, daysSince, proposeStatus, type StatusEvidence } from './task-status-model';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

function evidence(over: Partial<StatusEvidence> = {}): StatusEvidence {
  return {
    now: NOW,
    current: 'in_progress',
    subtasks: { total: 0, done: 0, canceled: 0, inProgress: 0, inReview: 0 },
    artifacts: [],
    timer: { runningHere: false, recentMs: 0 },
    comments: [],
    lastActivityAt: ago(1),
    ...over,
  };
}

describe('proposeStatus', () => {
  it('keeps the status when nothing contradicts it', () => {
    const p = proposeStatus(evidence({ current: 'todo' }));
    expect(p.status).toBe('todo');
    expect(p.changes).toBe(false);
    expect(p.confidence).toBe('low');
    expect(p.reasons).toHaveLength(1);
  });

  it('proposes done when every subtask is done', () => {
    const p = proposeStatus(evidence({ subtasks: { total: 4, done: 4, canceled: 0, inProgress: 0, inReview: 0 } }));
    expect(p.status).toBe('done');
    expect(p.changes).toBe(true);
    expect(p.reasons[0]).toBe('All 4 subtasks are done');
    expect(p.confidence).toBe('high');
  });

  it('does not call it done while a subtask is open, and says how far it got', () => {
    const p = proposeStatus(
      evidence({ current: 'todo', subtasks: { total: 4, done: 2, canceled: 0, inProgress: 0, inReview: 0 } }),
    );
    expect(p.status).toBe('in_progress');
    expect(p.reasons).toContain('2 of 4 subtasks are done');
  });

  it('warns instead of reopening a done task whose subtasks are open', () => {
    const p = proposeStatus(
      evidence({ current: 'done', subtasks: { total: 3, done: 1, canceled: 0, inProgress: 0, inReview: 0 } }),
    );
    expect(p.status).toBe('done');
    expect(p.warnings).toContain('2 subtasks still open');
  });

  it('proposes done for a merged pull request', () => {
    const p = proposeStatus(
      evidence({ current: 'in_review', artifacts: [{ kind: 'pull_request', state: 'merged', ref: '#182' }] }),
    );
    expect(p.status).toBe('done');
    expect(p.reasons).toContain('PR #182 is merged');
  });

  it('proposes in review for an approved open pull request and flags failing CI', () => {
    const p = proposeStatus(
      evidence({
        artifacts: [{ kind: 'pull_request', state: 'open', review: 'approved', ci: 'failing', hasConflicts: true, ref: '#7' }],
      }),
    );
    expect(p.status).toBe('in_progress');
    expect(p.warnings).toEqual(['CI is failing on PR #7', 'PR #7 has merge conflicts']);
    const ok = proposeStatus(
      evidence({ artifacts: [{ kind: 'pull_request', state: 'open', review: 'approved', ci: 'passing', ref: '#7' }] }),
    );
    expect(ok.status).toBe('in_review');
    expect(ok.reasons[0]).toBe('PR #7 is approved and CI is passing');
  });

  it('treats a draft pull request as work in progress', () => {
    const p = proposeStatus(
      evidence({ current: 'todo', artifacts: [{ kind: 'pull_request', state: 'draft', ref: '#9' }] }),
    );
    expect(p.status).toBe('in_progress');
  });

  it('proposes in progress while the timer runs', () => {
    const p = proposeStatus(evidence({ current: 'todo', timer: { runningHere: true, recentMs: 0 } }));
    expect(p.status).toBe('in_progress');
    expect(p.reasons[0]).toBe('The timer is running on this task');
  });

  it('uses recently tracked time', () => {
    const p = proposeStatus(evidence({ current: 'todo', timer: { runningHere: false, recentMs: 2 * 3_600_000 } }));
    expect(p.status).toBe('in_progress');
    expect(p.reasons[0]).toBe('2h tracked in the last 3 days');
  });

  it('proposes todo for work that went quiet', () => {
    const p = proposeStatus(evidence({ lastActivityAt: ago(9) }));
    expect(p.status).toBe('todo');
    expect(p.reasons).toEqual(['No activity for 9 days']);
  });

  it('does not call it quiet while a pull request is open', () => {
    const p = proposeStatus(
      evidence({ lastActivityAt: ago(20), artifacts: [{ kind: 'pull_request', state: 'open', ref: '#1' }] }),
    );
    expect(p.status).toBe('in_review');
  });

  it('proposes canceled for a duplicate', () => {
    const p = proposeStatus(evidence({ duplicateOf: 'CORA-12' }));
    expect(p.status).toBe('canceled');
    expect(p.reasons[0]).toBe('Marked as a duplicate of CORA-12');
  });

  it('follows a linked tracker', () => {
    const p = proposeStatus(evidence({ external: { stateType: 'done', label: 'GitHub #12' } }));
    expect(p.status).toBe('done');
    expect(p.reasons).toContain('GitHub #12 is closed');
  });

  describe('comments', () => {
    it('reads a recent "done" comment', () => {
      const p = proposeStatus(evidence({ comments: [{ body: 'Fixed and shipped to staging.', at: ago(1) }] }));
      expect(p.status).toBe('done');
      expect(p.reasons).toContain('A recent comment says it is done');
    });

    it('ignores negated or old comments', () => {
      expect(proposeStatus(evidence({ comments: [{ body: 'This is not done yet', at: ago(1) }] })).status).toBe('in_progress');
      expect(proposeStatus(evidence({ comments: [{ body: 'Once it is merged we close', at: ago(1) }] })).status).toBe('in_progress');
      expect(proposeStatus(evidence({ comments: [{ body: 'all done', at: ago(40) }] })).status).toBe('in_progress');
    });

    it('turns a blocker into a warning, not a status', () => {
      const p = proposeStatus(evidence({ comments: [{ body: 'Blocked on the API keys', at: ago(2) }] }));
      expect(p.status).toBe('in_progress');
      expect(p.warnings).toEqual(['A recent comment mentions it is blocked']);
    });
  });

  it('never gives more than three reasons', () => {
    const p = proposeStatus(
      evidence({
        current: 'in_review',
        subtasks: { total: 2, done: 2, canceled: 0, inProgress: 0, inReview: 0 },
        artifacts: [
          { kind: 'pull_request', state: 'merged', ref: '#1' },
          { kind: 'release', state: 'published', ref: 'v1' },
        ],
        external: { stateType: 'done', label: 'GitHub #1' },
        comments: [{ body: 'done', at: ago(0) }],
      }),
    );
    expect(p.status).toBe('done');
    expect(p.reasons.length).toBeLessThanOrEqual(3);
    expect(p.confidence).toBe('high');
  });
});

describe('daysSince', () => {
  it('counts whole days and tolerates missing dates', () => {
    expect(daysSince(ago(3.5), NOW)).toBe(3);
    expect(daysSince(undefined, NOW)).toBeUndefined();
    expect(daysSince(ago(-2), NOW)).toBe(0);
  });
});
