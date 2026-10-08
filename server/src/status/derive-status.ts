import type { ArtifactKind, ArtifactState, CiState, ReviewState, WorkstreamStatus } from '../contracts/domain.js';

/** Minimal shapes the engine needs; entities satisfy them structurally. */
export interface StatusWorkstream {
  statusOverride?: WorkstreamStatus | null;
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

export interface StatusInput {
  workstream: StatusWorkstream;
  inputRequests: readonly StatusInputRequest[];
  artifacts: readonly StatusArtifact[];
  /** Decisions whose origin is this workstream. */
  decisions: readonly StatusDecision[];
  incomingDependencies: readonly StatusDependency[];
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
}

const isPr = (a: StatusArtifact): boolean => a.kind === 'pull_request' || a.kind === 'merge_request';
const isOpenPr = (a: StatusArtifact): boolean => isPr(a) && a.state === 'open';

/** Why a workstream is blocked; also used by attention. */
export function blockers(input: Pick<StatusInput, 'artifacts' | 'incomingDependencies'>): BlockerReason[] {
  const out: BlockerReason[] = [];
  for (const a of input.artifacts) {
    if (!isOpenPr(a)) continue;
    if (a.ci === 'failing') out.push({ kind: 'ci_failing', artifactId: a.id });
    if (a.hasConflicts) out.push({ kind: 'conflict', artifactId: a.id });
  }
  input.incomingDependencies.forEach((d, i) => {
    if (d.sourceState !== 'shipped') out.push({ kind: 'dependency', dependencyIndex: i });
  });
  return out;
}

/** First matching rule wins. */
export function deriveStatus(input: StatusInput): DerivedStatus {
  const override = input.workstream.statusOverride ?? null;
  const derived = deriveWithoutOverride(input);
  if (override) return { status: override, derivedStatus: derived.status, rule: 1 };
  return { status: derived.status, derivedStatus: derived.status, rule: derived.rule };
}

function deriveWithoutOverride(input: StatusInput): { status: WorkstreamStatus; rule: number } {
  const { artifacts } = input;
  const prs = artifacts.filter(isPr);

  const deployed = artifacts.some(
    (a) => (a.kind === 'deployment' && a.state === 'healthy') || (a.kind === 'release' && a.state === 'published'),
  );
  const live = prs.filter((a) => a.state !== 'closed');
  const merged = live.length > 0 && live.every((a) => a.state === 'merged');
  if (deployed || merged) return { status: 'shipped', rule: 2 };

  if (blockers(input).length) return { status: 'blocked', rule: 3 };

  if (input.inputRequests.some((r) => r.state === 'open') || input.decisions.some((d) => d.status === 'proposed'))
    return { status: 'needs_input', rule: 4 };

  if (artifacts.some((a) => isOpenPr(a) && a.review === 'approved' && a.ci === 'passing' && !a.hasConflicts))
    return { status: 'ready_to_land', rule: 5 };

  if (artifacts.some(isOpenPr)) return { status: 'in_review', rule: 6 };

  const active =
    input.workstream.acceptanceCriteria.some((c) => c.state === 'in_progress') ||
    artifacts.some((a) => a.kind === 'build' || a.kind === 'test_report');
  if (active) return { status: 'working', rule: 7 };

  if (input.workstream.acceptanceCriteria.length > 0) return { status: 'planned', rule: 8 };

  return { status: 'draft', rule: 9 };
}
