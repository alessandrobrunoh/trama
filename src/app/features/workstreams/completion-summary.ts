// One line above the criteria: what the code did, what the outcome is, and what to do next.
// Pure and derived: it only phrases `ws.delivery` and the server's `ws.completion.gaps`.
import type { CompletionGap, DeliveryState, Workstream } from '../../core/contracts/domain';

export interface CompletionSummary {
  code: string;
  result: string;
  next: string;
  achieved: boolean;
  /** The status was pinned by hand, so it says nothing about whether the outcome is achieved. */
  pinned: boolean;
}

const CODE: Record<DeliveryState, string> = {
  none: 'nothing delivered',
  in_review: 'in review',
  merged: 'merged',
  released: 'released',
  deployed: 'deployed',
};

/** Most blocking first: this is the order the "next action" is picked in. */
const NEXT_ORDER: CompletionGap[] = ['blocked', 'needs_input', 'no_criteria', 'criteria_pending', 'no_delivery'];

const NEXT: Record<CompletionGap, string> = {
  blocked: 'unblock CI, conflicts or the dependency',
  needs_input: 'answer the open request or decision',
  no_criteria: 'add at least one acceptance criterion',
  criteria_pending: 'verify the open criteria and link evidence',
  no_delivery: 'get the code reviewed and merged',
};

function missing(gap: CompletionGap, pending: number): string {
  switch (gap) {
    case 'no_criteria':
      return 'no criteria defined';
    case 'criteria_pending':
      return pending === 1 ? '1 criterion open' : `${pending} criteria open`;
    case 'blocked':
      return 'blocked';
    case 'needs_input':
      return 'waiting on a person';
    case 'no_delivery':
      return 'code not delivered yet';
  }
}

export function completionSummary(ws: Pick<Workstream, 'delivery' | 'completion' | 'acceptanceCriteria' | 'statusOverride'>): CompletionSummary {
  const { achieved, gaps } = ws.completion;
  const pending = ws.acceptanceCriteria.filter((c) => c.state !== 'met').length;
  const first = NEXT_ORDER.find((g) => gaps.includes(g));
  return {
    code: CODE[ws.delivery],
    result: achieved ? 'achieved' : gaps.map((g) => missing(g, pending)).join(', '),
    next: first ? NEXT[first] : 'none',
    achieved,
    pinned: !!ws.statusOverride,
  };
}
