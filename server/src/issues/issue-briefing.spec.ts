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
  artifacts: [],
};

describe('renderIssueBriefing', () => {
  it('renders only the header for a simple issue', () => {
    expect(renderIssueBriefing(base)).toBe(
      '# BUG-142 — Login loops\n\nStatus: in progress · Priority: high · Kind: bug\n',
    );
  });

  it('keeps the goal, description, and artifacts', () => {
    const md = renderIssueBriefing({
      ...base,
      issue: { ...base.issue, goal: 'Users stay signed in.', body: 'Cookie is dropped.' },
      artifacts: [
        { kind: 'pull_request', title: 'Fix loop', state: 'open', externalId: '#12', ci: 'failing', review: 'none', hasConflicts: true },
      ],
    });

    expect(md).toContain('## Goal\n\nUsers stay signed in.');
    expect(md).toContain('## Description\n\nCookie is dropped.');
    expect(md).not.toContain('Decision');
    expect(md).not.toContain('input');
    expect(md).toContain('- pull request #12: Fix loop (open, CI failing, has conflicts)');
  });
});
