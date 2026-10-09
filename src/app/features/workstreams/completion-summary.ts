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
  none: 'nessuna consegna',
  in_review: 'in review',
  merged: 'merged',
  released: 'rilasciato',
  deployed: 'in produzione',
};

/** Most blocking first: this is the order the "next action" is picked in. */
const NEXT_ORDER: CompletionGap[] = ['blocked', 'needs_input', 'no_criteria', 'criteria_pending', 'no_delivery'];

const NEXT: Record<CompletionGap, string> = {
  blocked: 'sblocca CI, conflitti o dipendenza',
  needs_input: 'rispondi alla richiesta o alla decisione aperta',
  no_criteria: 'aggiungi almeno un criterio di accettazione',
  criteria_pending: 'verifica i criteri aperti e collega le prove',
  no_delivery: 'porta il codice in review e in merge',
};

function missing(gap: CompletionGap, pending: number): string {
  switch (gap) {
    case 'no_criteria':
      return 'nessun criterio definito';
    case 'criteria_pending':
      return pending === 1 ? '1 criterio aperto' : `${pending} criteri aperti`;
    case 'blocked':
      return 'bloccato';
    case 'needs_input':
      return 'in attesa di una persona';
    case 'no_delivery':
      return 'codice non ancora consegnato';
  }
}

export function completionSummary(ws: Pick<Workstream, 'delivery' | 'completion' | 'acceptanceCriteria' | 'statusOverride'>): CompletionSummary {
  const { achieved, gaps } = ws.completion;
  const pending = ws.acceptanceCriteria.filter((c) => c.state !== 'met').length;
  const first = NEXT_ORDER.find((g) => gaps.includes(g));
  return {
    code: CODE[ws.delivery],
    result: achieved ? 'raggiunto' : gaps.map((g) => missing(g, pending)).join(', '),
    next: first ? NEXT[first] : 'nessuna',
    achieved,
    pinned: !!ws.statusOverride,
  };
}
