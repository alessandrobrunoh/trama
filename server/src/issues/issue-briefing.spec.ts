import { describe, expect, it } from 'vitest';
import { renderIssueBriefing, type IssueBriefingInput } from './issue-briefing.js';

const base: IssueBriefingInput = {
  issue: {
    key: 'BUG-142',
    title: 'Login loops',
    kind: 'bug',
    status: 'in_progress',
    priority: 'high',
  },
  plans: [],
  decisions: [],
  inputRequests: [],
  artifacts: [],
};

describe('renderIssueBriefing', () => {
  it('renders only the header for a simple issue', () => {
    expect(renderIssueBriefing(base)).toBe(
      '# BUG-142 — Login loops\n\nStatus: in progress · Priority: high · Kind: bug\n',
    );
  });

  it('keeps goal, plan approval, decisions, answered input and artifacts', () => {
    const md = renderIssueBriefing({
      ...base,
      issue: { ...base.issue, goal: 'Users stay signed in.', body: 'Cookie is dropped.' },
      plans: [
        {
          artifactId: 'ar_1',
          title: 'Plan: session fix',
          documentId: 'doc_1',
          revision: 'v3',
          approved: { decisionKey: 'ADR-7', revision: 'v2' },
          changedSinceApproval: true,
          proposedDecisionKey: 'ADR-9',
        },
      ],
      decisions: [
        { id: 'd1', key: 'ADR-7', title: 'Plan approval', status: 'accepted', statement: 'Plan v2', rationale: 'Smaller blast radius' },
        { id: 'd2', key: 'ADR-9', title: 'Plan approval', status: 'proposed', statement: 'Plan v3' },
        { id: 'd3', key: 'ADR-3', title: 'Use A', status: 'superseded', statement: 'A', supersededById: 'd1' },
      ],
      inputRequests: [
        { question: 'Keep old cookies?', state: 'open', options: ['yes', 'no'] },
        { question: 'Which store?', state: 'answered', answer: 'Redis' },
        { question: 'Dismissed one', state: 'dismissed' },
      ],
      artifacts: [
        { kind: 'pull_request', title: 'Fix loop', state: 'open', externalId: '#12', ci: 'failing', review: 'none', hasConflicts: true },
      ],
    });

    expect(md).toContain('> Waiting on a person: question: Keep old cookies?; decision ADR-9 to accept or reject.');
    expect(md).toContain('## Goal\n\nUsers stay signed in.');
    expect(md).toContain('changed since approval (approved v2 in ADR-7); ADR-9 proposed and waiting for a person');
    expect(md).toContain('- ADR-7 Plan approval: Plan v2 — because Smaller blast radius');
    expect(md).toContain('- ADR-3 Use A — superseded by ADR-7; do not follow');
    expect(md).toContain('- Open: Keep old cookies? [options: yes / no]');
    expect(md).toContain('- Answered: Which store? → Redis');
    expect(md).not.toContain('Dismissed one');
    expect(md).toContain('- pull request #12: Fix loop (open, CI failing, has conflicts)');
  });
});
