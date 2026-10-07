import { type ArtifactKind, type ArtifactState, type CiState, type ExecutionState, type ReviewState, type WorkstreamStatus } from '../contracts/domain.js';
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
export interface StatusDependency {
    sourceType: 'workstream' | 'execution';
    sourceState: string;
    targetExecutionState?: ExecutionState;
}
export interface StatusInput {
    workstream: StatusWorkstream;
    executions: readonly StatusExecution[];
    inputRequests: readonly StatusInputRequest[];
    artifacts: readonly StatusArtifact[];
    decisions: readonly StatusDecision[];
    incomingDependencies: readonly StatusDependency[];
}
export type BlockerReason = {
    kind: 'execution_blocked';
    executionId: string;
} | {
    kind: 'execution_failed';
    executionId: string;
} | {
    kind: 'ci_failing';
    artifactId?: string;
} | {
    kind: 'conflict';
    artifactId?: string;
} | {
    kind: 'dependency';
    dependencyIndex: number;
};
export interface DerivedStatus {
    status: WorkstreamStatus;
    derivedStatus: WorkstreamStatus;
    rule: number;
}
export declare function blockers(input: Omit<StatusInput, 'workstream' | 'inputRequests' | 'decisions'>): BlockerReason[];
export declare function deriveStatus(input: StatusInput): DerivedStatus;
