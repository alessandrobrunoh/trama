import { createSeed } from '../database/seed/seed-data.js';
import {
  blockers,
  deriveDelivery,
  deriveStatus,
  nextShippedAt,
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

  describe('2 shipped (outcome, not delivery)', () => {
    const met = (n = 1) => ({
      acceptanceCriteria: Array.from({ length: n }, () => ({ state: 'met' })),
      statusOverride: null,
    });

    it('delivery evidence alone never ships a workstream with no criteria', () => {
      const evidence: Partial<StatusInput>[] = [
        { artifacts: [{ kind: 'deployment', state: 'healthy' }] },
        { artifacts: [{ kind: 'release', state: 'published' }] },
        { artifacts: [pr({ state: 'merged' }), pr({ state: 'closed' })] },
        { issues: [{ status: 'done' }, { status: 'done' }] },
        { issues: [{ status: 'done' }, { status: 'canceled' }] },
      ];
      for (const e of evidence) {
        const r = status(e);
        expect(r.status).not.toBe('shipped');
        expect(r.completion).toEqual({ achieved: false, gaps: ['no_criteria'] });
      }
      expect(
        status({ artifacts: [{ kind: 'deployment', state: 'healthy' }] }),
      ).toMatchObject({ status: 'working', delivery: 'deployed' });
      expect(
        status({ issues: [{ status: 'done' }], artifacts: [pr({ state: 'merged' })] })
          .status,
      ).toBe('working');
      expect(status({ issues: [{ status: 'done' }] }).status).toBe('draft');
    });

    it('every issue done plus every criterion met ships; one open issue does not', () => {
      expect(
        status({ workstream: met(), issues: [{ status: 'done' }, { status: 'canceled' }] }),
      ).toMatchObject({ status: 'shipped', rule: 2, delivery: 'none' });
      expect(
        status({ workstream: met(), issues: [{ status: 'done' }, { status: 'todo' }] }).status,
      ).not.toBe('shipped');
      expect(
        status({
          workstream: met(),
          artifacts: [pr({ state: 'merged' }), pr()],
        }).status,
      ).not.toBe('shipped');
    });

    it('a legacyShipped workstream with no criteria keeps shipping (history unchanged)', () => {
      const legacy = { acceptanceCriteria: [], statusOverride: null, legacyShipped: true };
      expect(
        status({ workstream: legacy, artifacts: [pr({ state: 'merged' })] }),
      ).toMatchObject({
        status: 'shipped',
        completion: { achieved: true, gaps: [] },
      });
      expect(status({ workstream: legacy, issues: [{ status: 'done' }] }).status).toBe('shipped');
      // The grandfathering covers only the missing criteria: everything else still counts.
      expect(status({ workstream: legacy }).completion.gaps).toEqual(['no_delivery']);
      expect(
        status({
          workstream: legacy,
          artifacts: [pr({ state: 'merged' })],
          inputRequests: [{ state: 'open' }],
        }).status,
      ).toBe('needs_input');
      // Once it has a criterion, the criterion rules apply as for any workstream.
      expect(
        status({
          workstream: { acceptanceCriteria: [{ state: 'pending' }], legacyShipped: true },
          artifacts: [pr({ state: 'merged' })],
        }).status,
      ).toBe('working');
    });

    it('delivery evidence plus every criterion met ships', () => {
      expect(
        status({
          workstream: met(2),
          artifacts: [pr({ state: 'merged' })],
        }),
      ).toMatchObject({ status: 'shipped', rule: 2, delivery: 'merged' });
    });

    it('a merged PR alone does not ship while criteria are unmet', () => {
      const r = status({
        workstream: {
          acceptanceCriteria: [{ state: 'met' }, { state: 'pending' }],
        },
        artifacts: [pr({ state: 'merged' })],
      });
      expect(r.status).toBe('working');
      expect(r.delivery).toBe('merged');
    });

    it('a healthy deployment or release does not ship while criteria are unmet', () => {
      for (const artifact of [
        { kind: 'deployment', state: 'healthy' },
        { kind: 'release', state: 'published' },
      ] as StatusArtifact[]) {
        const r = status({
          workstream: { acceptanceCriteria: [{ state: 'pending' }] },
          artifacts: [artifact],
        });
        expect(r.status).toBe('working');
        expect(r.status).not.toBe('shipped');
      }
    });

    it('every linked issue done does not ship while criteria are unmet', () => {
      expect(
        status({
          workstream: { acceptanceCriteria: [{ state: 'in_progress' }] },
          issues: [{ status: 'done' }],
        }).status,
      ).not.toBe('shipped');
    });

    it('open blockers take precedence over delivery evidence', () => {
      expect(
        status({
          workstream: met(),
          artifacts: [pr({ state: 'merged' }), pr({ ci: 'failing' })],
        }),
      ).toMatchObject({ status: 'blocked', rule: 3 });
      expect(
        status({
          workstream: met(),
          artifacts: [{ kind: 'deployment', state: 'healthy' }],
          incomingDependencies: [
            { sourceType: 'workstream', sourceState: 'working' },
          ],
        }),
      ).toMatchObject({ status: 'blocked', delivery: 'deployed' });
    });

    it('an open input request takes precedence over delivery evidence', () => {
      expect(
        status({
          workstream: met(),
          artifacts: [pr({ state: 'merged' })],
          inputRequests: [{ state: 'open' }],
        }),
      ).toMatchObject({ status: 'needs_input', rule: 4, delivery: 'merged' });
    });

    it('a proposed decision takes precedence over delivery evidence', () => {
      expect(
        status({
          workstream: met(),
          artifacts: [{ kind: 'release', state: 'published' }],
          decisions: [{ status: 'proposed' }],
        }),
      ).toMatchObject({ status: 'needs_input', delivery: 'released' });
      expect(
        status({
          workstream: met(),
          artifacts: [{ kind: 'release', state: 'published' }],
          decisions: [{ status: 'accepted' }],
        }).status,
      ).toBe('shipped');
    });

    it('AUTH-12: PR #201 merged, criteria pending, security review proposed is not shipped', () => {
      const r = status({
        workstream: {
          acceptanceCriteria: [
            { state: 'met' },
            { state: 'pending' }, // Safari OAuth tests
            { state: 'pending' }, // Session recovery verification
          ],
        },
        artifacts: [pr({ state: 'merged' })], // PR #201
        decisions: [{ status: 'proposed' }], // security-review decision
        issues: [{ status: 'done' }],
      });
      expect(r).toMatchObject({
        status: 'needs_input',
        derivedStatus: 'needs_input',
        delivery: 'merged',
      });
      expect(r.status).not.toBe('shipped');
      // Once the decision is accepted, the open criteria still keep it from shipping.
      expect(
        status({
          workstream: {
            acceptanceCriteria: [{ state: 'met' }, { state: 'pending' }],
          },
          artifacts: [pr({ state: 'merged' })],
          decisions: [{ status: 'accepted' }],
          issues: [{ status: 'done' }],
        }),
      ).toMatchObject({ status: 'working', delivery: 'merged' });
    });
  });

  describe('completion gaps', () => {
    const met = { acceptanceCriteria: [{ state: 'met' }], statusOverride: null };
    const merged = [pr({ state: 'merged' })];

    it('no gaps means achieved, and equals the derived shipped status', () => {
      const r = status({ workstream: met, artifacts: merged });
      expect(r.completion).toEqual({ achieved: true, gaps: [] });
      expect(r.derivedStatus).toBe('shipped');
    });

    it('no_criteria', () => {
      expect(status({ artifacts: merged }).completion.gaps).toEqual(['no_criteria']);
      expect(status().completion.gaps).toEqual(['no_criteria', 'no_delivery']);
    });

    it('criteria_pending covers pending and in_progress criteria', () => {
      for (const state of ['pending', 'in_progress']) {
        expect(
          status({
            workstream: { acceptanceCriteria: [{ state: 'met' }, { state }] },
            artifacts: merged,
          }).completion,
        ).toEqual({ achieved: false, gaps: ['criteria_pending'] });
      }
    });

    it('blocked (failing PR, conflict, unresolved dependency)', () => {
      const gaps = (p: Partial<StatusInput>) =>
        status({ workstream: met, artifacts: merged, ...p }).completion.gaps;
      expect(gaps({ artifacts: [...merged, pr({ ci: 'failing' })] })).toEqual(['blocked', 'no_delivery']); // the open PR is not delivered
      expect(gaps({ artifacts: [...merged, pr({ hasConflicts: true })] })).toEqual(['blocked', 'no_delivery']);
      expect(
        gaps({ incomingDependencies: [{ sourceType: 'workstream', sourceState: 'working' }] }),
      ).toEqual(['blocked']);
    });

    it('needs_input (open input request or proposed decision)', () => {
      const gaps = (p: Partial<StatusInput>) =>
        status({ workstream: met, artifacts: merged, ...p }).completion.gaps;
      expect(gaps({ inputRequests: [{ state: 'open' }] })).toEqual(['needs_input']);
      expect(gaps({ decisions: [{ status: 'proposed' }] })).toEqual(['needs_input']);
      expect(gaps({ inputRequests: [{ state: 'answered' }], decisions: [{ status: 'accepted' }] })).toEqual([]);
    });

    it('no_delivery: met criteria without merged work or finished issues', () => {
      expect(status({ workstream: met }).completion.gaps).toEqual(['no_delivery']);
      expect(
        status({ workstream: met, artifacts: [pr()] }).completion.gaps,
      ).toEqual(['no_delivery']);
      expect(
        status({ workstream: met, issues: [{ status: 'done' }, { status: 'todo' }] }).completion.gaps,
      ).toEqual(['no_delivery']);
    });

    it('gaps accumulate in a stable order', () => {
      expect(
        status({
          inputRequests: [{ state: 'open' }],
          incomingDependencies: [{ sourceType: 'workstream', sourceState: 'working' }],
        }).completion.gaps,
      ).toEqual(['no_criteria', 'blocked', 'needs_input', 'no_delivery']);
    });

    it('a manual override changes the status but not the completion', () => {
      const r = status({ workstream: { acceptanceCriteria: [], statusOverride: 'shipped' } });
      expect(r).toMatchObject({ status: 'shipped', derivedStatus: 'draft' });
      expect(r.completion.achieved).toBe(false);
    });
  });

  describe('delivery', () => {
    it('is none without delivery artifacts', () => {
      expect(deriveDelivery({ artifacts: [] })).toBe('none');
      expect(
        deriveDelivery({
          artifacts: [pr({ state: 'draft' }), pr({ state: 'closed' })],
        }),
      ).toBe('none');
    });
    it('in_review for an open PR, even if another one merged', () => {
      expect(deriveDelivery({ artifacts: [pr()] })).toBe('in_review');
      expect(
        deriveDelivery({ artifacts: [pr({ state: 'merged' }), pr()] }),
      ).toBe('in_review');
    });
    it('merged when every live PR merged; closed PRs are ignored', () => {
      expect(
        deriveDelivery({
          artifacts: [pr({ state: 'merged' }), pr({ state: 'closed' })],
        }),
      ).toBe('merged');
    });
    it('released beats merged, deployed beats released', () => {
      expect(
        deriveDelivery({
          artifacts: [
            pr({ state: 'merged' }),
            { kind: 'release', state: 'published' },
          ],
        }),
      ).toBe('released');
      expect(
        deriveDelivery({
          artifacts: [
            { kind: 'release', state: 'published' },
            { kind: 'deployment', state: 'healthy' },
          ],
        }),
      ).toBe('deployed');
      expect(
        deriveDelivery({
          artifacts: [{ kind: 'deployment', state: 'failed' }],
        }),
      ).toBe('none');
    });
    it('is reported even when the status is overridden', () => {
      expect(
        status({
          workstream: { acceptanceCriteria: [], statusOverride: 'working' },
          artifacts: [pr({ state: 'merged' })],
        }),
      ).toMatchObject({ status: 'working', delivery: 'merged' });
    });
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

describe('nextShippedAt', () => {
  const t0 = new Date('2026-01-01T00:00:00Z');
  const now = new Date('2026-02-01T00:00:00Z');

  it('stamps the moment a workstream becomes shipped', () => {
    expect(nextShippedAt('shipped', null, now)).toBe(now);
    expect(nextShippedAt('shipped', undefined, now)).toBe(now);
  });
  it('keeps the existing timestamp while it stays shipped', () => {
    expect(nextShippedAt('shipped', t0, now)).toBe(t0);
  });
  it.each(['working', 'blocked', 'needs_input', 'planned', 'draft'] as const)(
    'clears the timestamp when the status is %s',
    (status) => {
      expect(nextShippedAt(status, t0, now)).toBeNull();
    },
  );
});
