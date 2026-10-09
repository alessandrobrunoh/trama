import type {
  ArtifactKind,
  ArtifactState,
  CiState,
  CompletionGap,
  DeliveryState,
  WorkstreamCompletion,
  ReviewState,
  WorkstreamStatus,
} from '../contracts/domain.js';

/** Minimal shapes the engine needs; entities satisfy them structurally. */
export interface StatusWorkstream {
  statusOverride?: WorkstreamStatus | null;
  /**
   * Grandfathered by migration: was `shipped` with no criteria before "no criteria never ships".
   * Lets such a workstream keep shipping without a criterion; never set for new workstreams.
   */
  legacyShipped?: boolean;
  acceptanceCriteria: readonly { state?: string }[];
}
export interface StatusInputRequest {
  state: string;
}
export interface StatusArtifact {
  id?: string;
  kind: ArtifactKind;
  state: ArtifactState;
  ci?: CiState | null;
  review?: ReviewState | null;
  hasConflicts?: boolean | null;
}
export interface StatusDecision {
  status: string;
}
/** An edge pointing into this workstream, with its source workstream's status. */
export interface StatusDependency {
  sourceType: 'workstream';
  /** Workstream status. `shipped` resolves the edge. */
  sourceState: string;
}
/** A linked issue. Canceled issues are ignored by the derivation. */
export interface StatusIssue {
  status: string;
}

export interface StatusInput {
  workstream: StatusWorkstream;
  inputRequests: readonly StatusInputRequest[];
  artifacts: readonly StatusArtifact[];
  /** Decisions whose origin is this workstream. */
  decisions: readonly StatusDecision[];
  incomingDependencies: readonly StatusDependency[];
  /** Issues linked to this workstream. Absent means none. */
  issues?: readonly StatusIssue[];
}

export type BlockerReason =
  | { kind: 'ci_failing'; artifactId?: string }
  | { kind: 'conflict'; artifactId?: string }
  | { kind: 'dependency'; dependencyIndex: number };

export interface DerivedStatus {
  /** Effective status (override ?? derived). */
  status: WorkstreamStatus;
  /** Derived status, ignoring the override. */
  derivedStatus: WorkstreamStatus;
  /** The matched rule (1–9). */
  rule: number;
  /**
   * Delivery evidence (PR / release / deployment), independent of the outcome `status`.
   * A merged PR is `merged` here but never makes the workstream `shipped` by itself.
   */
  delivery: DeliveryState;
  /** Whether the outcome is achieved by the facts and what is missing; ignores the override. */
  completion: WorkstreamCompletion;
}

/**
 * `shippedAt` is when the workstream entered the effective `shipped` status (derived or pinned
 * through `statusOverride`). It is kept while the workstream stays shipped and cleared when it
 * leaves, so it never describes a delivery that is no longer current.
 */
export function nextShippedAt(
  status: WorkstreamStatus,
  current: Date | null | undefined,
  now: Date = new Date(),
): Date | null {
  if (status !== 'shipped') return null;
  return current ?? now;
}

const isPr = (a: StatusArtifact): boolean =>
  a.kind === 'pull_request' || a.kind === 'merge_request';
const isOpenPr = (a: StatusArtifact): boolean => isPr(a) && a.state === 'open';

/** Why a workstream is blocked; also used by attention. */
export function blockers(
  input: Pick<StatusInput, 'artifacts' | 'incomingDependencies'>,
): BlockerReason[] {
  const out: BlockerReason[] = [];
  for (const a of input.artifacts) {
    if (!isOpenPr(a)) continue;
    if (a.ci === 'failing') out.push({ kind: 'ci_failing', artifactId: a.id });
    if (a.hasConflicts) out.push({ kind: 'conflict', artifactId: a.id });
  }
  input.incomingDependencies.forEach((d, i) => {
    if (d.sourceState !== 'shipped')
      out.push({ kind: 'dependency', dependencyIndex: i });
  });
  return out;
}

/**
 * How far the code got, from artifacts only. Highest evidence wins:
 * deployed > released > merged (every live PR merged) > in_review (an open PR) > none.
 * This is delivery, not outcome: it says nothing about criteria, blockers or decisions.
 */
export function deriveDelivery(
  input: Pick<StatusInput, 'artifacts'>,
): DeliveryState {
  const { artifacts } = input;
  if (artifacts.some((a) => a.kind === 'deployment' && a.state === 'healthy'))
    return 'deployed';
  if (artifacts.some((a) => a.kind === 'release' && a.state === 'published'))
    return 'released';
  const live = artifacts.filter(isPr).filter((a) => a.state !== 'closed');
  if (live.length > 0 && live.every((a) => a.state === 'merged'))
    return 'merged';
  if (artifacts.some(isOpenPr)) return 'in_review';
  return 'none';
}

const isDelivered = (d: DeliveryState): boolean =>
  d === 'merged' || d === 'released' || d === 'deployed';

/** First matching rule wins. */
export function deriveStatus(input: StatusInput): DerivedStatus {
  const override = input.workstream.statusOverride ?? null;
  const derived = deriveWithoutOverride(input);
  const delivery = deriveDelivery(input);
  const completion = deriveCompletion(input);
  if (override)
    return {
      status: override,
      derivedStatus: derived.status,
      rule: 1,
      delivery,
      completion,
    };
  return {
    status: derived.status,
    derivedStatus: derived.status,
    rule: derived.rule,
    delivery,
    completion,
  };
}

/** Linked issues that still count. Canceled ones are not work left to do. */
function openIssues(input: StatusInput): StatusIssue[] {
  return (input.issues ?? []).filter((i) => i.status !== 'canceled');
}

/**
 * The single source of truth for "is the outcome achieved, and if not, why". `status === 'shipped'`
 * (derived) is exactly `achieved`; UI, briefing, MCP and CLI show `gaps` instead of re-deriving them.
 *
 * Delivery evidence (merged / released / deployed, or every linked issue done) is only one
 * precondition. A workstream with no acceptance criteria never ships on its own, since nothing
 * defines "done" (`legacyShipped` workstreams are the migrated exception).
 */
export function deriveCompletion(input: StatusInput): WorkstreamCompletion {
  const issues = openIssues(input);
  const allIssuesDone =
    issues.length > 0 && issues.every((i) => i.status === 'done');
  const delivered = isDelivered(deriveDelivery(input));
  const criteria = input.workstream.acceptanceCriteria;
  const gaps: CompletionGap[] = [];
  if (criteria.length === 0) {
    if (!input.workstream.legacyShipped) gaps.push('no_criteria');
  } else if (!criteria.every((c) => c.state === 'met')) {
    gaps.push('criteria_pending');
  }
  if (blockers(input).length > 0) gaps.push('blocked');
  if (
    input.inputRequests.some((r) => r.state === 'open') ||
    input.decisions.some((d) => d.status === 'proposed')
  )
    gaps.push('needs_input');
  if (!delivered && !allIssuesDone) gaps.push('no_delivery');
  return { achieved: gaps.length === 0, gaps };
}

function deriveWithoutOverride(input: StatusInput): {
  status: WorkstreamStatus;
  rule: number;
} {
  const { artifacts } = input;
  const issues = openIssues(input);
  const delivery = deriveDelivery(input);
  const delivered = isDelivered(delivery);
  const hasBlockers = blockers(input).length > 0;
  const waitingOnPeople =
    input.inputRequests.some((r) => r.state === 'open') ||
    input.decisions.some((d) => d.status === 'proposed');

  // Outcome achieved: criteria met (at least one), delivered, nothing blocks or waits on a person.
  if (deriveCompletion(input).achieved) return { status: 'shipped', rule: 2 };

  if (hasBlockers) return { status: 'blocked', rule: 3 };

  if (waitingOnPeople) return { status: 'needs_input', rule: 4 };

  if (
    artifacts.some(
      (a) =>
        isOpenPr(a) &&
        a.review === 'approved' &&
        a.ci === 'passing' &&
        !a.hasConflicts,
    )
  )
    return { status: 'ready_to_land', rule: 5 };

  const anyInProgress = issues.some((i) => i.status === 'in_progress');
  // An issue still being worked beats "in review": the stream is working until that issue moves on.
  if (
    artifacts.some(isOpenPr) ||
    (issues.some((i) => i.status === 'in_review') && !anyInProgress)
  )
    return { status: 'in_review', rule: 6 };

  // Delivered but not complete (criteria pending, issues open): the outcome is still being worked.
  const active =
    anyInProgress ||
    delivered ||
    input.workstream.acceptanceCriteria.some(
      (c) => c.state === 'in_progress',
    ) ||
    artifacts.some((a) => a.kind === 'build' || a.kind === 'test_report');
  if (active) return { status: 'working', rule: 7 };

  if (input.workstream.acceptanceCriteria.length > 0)
    return { status: 'planned', rule: 8 };

  return { status: 'draft', rule: 9 };
}
