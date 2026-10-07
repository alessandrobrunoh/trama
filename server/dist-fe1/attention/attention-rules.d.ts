import type { ActorRef, ArtifactKind, ArtifactState, AttentionKind, AttentionSeverity, CiState, DecisionStatus, ExecutionState, InputRequestState, IntakeState, ReviewState, WorkstreamStatus } from '../contracts/domain.js';
export interface AWorkstream {
    id: string;
    key: string;
    title: string;
    ownerTeamId: string;
    participatingTeamIds: string[];
    accountableUserId?: string | null;
    acceptanceCriteria: {
        state: string;
    }[];
    status: WorkstreamStatus;
    derivedStatus: WorkstreamStatus;
    statusOverride?: 'draft' | 'canceled' | null;
    targetDate?: Date | null;
    updatedAt: Date;
}
export interface AExecution {
    id: string;
    workstreamId: string;
    parentExecutionId?: string | null;
    title: string;
    state: ExecutionState;
    progressNote?: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface AInputRequest {
    id: string;
    workstreamId: string;
    question: string;
    requestedBy: ActorRef;
    assigneeUserId?: string | null;
    state: InputRequestState;
    createdAt: Date;
}
export interface AArtifact {
    id: string;
    workstreamId: string;
    kind: ArtifactKind;
    title: string;
    externalId?: string | null;
    state: ArtifactState;
    ci?: CiState | null;
    review?: ReviewState | null;
    hasConflicts?: boolean | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface ADecision {
    id: string;
    key: string;
    title: string;
    status: DecisionStatus;
    originWorkstreamId?: string | null;
    relatedWorkstreamIds: string[];
    proposedBy: ActorRef;
    createdAt: Date;
}
export interface ADependency {
    id: string;
    fromType: 'workstream' | 'execution';
    fromId: string;
    toType: 'workstream' | 'execution';
    toId: string;
    createdAt: Date;
}
export interface AIntake {
    id: string;
    key: string;
    title: string;
    teamId?: string | null;
    state: IntakeState;
    createdAt: Date;
}
export interface ATeam {
    id: string;
    name: string;
    memberIds: string[];
}
export interface AttentionData {
    now: Date;
    teams: ATeam[];
    names: Map<string, string>;
    adminIds: string[];
    workstreams: AWorkstream[];
    executions: AExecution[];
    inputRequests: AInputRequest[];
    artifacts: AArtifact[];
    decisions: ADecision[];
    dependencies: ADependency[];
    intake: AIntake[];
    since?: Map<string, Date>;
}
export interface RawAttentionItem {
    id: string;
    kind: AttentionKind;
    severity: AttentionSeverity;
    title: string;
    detail: string;
    workstreamId?: string;
    executionId?: string;
    artifactId?: string;
    decisionId?: string;
    inputRequestId?: string;
    intakeId?: string;
    since: Date;
    audience: Set<string>;
}
export declare const DEADLINE_WINDOW_DAYS = 3;
export declare function computeAttention(d: AttentionData): RawAttentionItem[];
export declare function sortItems<T extends {
    severity: AttentionSeverity;
    since: Date;
    id: string;
}>(items: T[]): T[];
export interface AttentionStateRow {
    state: 'dismissed' | 'snoozed';
    snoozedUntil?: Date | null;
    since: Date;
}
export declare function itemState(item: {
    since: Date;
}, row: AttentionStateRow | undefined, now: Date): {
    state: 'open' | 'snoozed' | 'dismissed';
    snoozedUntil?: Date;
};
