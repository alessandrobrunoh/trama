import { describe, expect, it } from 'vitest';
import { AgentContextService, type AgentContext } from './agent-context.service.js';

const ctx = (p: Partial<AgentContext> = {}): AgentContext => ({
  key: 'AUTH-1',
  id: 'wk_1',
  title: 'Login',
  status: 'working',
  derivedStatus: 'working',
  delivery: 'merged',
  completion: { achieved: false, gaps: ['criteria_pending'] },
  priority: 'none',
  objective: 'o',
  deltaThreadUrl: '',
  acceptanceCriteria: [],
  teams: { owner: { key: 'AUTH', name: 'Auth' }, participating: [] },
  repositories: [],
  dependencies: { blockedBy: [], blocking: [] },
  decisions: [],
  issues: [],
  artifacts: [],
  openInputRequests: [],
  recentProgress: [],
  ...p,
});

describe('agent briefing completion', () => {
  it('lists the missing gaps and warns when delivered but not done', () => {
    const md = AgentContextService.toMarkdown(ctx({ completion: { achieved: false, gaps: ['no_criteria', 'needs_input'] } }));
    expect(md).toContain('Outcome not achieved. Missing: no acceptance criteria');
    expect(md).toContain('waiting on a person');
    expect(md).toContain('Do not treat this work as done.');
  });

  it('says nothing is missing when achieved', () => {
    const md = AgentContextService.toMarkdown(ctx({ status: 'shipped', completion: { achieved: true, gaps: [] } }));
    expect(md).toContain('Outcome achieved: nothing is missing.');
  });

  it('marks a pinned status as not derived', () => {
    const md = AgentContextService.toMarkdown(ctx({ status: 'shipped', statusOverride: 'shipped', derivedStatus: 'working' }));
    expect(md).toContain('Outcome status: shipped (pinned manually; the facts say working)');
  });
});
