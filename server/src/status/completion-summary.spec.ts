import { describe, expect, it } from 'vitest';
import type { AcceptanceCriterion, CompletionGap, DeliveryState } from '../contracts/domain.js';
import { completionSummary } from '../../../src/app/features/workstreams/completion-summary.ts';

const criterion = (state: AcceptanceCriterion['state']): AcceptanceCriterion => ({ id: 'ac', text: 't', state });
const ws = (delivery: DeliveryState, gaps: CompletionGap[], states: AcceptanceCriterion['state'][] = [], statusOverride?: 'shipped') => ({
  delivery,
  completion: { achieved: gaps.length === 0, gaps },
  acceptanceCriteria: states.map(criterion),
  statusOverride,
});

describe('completionSummary (workstream overview line)', () => {
  it('merged code with open criteria: the code is done, the outcome is not', () => {
    expect(completionSummary(ws('merged', ['criteria_pending'], ['met', 'pending', 'in_progress']))).toMatchObject({
      code: 'merged',
      result: '2 criteria open',
      next: 'verify the open criteria and link evidence',
      achieved: false,
    });
  });

  it('achieved: nothing left to do', () => {
    expect(completionSummary(ws('deployed', [], ['met']))).toMatchObject({
      code: 'deployed',
      result: 'achieved',
      next: 'none',
      achieved: true,
    });
  });

  it('picks the most blocking gap as the next action, whatever the order of the gaps', () => {
    expect(completionSummary(ws('in_review', ['no_criteria', 'needs_input', 'blocked', 'no_delivery'])).next).toBe(
      'unblock CI, conflicts or the dependency',
    );
    expect(completionSummary(ws('none', ['no_criteria', 'no_delivery'])).next).toBe('add at least one acceptance criterion');
    expect(completionSummary(ws('none', ['no_delivery'], ['met'])).next).toBe('get the code reviewed and merged');
  });

  it('says why each gap is missing', () => {
    expect(completionSummary(ws('merged', ['no_criteria'])).result).toBe('no criteria defined');
    expect(completionSummary(ws('merged', ['criteria_pending'], ['pending'])).result).toBe('1 criterion open');
    expect(completionSummary(ws('merged', ['needs_input'], ['met'])).result).toBe('waiting on a person');
  });

  it('flags a manually pinned status as not being evidence', () => {
    expect(completionSummary(ws('none', ['no_criteria', 'no_delivery'], [], 'shipped')).pinned).toBe(true);
    expect(completionSummary(ws('none', [])).pinned).toBe(false);
  });
});
