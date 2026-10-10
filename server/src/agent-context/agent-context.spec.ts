import { describe, expect, it } from 'vitest';
import { AgentContextService, type AgentContext } from './agent-context.service.js';

const ctx = (p: Partial<AgentContext> = {}): AgentContext => ({
  key: 'AUTH-1',
  id: 'wk_1',
  title: 'Login',
  status: 'working',
  derivedStatus: 'working',
  statusSource: 'derived',
  delivery: 'merged',
  completion: { achieved: false, gaps: ['criteria_pending'] },
  priority: 'none',
  objective: 'o',
  deltaThreadUrl: '',
  acceptanceCriteria: [],
  plans: [],
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
    const md = AgentContextService.toMarkdown(ctx({ status: 'shipped', statusOverride: 'shipped', statusSource: 'override', derivedStatus: 'working' }));
    expect(md).toContain('Outcome status: shipped (pinned manually; the facts say working)');
  });

  it('marks a historic shipped without criteria as not backed by proof', () => {
    const md = AgentContextService.toMarkdown(ctx({ status: 'shipped', statusSource: 'legacy', derivedStatus: 'shipped', completion: { achieved: true, gaps: [] } }));
    expect(md).toContain('Outcome status: shipped (historic: shipped before acceptance criteria were required');
  });

  it('says nothing about the source of a derived status', () => {
    const md = AgentContextService.toMarkdown(ctx({ status: 'shipped', derivedStatus: 'shipped' }));
    expect(md).not.toContain('pinned');
    expect(md).not.toContain('historic');
  });

  it('shows who vouched for a met criterion and its proof, or that it has none', () => {
    const md = AgentContextService.toMarkdown(
      ctx({
        acceptanceCriteria: [
          {
            id: 'a1', text: 'Login works', state: 'met',
            verifiedBy: { type: 'agent', id: 'agt_1' }, verifiedByName: 'Claude', verifiedAt: '2026-10-09T10:00:00.000Z',
            evidence: { artifactIds: ['art_1'], note: 'tested on staging' },
            evidenceArtifacts: [{ kind: 'pull_request', title: 'Fix login', externalId: '#12' }],
          },
          { id: 'a2', text: 'Logout works', state: 'met', verifiedBy: { type: 'user', id: 'usr_1' }, verifiedByName: 'Ann' },
          { id: 'a3', text: 'Legacy', state: 'met' },
          { id: 'a4', text: 'Open', state: 'pending' },
        ],
      }),
    );
    expect(md).toContain('- [x] Login works _(declared by Claude (agent) on 2026-10-09; proof: pull request #12 Fix login; tested on staging)_');
    expect(md).toContain('- [x] Logout works _(verified by Ann; met without proof)_');
    expect(md).toContain('- [x] Legacy _(met without proof)_');
    expect(md).toContain('- [ ] Open\n');
  });
});
