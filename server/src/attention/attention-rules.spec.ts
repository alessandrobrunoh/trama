import { computeAttention, itemState, sortItems, type AttentionData, type AWorkstream, type RawAttentionItem } from './attention-rules.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const ws = (p: Partial<AWorkstream> = {}): AWorkstream => ({
  id: 'w1',
  key: 'AUTH-1',
  title: 'Rotate tokens',
  ownerTeamId: 't1',
  participatingTeamIds: ['t2'],
  accountableUserId: 'alice',
  acceptanceCriteria: [],
  status: 'working',
  derivedStatus: 'working',
  statusOverride: null,
  targetDate: null,
  updatedAt: day(-1),
  ...p,
});

const data = (p: Partial<AttentionData> = {}): AttentionData => ({
  now: NOW,
  teams: [
    { id: 't1', name: 'Identity', memberIds: ['bob'] },
    { id: 't2', name: 'Web', memberIds: ['carol'] },
    { id: 't3', name: 'Infra', memberIds: ['dave'] },
  ],
  names: new Map([['alice', 'Alice'], ['ag1', 'Claude']]),
  adminIds: ['alice'],
  workstreams: [ws()],
  inputRequests: [],
  artifacts: [],
  decisions: [],
  dependencies: [],
  issues: [],
  ...p,
});

const pr = (p: object = {}) => ({
  id: 'a1', workstreamId: 'w1', kind: 'pull_request' as const, title: 'Add rotation', externalId: '#12', state: 'open' as const,
  ci: 'pending' as const, review: 'none' as const, hasConflicts: false, createdAt: day(-3), updatedAt: day(-2), ...p,
});
const kinds = (items: RawAttentionItem[]) => items.map((i) => i.kind).sort();

describe('computeAttention', () => {
  it('input_requested: assignee only, else the accountable user', () => {
    const r = { id: 'r1', workstreamId: 'w1', question: 'Which TTL?', requestedBy: { type: 'agent' as const, id: 'ag1' }, state: 'open' as const, createdAt: day(-1) };
    const [a] = computeAttention(data({ inputRequests: [r] }));
    expect(a).toMatchObject({ id: 'input_requested:r1', severity: 'high', since: r.createdAt });
    expect([...a.audience]).toEqual(['alice']);
    expect(a.detail).toContain('Claude');
    const [b] = computeAttention(data({ inputRequests: [{ ...r, assigneeUserId: 'zed' }] }));
    expect([...b.audience]).toEqual(['zed']);
    expect(computeAttention(data({ inputRequests: [{ ...r, state: 'answered' }] }))).toEqual([]);
  });

  it('needs_decision: proposed decisions on workstreams, audience = relevant users', () => {
    const d = { id: 'd1', key: 'ADR-1', title: 'Use rotation', status: 'proposed' as const, originWorkstreamId: 'w1', relatedWorkstreamIds: [], proposedBy: { type: 'agent' as const, id: 'ag1' }, createdAt: day(-1) };
    const [i] = computeAttention(data({ decisions: [d] }));
    expect(i).toMatchObject({ kind: 'needs_decision', severity: 'high', decisionId: 'd1', workstreamId: 'w1' });
    expect([...i.audience].sort()).toEqual(['alice', 'bob', 'carol']);
    expect(computeAttention(data({ decisions: [{ ...d, status: 'accepted' as never }] }))).toEqual([]);
  });

  it('review_requested is for the accountable user and owner team only', () => {
    const [i] = computeAttention(data({ artifacts: [pr({ review: 'requested' })] }));
    expect(i).toMatchObject({ kind: 'review_requested', severity: 'medium' });
    expect([...i.audience].sort()).toEqual(['alice', 'bob']);
  });

  it('ci_failed (high) and conflict (medium) apply to open PRs only', () => {
    const items = computeAttention(data({ artifacts: [pr({ ci: 'failing', hasConflicts: true })] }));
    expect(kinds(items)).toEqual(['ci_failed', 'conflict']);
    expect(items.find((i) => i.kind === 'ci_failed')!.severity).toBe('high');
    expect(computeAttention(data({ artifacts: [pr({ ci: 'failing', state: 'merged' })] }))).toEqual([]);
    expect(computeAttention(data({ artifacts: [pr({ ci: 'failing', state: 'draft' })] }))).toEqual([]);
  });

  it('ready_to_land: approved, passing, no conflicts', () => {
    expect(kinds(computeAttention(data({ artifacts: [pr({ review: 'approved', ci: 'passing' })] })))).toEqual(['ready_to_land']);
    expect(computeAttention(data({ artifacts: [pr({ review: 'approved', ci: 'passing', hasConflicts: true })] })).some((i) => i.kind === 'ready_to_land')).toBe(false);
  });

  it('ci-caused blocking only yields ci_failed, and shipped workstreams raise nothing', () => {
    const blocked = ws({ status: 'blocked', derivedStatus: 'blocked' });
    expect(kinds(computeAttention(data({ workstreams: [blocked], artifacts: [pr({ ci: 'failing' })] })))).toEqual(['ci_failed']);
    expect(computeAttention(data({ workstreams: [ws({ status: 'shipped', derivedStatus: 'shipped' })], artifacts: [pr({ ci: 'failing' })] }))).toEqual([]);
  });

  it('dependency: waiting on another team\'s unshipped workstream (low)', () => {
    const src = ws({ id: 'w2', key: 'INF-1', ownerTeamId: 't3', status: 'working', derivedStatus: 'working' });
    const target = ws({ status: 'blocked', derivedStatus: 'blocked' });
    const dep = { id: 'dp1', fromType: 'workstream' as const, fromId: 'w2', toType: 'workstream' as const, toId: 'w1', createdAt: day(-4) };
    const items = computeAttention(data({ workstreams: [target, src], dependencies: [dep] }));
    expect(items.filter((i) => i.kind === 'dependency')).toMatchObject([{ id: 'dependency:dp1', severity: 'low', workstreamId: 'w1' }]);
    // shipped source or same team: nothing
    expect(computeAttention(data({ workstreams: [target, { ...src, status: 'shipped', derivedStatus: 'shipped' }], dependencies: [dep] })).some((i) => i.kind === 'dependency')).toBe(false);
    expect(computeAttention(data({ workstreams: [target, { ...src, ownerTeamId: 't1' }], dependencies: [dep] })).some((i) => i.kind === 'dependency')).toBe(false);
  });

  it('deadline: within 3 days medium, overdue high, not when shipped or far away', () => {
    const at = (n: number, extra: Partial<AWorkstream> = {}) => computeAttention(data({ workstreams: [ws({ targetDate: day(n), ...extra })] }));
    expect(at(2)[0]).toMatchObject({ kind: 'deadline', severity: 'medium' });
    expect(at(-2)[0]).toMatchObject({ kind: 'deadline', severity: 'high' });
    expect(at(10)).toEqual([]);
    expect(at(1, { status: 'shipped', derivedStatus: 'shipped' })).toEqual([]);
    expect(at(1)[0].since).toEqual(day(1));
  });

  it('ready_to_ship: all criteria met, nothing open, nothing deployed', () => {
    const done = ws({ acceptanceCriteria: [{ state: 'met' }, { state: 'met' }] });
    expect(kinds(computeAttention(data({ workstreams: [done], artifacts: [pr({ state: 'merged' })] })))).toEqual(['ready_to_ship']);
    expect(computeAttention(data({ workstreams: [ws({ acceptanceCriteria: [{ state: 'met' }, { state: 'pending' }] })] }))).toEqual([]);
    expect(computeAttention(data({ workstreams: [done], artifacts: [pr()] })).some((i) => i.kind === 'ready_to_ship')).toBe(false);
    expect(computeAttention(data({ workstreams: [done], artifacts: [{ ...pr({ state: 'pending' }), kind: 'deployment' as const }] })).some((i) => i.kind === 'ready_to_ship')).toBe(false);
  });

  describe('proof_missing', () => {
    const merged = (extra: object = {}) => pr({ state: 'merged', createdAt: day(-5), ...extra });
    const delivered = (p: Partial<AWorkstream> = {}) =>
      ws({ delivery: 'merged', acceptanceCriteria: [{ state: 'met' }, { state: 'pending' }], ...p });
    const proof = (items: RawAttentionItem[]) => items.filter((i) => i.kind === 'proof_missing');

    it('fires for the accountable person when delivered work has met criteria without evidence', () => {
      const [i] = proof(computeAttention(data({ workstreams: [delivered()], artifacts: [merged()] })));
      expect(i).toMatchObject({ id: 'proof_missing:w1', severity: 'low', workstreamId: 'w1' });
      expect(i.title).toContain('1 met criterion has no evidence');
      expect([...i.audience]).toEqual(['alice']);
    });

    it('falls back to the owner side when nobody is accountable', () => {
      const [i] = proof(computeAttention(data({ workstreams: [delivered({ accountableUserId: null })], artifacts: [merged()] })));
      expect([...i.audience]).toEqual(['bob']);
    });

    it('does not fire before delivery, when nothing is met, or when every met criterion has evidence', () => {
      const at = (w: AWorkstream) => proof(computeAttention(data({ workstreams: [w], artifacts: [merged()] })));
      expect(at(delivered({ delivery: 'in_review' }))).toEqual([]);
      expect(at(delivered({ delivery: 'none' }))).toEqual([]);
      expect(at(delivered({ delivery: undefined }))).toEqual([]);
      expect(at(delivered({ acceptanceCriteria: [{ state: 'pending' }, { state: 'in_progress' }] }))).toEqual([]);
      expect(at(delivered({ acceptanceCriteria: [{ state: 'met', evidence: { artifactIds: ['a1'] } }, { state: 'pending' }] }))).toEqual([]);
    });

    it('counts an evidence note (an agent may have set it) as evidence; a blank note is none', () => {
      const withNote = delivered({ acceptanceCriteria: [{ state: 'met', evidence: { artifactIds: [], note: 'checked on staging' } }, { state: 'pending' }] });
      expect(proof(computeAttention(data({ workstreams: [withNote], artifacts: [merged()] })))).toEqual([]);
      const blank = delivered({ acceptanceCriteria: [{ state: 'met', evidence: { artifactIds: [], note: '  ' } }, { state: 'pending' }] });
      expect(proof(computeAttention(data({ workstreams: [blank], artifacts: [merged()] })))).toHaveLength(1);
    });

    it('is one item per workstream, whatever the number of criteria or agent actions', () => {
      const w = delivered({ acceptanceCriteria: [{ state: 'met' }, { state: 'met' }, { state: 'met' }, { state: 'pending' }] });
      const items = proof(computeAttention(data({ workstreams: [w], artifacts: [merged()] })));
      expect(items).toHaveLength(1);
      expect(items[0].title).toContain('3 met criteria have no evidence');
    });

    it('keeps a stable id and since, so a dismissal survives more agent activity', () => {
      const first = proof(computeAttention(data({ workstreams: [delivered({ updatedAt: day(-2) })], artifacts: [merged()] })))[0];
      const later = proof(
        computeAttention(
          data({ workstreams: [delivered({ updatedAt: day(-1), acceptanceCriteria: [{ state: 'met' }, { state: 'met' }] })], artifacts: [merged()] }),
        ),
      )[0];
      expect(later.id).toBe(first.id);
      expect(later.since).toEqual(first.since);
      expect(first.since).toEqual(day(-5));
      expect(itemState(later, { state: 'dismissed', since: first.since }, NOW)).toEqual({ state: 'dismissed' });
    });

    it('uses the event-log timestamp when there is one', () => {
      const since = new Map([['proof_missing:w1', day(-9)]]);
      const [i] = proof(computeAttention(data({ workstreams: [delivered()], artifacts: [merged()], since })));
      expect(i.since).toEqual(day(-9));
    });

    it('raises nothing for shipped or pinned workstreams (the insight covers history)', () => {
      const shipped = delivered({ status: 'shipped', derivedStatus: 'shipped' });
      expect(proof(computeAttention(data({ workstreams: [shipped], artifacts: [merged()] })))).toEqual([]);
      const pinned = delivered({ statusOverride: 'working' });
      expect(proof(computeAttention(data({ workstreams: [pinned], artifacts: [merged()] })))).toEqual([]);
    });
  });

  it('triage: one item per team with a count, for that team\'s members', () => {
    const mk = (id: string, teamId: string | null, at: number) => ({ id, key: id.toUpperCase(), title: id, teamId, status: 'backlog' as const, createdAt: day(at) });
    const items = computeAttention(data({ workstreams: [], issues: [mk('bug1', 't1', -3), mk('bug2', 't1', -1), mk('fb1', 't3', -2), mk('x', null, -1)] }));
    const t1 = items.find((i) => i.id === 'triage:t1')!;
    expect(t1.title).toMatch(/^2 backlog issues/);
    expect(t1.since).toEqual(day(-1));
    expect([...t1.audience]).toEqual(['bob']);
    expect([...items.find((i) => i.id === 'triage:workspace')!.audience]).toEqual(['alice']);
    expect(items.filter((i) => i.kind === 'triage')).toHaveLength(3);
  });

  it('skips workstreams with a status override', () => {
    const r = { id: 'r1', workstreamId: 'w1', question: '?', requestedBy: { type: 'user' as const, id: 'alice' }, state: 'open' as const, createdAt: day(-1) };
    expect(computeAttention(data({ workstreams: [ws({ statusOverride: 'canceled' })], inputRequests: [r] }))).toEqual([]);
  });
});

describe('sorting and per-user state', () => {
  const item = (id: string, severity: 'high' | 'medium' | 'low', n: number) => ({ id, severity, since: day(n) });

  it('sorts by severity, then longest waiting first', () => {
    const sorted = sortItems([item('c', 'low', -9), item('b', 'high', -1), item('a', 'high', -5), item('m', 'medium', -2)]);
    expect(sorted.map((i) => i.id)).toEqual(['a', 'b', 'm', 'c']);
  });

  it('dismissed stays dismissed until `since` changes', () => {
    const row = { state: 'dismissed' as const, since: day(-1) };
    expect(itemState({ since: day(-1) }, row, NOW).state).toBe('dismissed');
    expect(itemState({ since: day(-0.5) }, row, NOW).state).toBe('open');
    expect(itemState({ since: day(-1) }, undefined, NOW).state).toBe('open');
  });

  it('snoozed reappears after `until`', () => {
    const row = (until: Date) => ({ state: 'snoozed' as const, since: day(-1), snoozedUntil: until });
    expect(itemState({ since: day(-1) }, row(day(1)), NOW)).toEqual({ state: 'snoozed', snoozedUntil: day(1) });
    expect(itemState({ since: day(-1) }, row(day(-0.1)), NOW).state).toBe('open');
  });
});
