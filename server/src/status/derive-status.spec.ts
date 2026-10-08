import { createSeed } from '../database/seed/seed-data.js';
import {
  blockers,
  deriveStatus,
  type StatusArtifact,
  type StatusInput,
} from './derive-status.js';

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
  inputRequests: [],
  artifacts: [],
  decisions: [],
  incomingDependencies: [],
  ...p,
});
const status = (p: Partial<StatusInput> = {}) => deriveStatus(input(p));

describe('deriveStatus', () => {
  it('9 draft: nothing yet', () =>
    expect(status()).toMatchObject({ status: 'draft', rule: 9 }));

  it('8 planned: has a criterion', () => {
    expect(
      status({ workstream: { acceptanceCriteria: [{ state: 'pending' }] } }),
    ).toMatchObject({ status: 'planned', rule: 8 });
  });

  it('7 working: a criterion in progress, a build/test report, or an issue in progress', () => {
    expect(
      status({
        workstream: { acceptanceCriteria: [{ state: 'in_progress' }] },
      }),
    ).toMatchObject({ status: 'working', rule: 7 });
    expect(
      status({ artifacts: [{ kind: 'build', state: 'running' }] }),
    ).toMatchObject({ status: 'working', rule: 7 });
    expect(
      status({ artifacts: [{ kind: 'document', state: 'published' }] }).status,
    ).toBe('draft');
    expect(
      status({ issues: [{ status: 'in_progress' }, { status: 'backlog' }] }),
    ).toMatchObject({ status: 'working', rule: 7 });
    expect(
      status({ issues: [{ status: 'in_progress' }, { status: 'in_review' }] })
        .status,
    ).toBe('working');
    expect(status({ issues: [{ status: 'canceled' }] }).status).toBe('draft');
  });

  it('6 in_review: open non-draft PR, or a linked issue in review while none is in progress', () => {
    expect(status({ artifacts: [pr()] })).toMatchObject({
      status: 'in_review',
      rule: 6,
    });
    expect(status({ artifacts: [pr({ state: 'draft' })] }).status).toBe(
      'draft',
    );
    expect(
      status({ issues: [{ status: 'in_review' }, { status: 'done' }] }),
    ).toMatchObject({ status: 'in_review', rule: 6 });
    expect(
      status({ issues: [{ status: 'in_review' }, { status: 'canceled' }] })
        .status,
    ).toBe('in_review');
  });

  it('5 ready_to_land: approved, passing, no conflicts', () => {
    expect(
      status({ artifacts: [pr({ review: 'approved', ci: 'passing' })] }),
    ).toMatchObject({ status: 'ready_to_land', rule: 5 });
    expect(
      status({ artifacts: [pr({ review: 'approved', ci: 'pending' })] }).status,
    ).toBe('in_review');
    expect(
      status({
        artifacts: [pr({ review: 'changes_requested', ci: 'passing' })],
      }).status,
    ).toBe('in_review');
  });

  it('4 needs_input: open input request or proposed decision', () => {
    expect(status({ inputRequests: [{ state: 'open' }] })).toMatchObject({
      status: 'needs_input',
      rule: 4,
    });
    expect(status({ inputRequests: [{ state: 'answered' }] }).status).toBe(
      'draft',
    );
    expect(status({ decisions: [{ status: 'proposed' }] })).toMatchObject({
      status: 'needs_input',
      rule: 4,
    });
    expect(status({ decisions: [{ status: 'accepted' }] }).status).toBe(
      'draft',
    );
  });

  describe('3 blocked', () => {
    it('open PR with failing CI or conflicts', () => {
      expect(status({ artifacts: [pr({ ci: 'failing' })] }).status).toBe(
        'blocked',
      );
      expect(
        status({
          artifacts: [
            pr({ hasConflicts: true, review: 'approved', ci: 'passing' }),
          ],
        }).status,
      ).toBe('blocked');
      expect(
        status({ artifacts: [pr({ state: 'draft', ci: 'failing' })] }).status,
      ).toBe('draft');
    });
    it('unresolved incoming workstream dependency', () => {
      expect(
        status({
          incomingDependencies: [
            { sourceType: 'workstream', sourceState: 'working' },
          ],
        }),
      ).toMatchObject({ status: 'blocked', rule: 3 });
      expect(
        status({
          incomingDependencies: [
            { sourceType: 'workstream', sourceState: 'shipped' },
          ],
        }).status,
      ).toBe('draft');
    });
  });

  it('2 shipped: healthy deployment, published release, every live PR merged, or every linked issue done', () => {
    expect(
      status({ artifacts: [{ kind: 'deployment', state: 'healthy' }] }),
    ).toMatchObject({ status: 'shipped', rule: 2 });
    expect(
      status({ artifacts: [{ kind: 'release', state: 'published' }] }).status,
    ).toBe('shipped');
    expect(
      status({ artifacts: [pr({ state: 'merged' }), pr({ state: 'closed' })] })
        .status,
    ).toBe('shipped');
    expect(
      status({ artifacts: [pr({ state: 'merged' }), pr()] }).status,
    ).not.toBe('shipped');
    expect(
      status({ issues: [{ status: 'done' }, { status: 'done' }] }),
    ).toMatchObject({ status: 'shipped', rule: 2 });
    expect(
      status({ issues: [{ status: 'done' }, { status: 'canceled' }] }).status,
    ).toBe('shipped');
    expect(
      status({ issues: [{ status: 'done' }, { status: 'todo' }] }).status,
    ).toBe('draft');
  });

  it('1 override wins but derived status is still reported', () => {
    const result = status({
      workstream: { acceptanceCriteria: [], statusOverride: 'canceled' },
      artifacts: [pr({ review: 'approved', ci: 'passing' })],
    });
    expect(result).toMatchObject({
      status: 'canceled',
      derivedStatus: 'ready_to_land',
      rule: 1,
    });
  });

  it('blockers lists ci, conflicts and dependencies', () => {
    const reasons = blockers({
      artifacts: [pr({ id: 'a1', ci: 'failing', hasConflicts: true })],
      incomingDependencies: [
        { sourceType: 'workstream', sourceState: 'working' },
      ],
    });
    expect(reasons.map((r) => r.kind)).toEqual([
      'ci_failing',
      'conflict',
      'dependency',
    ]);
  });
});

describe('demo seed still covers every stored status', () => {
  it('includes a delta thread on every workstream', () => {
    const data = createSeed(Date.parse('2026-10-07T12:00:00Z'), 'hash');
    expect(
      data.workstreams.every((w) =>
        String(w.deltaThreadUrl).includes('delta.dev'),
      ),
    ).toBe(true);
  });
});
