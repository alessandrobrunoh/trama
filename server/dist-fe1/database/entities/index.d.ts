import type { AcceptanceCriterion, ActorRef, ArtifactKind, ArtifactProvider, ArtifactState, CiState, DecisionStatus, DependencyNodeType, ExecutionProvider, ExecutionState, GitProvider, InputRequestState, IntakeKind, IntakeSource, IntakeState, Priority, ReviewState, Role, SavedView, SubjectRef, ViewEntity, ViewFilter, ViewLayout, WorkstreamStatus } from '../../contracts/domain.js';
import { Wire } from './wire.js';
export { Wire };
export declare class UserEntity extends Wire {
    id: string;
    name: string;
    email: string;
    passwordHash: string;
    avatarHue: number;
    createdAt: Date;
    protected hidden(): string[];
}
export declare class SessionEntity {
    id: string;
    userId: string;
    expiresAt: Date;
    userAgent: string | null;
    createdAt: Date;
}
export declare class WorkspaceEntity extends Wire {
    id: string;
    name: string;
    slug: string;
    createdAt: Date;
}
export declare class MembershipEntity extends Wire {
    id: string;
    workspaceId: string;
    userId: string;
    role: Role;
    createdAt: Date;
}
export declare class AgentEntity extends Wire {
    id: string;
    workspaceId: string;
    name: string;
    provider: Exclude<ExecutionProvider, 'human'>;
    description: string | null;
    ownerUserId: string | null;
    createdAt: Date;
}
export declare class TeamEntity extends Wire {
    id: string;
    workspaceId: string;
    name: string;
    key: string;
    color: string;
    description: string | null;
    memberIds: string[];
}
export declare class RepositoryEntity extends Wire {
    id: string;
    workspaceId: string;
    provider: GitProvider;
    fullName: string;
    url: string;
    defaultBranch: string;
    teamIds: string[];
    createdAt: Date;
}
export declare class WorkstreamEntity extends Wire {
    id: string;
    workspaceId: string;
    key: string;
    number: number;
    title: string;
    objective: string;
    context: string | null;
    ownerTeamId: string;
    participatingTeamIds: string[];
    accountableUserId: string | null;
    repositoryIds: string[];
    acceptanceCriteria: AcceptanceCriterion[];
    priority: Priority;
    labels: string[];
    status: WorkstreamStatus;
    derivedStatus: WorkstreamStatus;
    statusOverride: 'draft' | 'canceled' | null;
    targetDate: Date | null;
    createdById: string;
    createdAt: Date;
    updatedAt: Date;
    shippedAt: Date | null;
}
export declare class ExecutionEntity extends Wire {
    id: string;
    workspaceId: string;
    workstreamId: string;
    parentExecutionId: string | null;
    title: string;
    description: string | null;
    teamId: string | null;
    repositoryIds: string[];
    performers: ActorRef[];
    provider: ExecutionProvider;
    state: ExecutionState;
    sessionUrl: string | null;
    branch: string | null;
    progressNote: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    dependsOnExecutionIds?: string[];
    protected hidden(): string[];
}
export declare class InputRequestEntity extends Wire {
    id: string;
    workspaceId: string;
    workstreamId: string;
    executionId: string | null;
    question: string;
    options: string[] | null;
    requestedBy: ActorRef;
    assigneeUserId: string | null;
    state: InputRequestState;
    answer: string | null;
    answeredById: string | null;
    createdAt: Date;
    answeredAt: Date | null;
    protected hidden(): string[];
}
export declare class IntakeItemEntity extends Wire {
    id: string;
    workspaceId: string;
    key: string;
    number: number;
    kind: IntakeKind;
    title: string;
    body: string | null;
    source: IntakeSource;
    reporterName: string | null;
    reporterId: string | null;
    teamId: string | null;
    priority: Priority;
    state: IntakeState;
    workstreamIds: string[];
    duplicateOfId: string | null;
    externalUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export declare class ArtifactEntity extends Wire {
    id: string;
    workspaceId: string;
    workstreamId: string;
    executionId: string | null;
    repositoryId: string | null;
    kind: ArtifactKind;
    provider: ArtifactProvider;
    title: string;
    url: string | null;
    externalId: string | null;
    state: ArtifactState;
    ci: CiState | null;
    review: ReviewState | null;
    hasConflicts: boolean | null;
    environment: string | null;
    authorRef: ActorRef | null;
    createdAt: Date;
    updatedAt: Date;
    protected hidden(): string[];
}
export declare class DecisionEntity extends Wire {
    id: string;
    workspaceId: string;
    key: string;
    number: number;
    title: string;
    statement: string;
    rationale: string | null;
    status: DecisionStatus;
    originWorkstreamId: string | null;
    originExecutionId: string | null;
    relatedWorkstreamIds: string[];
    supersededById: string | null;
    proposedBy: ActorRef;
    decidedById: string | null;
    decidedAt: Date | null;
    tags: string[];
    createdAt: Date;
    updatedAt: Date;
}
export declare class DependencyEntity extends Wire {
    id: string;
    workspaceId: string;
    fromType: DependencyNodeType;
    fromId: string;
    toType: DependencyNodeType;
    toId: string;
    createdAt: Date;
}
export declare class CommentEntity extends Wire {
    id: string;
    workspaceId: string;
    subject: SubjectRef;
    author: ActorRef;
    body: string;
    createdAt: Date;
    updatedAt: Date;
}
export declare class DomainEventEntity extends Wire {
    id: string;
    workspaceId: string;
    at: Date;
    actor: ActorRef;
    type: string;
    subject: SubjectRef;
    workstreamId: string | null;
    data: Record<string, unknown>;
}
export declare class SavedViewEntity extends Wire {
    id: string;
    workspaceId: string;
    ownerId: string;
    name: string;
    entity: ViewEntity;
    filters: ViewFilter[];
    sort: SavedView['sort'] | null;
    groupBy: string | null;
    layout: ViewLayout;
    shared: boolean;
    createdAt: Date;
    updatedAt: Date;
}
export declare class ApiTokenEntity extends Wire {
    id: string;
    workspaceId: string;
    name: string;
    prefix: string;
    tokenHash: string;
    actor: ActorRef;
    createdByUserId: string | null;
    lastUsedAt: Date | null;
    createdAt: Date;
    expiresAt: Date | null;
    protected hidden(): string[];
}
export declare class AttentionStateEntity {
    userId: string;
    workspaceId: string;
    itemId: string;
    state: 'dismissed' | 'snoozed';
    snoozedUntil: Date | null;
    since: Date;
}
export declare class WorkspaceCounterEntity {
    workspaceId: string;
    name: string;
    value: number;
}
export declare class IntegrationConnectionEntity extends Wire {
    id: string;
    workspaceId: string;
    provider: GitProvider | 'delta';
    account: string;
    baseUrl: string | null;
    secret: string | null;
    webhookSecret: string | null;
    status: 'connected' | 'error' | 'disconnected';
    lastSyncAt: Date | null;
    lastError: string | null;
    config: Record<string, unknown>;
    createdAt: Date;
    get webhookConfigured(): boolean;
    protected hidden(): string[];
    toJSON(): Record<string, unknown>;
}
export declare const ENTITIES: (typeof UserEntity | typeof SessionEntity | typeof WorkspaceEntity | typeof MembershipEntity | typeof AgentEntity | typeof TeamEntity | typeof RepositoryEntity | typeof WorkstreamEntity | typeof ExecutionEntity | typeof InputRequestEntity | typeof IntakeItemEntity | typeof ArtifactEntity | typeof DecisionEntity | typeof DependencyEntity | typeof CommentEntity | typeof DomainEventEntity | typeof SavedViewEntity | typeof ApiTokenEntity | typeof AttentionStateEntity | typeof WorkspaceCounterEntity | typeof IntegrationConnectionEntity)[];
