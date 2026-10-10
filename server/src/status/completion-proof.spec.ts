import { describe, expect, it } from 'vitest';
import { hasEvidence, shippedProofGaps, statusSourceOf, unprovenCriteria } from './completion-proof.js';
import { deriveStatus } from './derive-status.js';

const input = (p: Partial<Parameters<typeof statusSourceOf>[0]> = {}) => ({
  status: 'working' as const,
  statusOverride: null,
  legacyShipped: false,
  acceptanceCriteria: [{ state: 'pending' }],
  ...p,
});

describe('statusSourceOf', () => {
  it('is derived by default, also for a shipped that the facts support', () => {
    expect(statusSourceOf(input())).toBe('derived');
    expect(statusSourceOf(input({ status: 'shipped', acceptanceCriteria: [{ state: 'met' }] }))).toBe('derived');
  });

  it('is override whenever a status is pinned, whatever the status or the facts', () => {
    expect(statusSourceOf(input({ status: 'shipped', statusOverride: 'shipped' }))).toBe('override');
    expect(statusSourceOf(input({ status: 'blocked', statusOverride: 'blocked' }))).toBe('override');
    expect(statusSourceOf(input({ status: 'shipped', statusOverride: 'shipped', legacyShipped: true, acceptanceCriteria: [] }))).toBe('override');
  });

  it('is legacy only for a grandfathered shipped that still has no criteria', () => {
    expect(statusSourceOf(input({ status: 'shipped', legacyShipped: true, acceptanceCriteria: [] }))).toBe('legacy');
    // once criteria exist the facts decide again
    expect(statusSourceOf(input({ status: 'shipped', legacyShipped: true, acceptanceCriteria: [{ state: 'met' }] }))).toBe('derived');
    // a legacy workstream that left shipped is just derived
    expect(statusSourceOf(input({ status: 'working', legacyShipped: true, acceptanceCriteria: [] }))).toBe('derived');
    expect(statusSourceOf(input({ status: 'shipped', legacyShipped: false, acceptanceCriteria: [] }))).toBe('derived');
  });

  it('agrees with the derivation: a legacy workstream derives shipped, a pinned one reports its pin', () => {
    const base = { inputRequests: [], artifacts: [{ kind: 'pull_request' as const, state: 'merged' as const }], decisions: [], incomingDependencies: [] };
    const legacy = { statusOverride: null, legacyShipped: true, acceptanceCriteria: [] };
    const r = deriveStatus({ ...base, workstream: legacy });
    expect(r.status).toBe('shipped');
    expect(statusSourceOf({ ...legacy, status: r.status })).toBe('legacy');
    const pinned = { statusOverride: 'shipped' as const, legacyShipped: false, acceptanceCriteria: [{ state: 'pending' }] };
    const p = deriveStatus({ ...base, workstream: pinned });
    expect(p).toMatchObject({ status: 'shipped', derivedStatus: 'working' });
    expect(statusSourceOf({ ...pinned, status: p.status })).toBe('override');
  });
});

describe('evidence', () => {
  it('needs a linked artifact or a non-blank note', () => {
    expect(hasEvidence({})).toBe(false);
    expect(hasEvidence({ evidence: null })).toBe(false);
    expect(hasEvidence({ evidence: { artifactIds: [] } })).toBe(false);
    expect(hasEvidence({ evidence: { artifactIds: [], note: ' ' } })).toBe(false);
    expect(hasEvidence({ evidence: { artifactIds: ['a'] } })).toBe(true);
    expect(hasEvidence({ evidence: { artifactIds: [], note: 'tested' } })).toBe(true);
  });

  it('unprovenCriteria are the met ones without evidence', () => {
    const c = [{ state: 'met' }, { state: 'pending' }, { state: 'met', evidence: { artifactIds: ['a'] } }];
    expect(unprovenCriteria(c)).toEqual([c[0]]);
  });
});

describe('shippedProofGaps', () => {
  const shipped = (p = {}) => ({
    status: 'shipped' as const,
    derivedStatus: 'shipped' as const,
    statusOverride: null,
    legacyShipped: false,
    acceptanceCriteria: [{ state: 'met', evidence: { artifactIds: ['a'] } }],
    ...p,
  });

  it('is empty for a proven shipped and for anything not shipped', () => {
    expect(shippedProofGaps(shipped())).toEqual([]);
    expect(shippedProofGaps(shipped({ status: 'working', acceptanceCriteria: [] }))).toEqual([]);
  });

  it('names each way a shipped would not ship today', () => {
    expect(shippedProofGaps(shipped({ acceptanceCriteria: [], legacyShipped: true }))).toEqual(['legacy']);
    expect(shippedProofGaps(shipped({ acceptanceCriteria: [] }))).toEqual(['no_criteria']);
    expect(shippedProofGaps(shipped({ acceptanceCriteria: [{ state: 'met' }] }))).toEqual(['unproven_criteria']);
    expect(shippedProofGaps(shipped({ statusOverride: 'shipped', derivedStatus: 'working' }))).toEqual(['pinned']);
    expect(shippedProofGaps(shipped({ statusOverride: 'shipped', derivedStatus: 'working', acceptanceCriteria: [] }))).toEqual(['pinned', 'no_criteria']);
  });
});
