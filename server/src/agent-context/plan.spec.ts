import { describe, expect, it } from 'vitest';
import { isPlanArtifact, isPlanDecision, resolveWorkstreamPlans, type DecisionStatus } from '../contracts/domain.js';
import { AgentContextService, planLine, type AgentContext } from './agent-context.service.js';

const WS = 'wk_1';
const doc = (over: Record<string, unknown> = {}) => ({ id: 'ar_1', kind: 'document' as const, title: 'Plan: refresh tokens', documentId: 'doc_1', ...over });
const file = (over: Record<string, unknown> = {}) => ({
  id: 'ar_2',
  kind: 'document' as const,
  title: 'Plan — refresh tokens',
  url: 'https://github.com/o/r/blob/main/docs/plan.md',
  externalId: '3f2a9c1d',
  ...over,
});
let n = 0;
const decision = (title: string, status: DecisionStatus, over: Record<string, unknown> = {}) => ({
  key: `ADR-${++n}`,
  title,
  statement: '',
  tags: [] as string[],
  status,
  originWorkstreamId: WS as string | null,
  createdAt: '2026-10-01T10:00:00.000Z',
  decidedAt: status === 'accepted' ? '2026-10-02T10:00:00.000Z' : null,
  ...over,
});
const resolve = (artifacts: object[], decisions: ReturnType<typeof decision>[], versions: [string, number][] = [['doc_1', 3]]) =>
  resolveWorkstreamPlans({ workstreamId: WS, artifacts: artifacts as never, decisions, documentVersions: new Map(versions) });

describe('plan detection', () => {
  it('takes a document artifact whose title starts with Plan', () => {
    expect(isPlanArtifact({ kind: 'document', title: 'Plan: x' })).toBe(true);
    expect(isPlanArtifact({ kind: 'document', title: '  plan for x' })).toBe(true);
    expect(isPlanArtifact({ kind: 'document', title: 'Planning notes' })).toBe(false);
    expect(isPlanArtifact({ kind: 'document', title: 'Rollout plan' })).toBe(false);
    expect(isPlanArtifact({ kind: 'link', title: 'Plan: x' })).toBe(false);
  });

  it('takes a decision titled Plan or tagged plan', () => {
    expect(isPlanDecision({ title: 'Plan for AUTH-1 approved at v3', tags: [] })).toBe(true);
    expect(isPlanDecision({ title: 'Use refresh tokens', tags: ['Plan'] })).toBe(true);
    expect(isPlanDecision({ title: 'Use refresh tokens', tags: ['auth'] })).toBe(false);
  });

  it('returns nothing without a plan', () => {
    expect(resolve([{ id: 'x', kind: 'pull_request', title: 'Plan the PR' }], [])).toEqual([]);
  });

  it('reports the Trama document version as the revision', () => {
    const [p] = resolve([doc()], []);
    expect(p).toMatchObject({ artifactId: 'ar_1', documentId: 'doc_1', revision: 'v3', approved: null, changedSinceApproval: false });
  });

  it('reads the sha of a repository plan as the revision', () => {
    const [p] = resolve([file()], []);
    expect(p).toMatchObject({ revision: '3f2a9c1d', url: 'https://github.com/o/r/blob/main/docs/plan.md' });
    expect(p!.documentId).toBeUndefined();
  });
});

describe('plan approval', () => {
  it('is approved by an accepted decision that cites the revision', () => {
    const d = decision('Plan for AUTH-1 approved at v3', 'accepted');
    const [p] = resolve([doc()], [d]);
    expect(p!.approved).toEqual({ decisionKey: d.key, revision: 'v3' });
    expect(p!.changedSinceApproval).toBe(false);
  });

  it('accepts "rev 3" and "version 3" and reads the statement too', () => {
    expect(resolve([doc()], [decision('Plan for AUTH-1', 'accepted', { statement: 'Approved at rev 3.' })])[0]!.approved?.revision).toBe('v3');
    expect(resolve([doc()], [decision('Plan for AUTH-1 approved at version 3', 'accepted')])[0]!.approved?.revision).toBe('v3');
  });

  it('is not approved while the decision is only proposed, and says which one waits', () => {
    const d = decision('Plan for AUTH-1 approved at v3', 'proposed');
    const [p] = resolve([doc()], [d]);
    expect(p!.approved).toBeNull();
    expect(p!.proposedDecisionKey).toBe(d.key);
  });

  it('ignores rejected and superseded decisions', () => {
    const [p] = resolve([doc()], [decision('Plan approved at v3', 'rejected'), decision('Plan approved at v3', 'superseded')]);
    expect(p!.approved).toBeNull();
  });

  it('does not count an accepted plan decision that cites no revision of a Trama document', () => {
    expect(resolve([doc()], [decision('Plan for AUTH-1 approved', 'accepted')])[0]!.approved).toBeNull();
  });

  it('ignores decisions of other workstreams and decisions that are not about a plan', () => {
    const other = decision('Plan approved at v3', 'accepted', { originWorkstreamId: 'wk_2' });
    const unrelated = decision('Use rotating tokens at v3', 'accepted');
    expect(resolve([doc()], [other, unrelated])[0]!.approved).toBeNull();
  });

  it('flags a plan that moved on after the approval', () => {
    const d = decision('Plan for AUTH-1 approved at v2', 'accepted');
    const [p] = resolve([doc()], [d]);
    expect(p).toMatchObject({ revision: 'v3', approved: { decisionKey: d.key, revision: 'v2' }, changedSinceApproval: true });
  });

  it('the latest accepted approval wins, so a new decision clears the flag', () => {
    const old = decision('Plan approved at v2', 'accepted', { decidedAt: '2026-10-02T10:00:00.000Z' });
    const fresh = decision('Plan approved at v3', 'accepted', { decidedAt: '2026-10-05T10:00:00.000Z' });
    const [p] = resolve([doc()], [old, fresh]);
    expect(p).toMatchObject({ approved: { decisionKey: fresh.key, revision: 'v3' }, changedSinceApproval: false });
  });

  it('matches a repository plan by sha, whichever side is abbreviated', () => {
    const same = resolve([file()], [decision('Plan for AUTH-1 approved at 3f2a9c1', 'accepted')])[0]!;
    expect(same.approved?.revision).toBe('3f2a9c1');
    expect(same.changedSinceApproval).toBe(false);
    const moved = resolve([file({ externalId: '9b8c7d6e' })], [decision('Plan for AUTH-1 approved at 3f2a9c1', 'accepted')])[0]!;
    expect(moved.changedSinceApproval).toBe(true);
  });

  it('with several plans a decision must name the plan or cite its sha', () => {
    const d = decision('Plan: refresh tokens approved at v3', 'accepted');
    const other = decision('Plan approved at 3f2a9c1', 'accepted');
    const plans = resolve([doc(), file({ title: 'Plan — rollout' })], [d, other]);
    expect(plans[0]!.approved?.decisionKey).toBe(d.key);
    expect(plans[1]!.approved?.decisionKey).toBe(other.key);
  });

  it('a repository link without a sha is approved by any accepted plan decision', () => {
    const [p] = resolve([file({ externalId: undefined })], [decision('Plan for AUTH-1 approved', 'accepted')]);
    expect(p).toMatchObject({ revision: null, approved: { revision: null }, changedSinceApproval: false });
  });
});

describe('plan in the briefing', () => {
  const plan = (over = {}) => ({ artifactId: 'ar_1', title: 'Plan: refresh tokens', documentId: 'doc_1', revision: 'v3', approved: null, changedSinceApproval: false, ...over });

  it('says when the plan is approved', () => {
    const line = planLine(plan({ approved: { decisionKey: 'ADR-4', revision: 'v3' } }));
    expect(line).toBe('- Plan: refresh tokens — Trama document doc_1 · rev v3 · approved at v3 (ADR-4)');
  });

  it('tells an agent to propose a decision when there is none', () => {
    expect(planLine(plan())).toContain('not approved: propose a decision');
  });

  it('names the proposed decision that waits for a person', () => {
    expect(planLine(plan({ proposedDecisionKey: 'ADR-5' }))).toContain('not approved yet: ADR-5 is proposed and waits for a person');
  });

  it('tells an agent the plan changed since approval', () => {
    const line = planLine(plan({ revision: 'v4', approved: { decisionKey: 'ADR-4', revision: 'v3' }, changedSinceApproval: true }));
    expect(line).toContain('plan changed since approval (approved v3 in ADR-4) — propose a new decision');
  });

  const ctx = (plans: AgentContext['plans']): AgentContext =>
    ({
      key: 'AUTH-1', id: 'wk_1', title: 'Login', status: 'working', derivedStatus: 'working', delivery: 'none',
      completion: { achieved: false, gaps: [] }, priority: 'none', objective: 'o', deltaThreadUrl: '', acceptanceCriteria: [], plans,
      teams: { owner: { key: 'AUTH', name: 'Auth' }, participating: [] }, repositories: [], dependencies: { blockedBy: [], blocking: [] },
      decisions: [], issues: [], artifacts: [], openInputRequests: [], recentProgress: [],
    }) as AgentContext;

  it('adds a Plan section only when a plan exists', () => {
    expect(AgentContextService.toMarkdown(ctx([]))).not.toContain('## Plan');
    const md = AgentContextService.toMarkdown(ctx([plan({ approved: { decisionKey: 'ADR-4', revision: 'v3' } })]));
    expect(md).toContain('## Plan\n\n- Plan: refresh tokens — Trama document doc_1 · rev v3 · approved at v3 (ADR-4)');
  });
});
