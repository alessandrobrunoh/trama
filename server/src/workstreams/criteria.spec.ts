import { describe, expect, it } from 'vitest';
import type { AcceptanceCriterion, ActorRef } from '../contracts/domain.js';
import { applyCriterionChange, newCriterion, normalizeEvidence, replaceCriteria } from './criteria.js';

const user: ActorRef = { type: 'user', id: 'usr_1' };
const agent: ActorRef = { type: 'agent', id: 'agt_1' };
const T0 = new Date('2026-01-01T10:00:00Z');
const T1 = new Date('2026-01-02T10:00:00Z');

const pending: AcceptanceCriterion = { id: 'ac_1', text: 'Sessions survive', state: 'pending' };
const met = (by: ActorRef = user): AcceptanceCriterion => ({
  ...pending,
  state: 'met',
  verifiedBy: by,
  verifiedAt: T0.toISOString(),
  evidence: { artifactIds: ['art_1'], note: 'checked' },
});

describe('verifiedBy / verifiedAt', () => {
  it('records the user who sets a criterion to met', () => {
    const c = applyCriterionChange(pending, { state: 'met' }, user, T0);
    expect(c).toMatchObject({ state: 'met', verifiedBy: user, verifiedAt: T0.toISOString() });
  });

  it('records an agent as an agent, not as a person', () => {
    const c = applyCriterionChange(pending, { state: 'met' }, agent, T0);
    expect(c.verifiedBy).toEqual(agent);
  });

  it('keeps the original verifier when an unrelated change touches a met criterion', () => {
    const c = applyCriterionChange(met(user), { evidence: { artifactIds: ['art_1', 'art_2'] } }, agent, T1);
    expect(c.verifiedBy).toEqual(user);
    expect(c.verifiedAt).toBe(T0.toISOString());
    expect(c.state).toBe('met');
  });

  it('does not claim a legacy met criterion (no verifier) for whoever attaches proof later', () => {
    const legacy: AcceptanceCriterion = { id: 'ac_1', text: 'Old', state: 'met' };
    const c = applyCriterionChange(legacy, { state: 'met', evidence: { artifactIds: ['art_1'] } }, agent, T1);
    expect(c.verifiedBy).toBeUndefined();
    expect(c.verifiedAt).toBeUndefined();
    expect(c.evidence).toEqual({ artifactIds: ['art_1'] });
  });

  it('clears verification when the criterion leaves met', () => {
    for (const state of ['pending', 'in_progress'] as const) {
      const c = applyCriterionChange(met(), { state }, user, T1);
      expect(c.state).toBe(state);
      expect(c.verifiedBy).toBeUndefined();
      expect(c.verifiedAt).toBeUndefined();
    }
  });

  it('verifies a criterion created already met', () => {
    const c = newCriterion({ text: ' Done ', state: 'met' }, agent, T0);
    expect(c).toMatchObject({ text: 'Done', state: 'met', verifiedBy: agent });
    expect(newCriterion({ text: 'x' }, user, T0).verifiedBy).toBeUndefined();
  });
});

describe('editing the text', () => {
  it('resets a met criterion to pending and drops verification and evidence', () => {
    const c = applyCriterionChange(met(), { text: 'Sessions survive a deploy' }, user, T1);
    expect(c).toEqual({ id: 'ac_1', text: 'Sessions survive a deploy', state: 'pending' });
  });

  it('does not reset a criterion whose text is unchanged (or only trimmed)', () => {
    const c = applyCriterionChange(met(), { text: '  Sessions survive ' }, agent, T1);
    expect(c.state).toBe('met');
    expect(c.verifiedBy).toEqual(user);
    expect(c.evidence).toBeDefined();
  });

  it('leaves pending and in_progress criteria as they are', () => {
    const c = applyCriterionChange({ ...pending, state: 'in_progress' }, { text: 'New' }, user, T1);
    expect(c.state).toBe('in_progress');
  });

  it('an explicit state in the same change wins and is verified by the editor', () => {
    const c = applyCriterionChange(met(user), { text: 'Reworded', state: 'met' }, agent, T1);
    expect(c).toMatchObject({ state: 'met', verifiedBy: agent, verifiedAt: T1.toISOString() });
    expect(c.evidence).toBeUndefined();
  });
});

describe('evidence', () => {
  it('is optional: a criterion can be met without it', () => {
    const c = applyCriterionChange(pending, { state: 'met' }, user, T0);
    expect(c.state).toBe('met');
    expect(c.evidence).toBeUndefined();
  });

  it('linking proof never changes the state', () => {
    for (const state of ['pending', 'in_progress'] as const) {
      const c = applyCriterionChange({ ...pending, state }, { evidence: { artifactIds: ['art_pr'] } }, agent, T0);
      expect(c.state).toBe(state);
      expect(c.verifiedBy).toBeUndefined();
      expect(c.evidence).toEqual({ artifactIds: ['art_pr'] });
    }
  });

  it('de-duplicates ids, trims the note, and clears on null or empty', () => {
    expect(normalizeEvidence({ artifactIds: ['a', 'a', 'b'], note: '  ok ' })).toEqual({ artifactIds: ['a', 'b'], note: 'ok' });
    expect(normalizeEvidence({ artifactIds: [], note: '  ' })).toBeUndefined();
    expect(normalizeEvidence(null)).toBeUndefined();
    expect(applyCriterionChange(met(), { evidence: null }, user, T1).evidence).toBeUndefined();
  });

  it('keeps proof when a criterion goes back to pending (only verification is cleared)', () => {
    expect(applyCriterionChange(met(), { state: 'pending' }, user, T1).evidence).toEqual({ artifactIds: ['art_1'], note: 'checked' });
  });
});

describe('replaceCriteria (bulk write)', () => {
  it('keeps evidence and verification of untouched criteria and verifies newly met ones', () => {
    const out = replaceCriteria(
      [
        { id: 'ac_1', text: 'Sessions survive', state: 'met' },
        { text: 'Brand new', state: 'met' },
      ],
      [met(user)],
      agent,
      T1,
    );
    expect(out[0]).toMatchObject({ verifiedBy: user, verifiedAt: T0.toISOString(), evidence: { artifactIds: ['art_1'], note: 'checked' } });
    expect(out[1]).toMatchObject({ verifiedBy: agent, state: 'met' });
  });

  it('resets a met criterion whose text changed in the bulk write', () => {
    const out = replaceCriteria([{ id: 'ac_1', text: 'Reworded' }], [met()], user, T1);
    expect(out[0]).toEqual({ id: 'ac_1', text: 'Reworded', state: 'pending' });
  });

  it('legacy criteria without the new fields stay valid', () => {
    const out = replaceCriteria([{ id: 'ac_1', text: 'Sessions survive', state: 'met' }], [{ ...pending, state: 'met' }], user, T1);
    expect(out[0].state).toBe('met');
  });
});
