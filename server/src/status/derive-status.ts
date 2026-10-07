import {
  TERMINAL_EXECUTION_STATES,
  type ArtifactKind,
  type ArtifactState,
  type CiState,
  type ExecutionState,
  type ReviewState,
  type WorkstreamStatus,
} from '../contracts/domain.js';

/** Minimal shapes the engine needs; entities satisfy them structurally. */
export interface StatusWorkstream {
  statusOverride?: 'draft' | 'canceled' | null;
  acceptanceCriteria: readonly unknown[];
}
export interface StatusExecution {
  id: string;
  parentExecutionId?: string | null;
  state: ExecutionState;
  createdAt: Date;
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
/** An edge pointing INTO this workstream (or one of its executions), with its source's current state. */
export interface StatusDependency {
  sourceType: 'workstream' | 'execution';
  /** Workstream status (shipped = resolved) or execution state (completed = resolved). */
  sourceState: string;
  /** Set when the edge targets an execution of this workstream; terminal targets no longer wait. */
  targetExecutionState?: ExecutionState;
}

export interface StatusInput {
  workstream: StatusWorkstream;
  executions: readonly StatusExecution[];
  inputRequests: readonly StatusInputRequest[];
  artifacts: readonly StatusArtifact[];
  /** Decisions whose origin is this workstream. */
  decisions: readonly StatusDecision[];
  incomingDependencies: readonly StatusDependency[];
}

export type BlockerReason =
  | { kind: 'execution_blocked'; executionId: string }
  | { kind: 'execution_failed'; executionId: string }
  | { kind: 'ci_failing'; artifactId?: string }
  | { kind: 'conflict'; artifactId?: string }
  | { kind: 'dependency'; dependencyIndex: number };

export interface DerivedStatus {
  /** Effective status (override ?? derived). */
  status: WorkstreamStatus;
  /** Derived status, ignoring the override (rules 2–9). */
  derivedStatus: WorkstreamStatus;
  /** The matched PLAN.md §2 rule (1–9). */
  rule: number;
}

const isTerminal = (s: ExecutionState): boolean => TERMINAL_EXECUTION_STATES.includes(s);
const isPr = (a: StatusArtifact): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';
const isOpenPr = (a: StatusArtifact): boolean => isPr(a) && a.state === 'open';

/** Why a workstream is blocked (PLAN.md §2 rule 3); also used by attention. */
export function blockers(input: Omit<StatusInput, 'workstream' | 'inputRequests' | 'decisions'>): BlockerReason[] {
  const out: BlockerReason[] = [];
  for (const e of input.executions) if (e.state === 'blocked') out.push({ kind: 'execution_blocked', executionId: e.id });
  for (const e of input.executions) {
    if (e.state !== 'failed') continue;
    const retried = input.executions.some(
      (o) =>
        o.id !== e.id &&
        o.state === 'completed' &&
        (o.parentExecutionId ?? null) === (e.parentExecutionId ?? null) &&
        o.createdAt.getTime() > e.createdAt.getTime(),
    );
    if (!retried) out.push({ kind: 'execution_failed', executionId: e.id });
  }
  for (const a of input.artifacts) {
    if (!isOpenPr(a)) continue;
    if (a.ci === 'failing') out.push({ kind: 'ci_failing', artifactId: a.id });
    if (a.hasConflicts) out.push({ kind: 'conflict', artifactId: a.id });
  }
  input.incomingDependencies.forEach((d, i) => {
    if (d.targetExecutionState && isTerminal(d.targetExecutionState)) return;
    const resolved = d.sourceType === 'workstream' ? d.sourceState === 'shipped' : d.sourceState === 'completed';
    if (!resolved) out.push({ kind: 'dependency', dependencyIndex: i });
  });
  return out;
}

/** Pure implementation of PLAN.md §2; the first matching rule wins. */
export function deriveStatus(input: StatusInput): DerivedStatus {
  const override = input.workstream.statusOverride ?? null;
  const derived = deriveWithoutOverride(input);
  if (override) return { status: override, derivedStatus: derived.status, rule: 1 };
  return { status: derived.status, derivedStatus: derived.status, rule: derived.rule };
}

function deriveWithoutOverride(input: StatusInput): { status: WorkstreamStatus; rule: number } {
  const { executions, artifacts } = input;
  const prs = artifacts.filter(isPr);

  // 2. shipped
  const deployed = artifacts.some(
    (a) => (a.kind === 'deployment' && a.state === 'healthy') || (a.kind === 'release' && a.state === 'published'),
  );
  // Closed (abandoned) PRs/MRs do not hold back shipping.
  const live = prs.filter((a) => a.state !== 'closed');
  const merged = live.length > 0 && live.every((a) => a.state === 'merged');
  if (deployed || (merged && executions.every((e) => isTerminal(e.state)))) return { status: 'shipped', rule: 2 };

  // 3. blocked
  if (blockers(input).length) return { status: 'blocked', rule: 3 };

  // 4. needs_input
  if (
    input.inputRequests.some((r) => r.state === 'open') ||
    executions.some((e) => e.state === 'needs_input') ||
    input.decisions.some((d) => d.status === 'proposed')
  )
    return { status: 'needs_input', rule: 4 };

  // 5. ready_to_land
  if (artifacts.some((a) => isOpenPr(a) && a.review === 'approved' && a.ci === 'passing' && !a.hasConflicts))
    return { status: 'ready_to_land', rule: 5 };

  // 6. in_review
  if (artifacts.some(isOpenPr) || executions.some((e) => e.state === 'in_review'))
    return { status: 'in_review', rule: 6 };

  // 7. working
  if (executions.some((e) => e.state === 'running')) return { status: 'working', rule: 7 };

  // 8. planned
  if (executions.length > 0 || input.workstream.acceptanceCriteria.length > 0) return { status: 'planned', rule: 8 };

  // 9. draft
  return { status: 'draft', rule: 9 };
}
