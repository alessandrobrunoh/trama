import type { CriterionEvidence, StatusSource, WorkstreamStatus } from '../contracts/domain.js';

/** Minimal criterion shape; entities and insight rows satisfy it structurally. */
export interface ProofCriterion {
  state?: string;
  evidence?: Pick<CriterionEvidence, 'artifactIds' | 'note'> | null;
}

/** A criterion has evidence when it links an artifact or carries a non-empty verification note. */
export function hasEvidence(c: ProofCriterion): boolean {
  const e = c.evidence;
  return !!e && ((e.artifactIds?.length ?? 0) > 0 || !!e.note?.trim());
}

/** Criteria that are `met` but nobody backed with evidence. Signalled, never an error. */
export function unprovenCriteria<T extends ProofCriterion>(criteria: readonly T[]): T[] {
  return criteria.filter((c) => c.state === 'met' && !hasEvidence(c));
}

export interface StatusSourceInput {
  status: WorkstreamStatus;
  statusOverride?: WorkstreamStatus | null;
  legacyShipped?: boolean | null;
  acceptanceCriteria: readonly unknown[];
}

/**
 * Where the effective status comes from: a manual pin (`override`), a historic `shipped` that was
 * grandfathered because it has no criteria (`legacy`), or the facts (`derived`). Computed on the fly
 * from the stored fields, so it can never go stale.
 */
export function statusSourceOf(w: StatusSourceInput): StatusSource {
  if (w.statusOverride) return 'override';
  if (w.status === 'shipped' && w.legacyShipped && w.acceptanceCriteria.length === 0) return 'legacy';
  return 'derived';
}

/**
 * Why a `shipped` workstream would not ship under today's rules:
 * - `legacy`: shipped before "no criteria never ships" and still has no criteria;
 * - `no_criteria`: no acceptance criteria at all (not grandfathered, e.g. pinned);
 * - `unproven_criteria`: some `met` criteria have no evidence;
 * - `pinned`: the status is pinned to Shipped while the facts say otherwise.
 */
export type ProofGap = 'legacy' | 'no_criteria' | 'unproven_criteria' | 'pinned';

export interface ShippedProofInput extends StatusSourceInput {
  derivedStatus: WorkstreamStatus;
  acceptanceCriteria: readonly ProofCriterion[];
}

/** Empty for workstreams that are not shipped or whose shipped is fully backed. */
export function shippedProofGaps(w: ShippedProofInput): ProofGap[] {
  if (w.status !== 'shipped') return [];
  const gaps: ProofGap[] = [];
  if (w.statusOverride === 'shipped' && w.derivedStatus !== 'shipped') gaps.push('pinned');
  if (w.acceptanceCriteria.length === 0) gaps.push(w.legacyShipped ? 'legacy' : 'no_criteria');
  else if (unprovenCriteria(w.acceptanceCriteria).length > 0) gaps.push('unproven_criteria');
  return gaps;
}
