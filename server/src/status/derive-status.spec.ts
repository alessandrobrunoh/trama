import type { ExecutionState } from '../contracts/domain.js';
import { createSeed } from '../database/seed/seed-data.js';
import { blockers, deriveStatus, type StatusArtifact, type StatusExecution, type StatusInput } from './derive-status.js';

let n = 0;
const ex = (state: ExecutionState, extra: Partial<StatusExecution> = {}): StatusExecution => ({
  id: `ex${n++}`,
  state,
  createdAt: new Date(2026, 0, 1 + n),
  ...extra,
});
const pr = (extra: Partial<StatusArtifact> = {}): StatusArtifact => ({
  kind: 'pull_request',
  state: 'open',
  ci: 'pending',
  review: 'none',
  hasConflicts: false,
  ...extra,
});
const input = (p: Partial<StatusInput> = {}): StatusInput => ({
  workstream: { acceptanceCriteria: [], statusOverride: null },
  executions: [],
  inputRequests: [],
  artifacts: [],
  decisions: [],
  incomingDependencies: [],
  ...p,
});
const status = (p: Partial<StatusInput> = {}) => deriveStatus(input(p));

describe('deriveStatus', () => {
  it('9 draft: nothing yet', () => expect(status()).toMatchObject({ status: 'draft', rule: 9 }));

  it('8 planned: has an execution or a criterion', () => {
    expect(status({ executions: [ex('queued')] })).toMatchObject({ status: 'planned', rule: 8 });
    expect(status({ workstream: { acceptanceCriteria: [{}] } })).toMatchObject({ status: 'planned', rule: 8 });
  });

  it('7 working: a running execution', () => expect(status({ executions: [ex('queued'), ex('running')] })).toMatchObject({ status: 'working', rule: 7 }));

  it('6 in_review: open non-draft PR, or an execution in review', () => {
    expect(status({ artifacts: [pr()] })).toMatchObject({ status: 'in_review', rule: 6 });
    expect(status({ artifacts: [pr({ state: 'draft' })] }).status).toBe('draft');
    expect(status({ executions: [ex('in_review')] })).toMatchObject({ status: 'in_review', rule: 6 });
  });

  it('5 ready_to_land: approved, passing, no conflicts', () => {
    expect(status({ artifacts: [pr({ review: 'approved', ci: 'passing' })] })).toMatchObject({ status: 'ready_to_land', rule: 5 });
    expect(status({ artifacts: [pr({ review: 'approved', ci: 'pending' })] }).status).toBe('in_review');
    expect(status({ artifacts: [pr({ review: 'changes_requested', ci: 'passing' })] }).status).toBe('in_review');
  });

  it('4 needs_input: open input request, execution needs_input, proposed decision', () => {
    expect(status({ inputRequests: [{ state: 'open' }] })).toMatchObject({ status: 'needs_input', rule: 4 });
    expect(status({ inputRequests: [{ state: 'answered' }] }).status).toBe('draft');
    expect(status({ executions: [ex('needs_input')] })).toMatchObject({ status: 'needs_input', rule: 4 });
    expect(status({ decisions: [{ status: 'proposed' }] })).toMatchObject({ status: 'needs_input', rule: 4 });
    expect(status({ decisions: [{ status: 'accepted' }] }).status).toBe('draft');
  });

  describe('3 blocked', () => {
    it('blocked execution', () => expect(status({ executions: [ex('blocked')] })).toMatchObject({ status: 'blocked', rule: 3 }));
    it('failed execution without a later completed attempt', () => {
      expect(status({ executions: [ex('failed')] }).status).toBe('blocked');
      const failed = ex('failed');
      const retry = ex('completed', { createdAt: new Date(failed.createdAt.getTime() + 1000) });
      expect(status({ executions: [failed, retry] }).status).not.toBe('blocked');
      const earlier = ex('completed', { createdAt: new Date(failed.createdAt.getTime() - 1000) });
      expect(status({ executions: [failed, earlier] }).status).toBe('blocked');
    });
    it('open PR with failing CI or conflicts', () => {
      expect(status({ artifacts: [pr({ ci: 'failing' })] }).status).toBe('blocked');
      expect(status({ artifacts: [pr({ hasConflicts: true, review: 'approved', ci: 'passing' })] }).status).toBe('blocked');
      expect(status({ artifacts: [pr({ state: 'draft', ci: 'failing' })] }).status).toBe('draft');
    });
    it('unresolved incoming dependency', () => {
      expect(status({ incomingDependencies: [{ sourceType: 'workstream', sourceState: 'working' }] })).toMatchObject({ status: 'blocked', rule: 3 });
      expect(status({ incomingDependencies: [{ sourceType: 'workstream', sourceState: 'shipped' }] }).status).toBe('draft');
      expect(status({ incomingDependencies: [{ sourceType: 'execution', sourceState: 'running' }] }).status).toBe('blocked');
      expect(status({ incomingDependencies: [{ sourceType: 'execution', sourceState: 'completed' }] }).status).toBe('draft');
      // the dependent execution is already done: nothing left to wait for
      expect(status({ incomingDependencies: [{ sourceType: 'execution', sourceState: 'running', targetExecutionState: 'completed' }] }).status).toBe('draft');
    });
    it('reports the reasons', () => {
      const e = ex('blocked');
      const reasons = blockers({ executions: [e], artifacts: [pr({ ci: 'failing', hasConflicts: true })], incomingDependencies: [] });
      expect(reasons.map((r) => r.kind).sort()).toEqual(['ci_failing', 'conflict', 'execution_blocked']);
    });
  });

  describe('2 shipped', () => {
    it('healthy deployment or published release', () => {
      expect(status({ artifacts: [{ kind: 'deployment', state: 'healthy' }] })).toMatchObject({ status: 'shipped', rule: 2 });
      expect(status({ artifacts: [{ kind: 'release', state: 'published' }] }).status).toBe('shipped');
      expect(status({ artifacts: [{ kind: 'deployment', state: 'pending' }] }).status).toBe('draft');
    });
    it('all PRs merged and every execution terminal', () => {
      expect(status({ artifacts: [pr({ state: 'merged' })], executions: [ex('completed'), ex('canceled')] }).status).toBe('shipped');
      expect(status({ artifacts: [pr({ state: 'merged' })], executions: [ex('completed'), ex('running')] }).status).toBe('working');
      expect(status({ artifacts: [pr({ state: 'merged' }), pr()], executions: [ex('completed')] }).status).toBe('in_review');
      expect(status({ artifacts: [pr({ state: 'merged' }), pr({ state: 'closed' })], executions: [ex('completed')] }).status).toBe('shipped');
      expect(status({ executions: [ex('completed')] }).status).toBe('planned');
    });
  });

  describe('precedence', () => {
    it('1 override beats everything but derivedStatus is kept', () => {
      const r = status({ workstream: { acceptanceCriteria: [], statusOverride: 'canceled' }, artifacts: [{ kind: 'deployment', state: 'healthy' }] });
      expect(r).toMatchObject({ status: 'canceled', derivedStatus: 'shipped', rule: 1 });
      expect(status({ workstream: { acceptanceCriteria: [{}], statusOverride: 'draft' } })).toMatchObject({ status: 'draft', derivedStatus: 'planned' });
    });
    it('shipped > blocked', () => expect(status({ artifacts: [{ kind: 'release', state: 'published' }], executions: [ex('blocked')] }).status).toBe('shipped'));
    it('blocked > needs_input', () => expect(status({ executions: [ex('blocked')], inputRequests: [{ state: 'open' }] }).status).toBe('blocked'));
    it('needs_input > ready_to_land > in_review > working', () => {
      const approved = pr({ review: 'approved', ci: 'passing' });
      expect(status({ artifacts: [approved], inputRequests: [{ state: 'open' }] }).status).toBe('needs_input');
      expect(status({ artifacts: [approved], executions: [ex('running'), ex('in_review')] }).status).toBe('ready_to_land');
      expect(status({ artifacts: [pr()], executions: [ex('running')] }).status).toBe('in_review');
      expect(status({ executions: [ex('running'), ex('queued')] }).status).toBe('working');
    });
  });
});

describe('seed consistency', () => {
  it('every seeded status equals the derived one', () => {
    const data = createSeed(Date.parse('2026-10-07T12:00:00Z'), 'hash');
    const wsStatus = new Map(data.workstreams.map((w) => [w.id as string, w.status as string]));
    const exState = new Map(data.executions.map((e) => [e.id as string, e.state as string]));
    const mismatches: string[] = [];
    for (const w of data.workstreams) {
      const executions = data.executions.filter((e) => e.workstreamId === w.id);
      const exIds = new Set(executions.map((e) => e.id));
      const incomingDependencies = data.dependencies
        .filter((d) => d.toId === w.id || exIds.has(d.toId!))
        .map((d) => ({
          sourceType: d.fromType!,
          sourceState: (d.fromType === 'workstream' ? wsStatus.get(d.fromId!) : exState.get(d.fromId!))!,
          targetExecutionState: d.toType === 'execution' ? (exState.get(d.toId!) as ExecutionState) : undefined,
        }));
      const r = deriveStatus({
        workstream: { acceptanceCriteria: w.acceptanceCriteria ?? [], statusOverride: w.statusOverride ?? null },
        executions: executions as unknown as StatusExecution[],
        inputRequests: data.inputRequests.filter((i) => i.workstreamId === w.id) as never,
        artifacts: data.artifacts.filter((a) => a.workstreamId === w.id) as never,
        decisions: data.decisions.filter((d) => d.originWorkstreamId === w.id) as never,
        incomingDependencies,
      });
      if (r.status !== w.status || r.derivedStatus !== w.derivedStatus)
        mismatches.push(`${w.key}: seeded ${w.derivedStatus}/${w.status}, engine ${r.derivedStatus}/${r.status} (rule ${r.rule})`);
    }
    expect(mismatches).toEqual([]);
  });
});
