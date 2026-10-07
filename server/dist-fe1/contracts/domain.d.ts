export type ID = string;
export type ISODate = string;
export type Role = 'owner' | 'admin' | 'member' | 'viewer';
export interface User {
    id: ID;
    name: string;
    email: string;
    avatarHue: number;
    createdAt: ISODate;
}
export interface Workspace {
    id: ID;
    name: string;
    slug: string;
    createdAt: ISODate;
}
export interface Membership {
    id: ID;
    workspaceId: ID;
    userId: ID;
    role: Role;
    createdAt: ISODate;
}
export type ExecutionProvider = 'human' | 'delta' | 'claude_code' | 'codex' | 'cursor' | 'other';
export interface Agent {
    id: ID;
    workspaceId: ID;
    name: string;
    provider: Exclude<ExecutionProvider, 'human'>;
    description?: string;
    ownerUserId?: ID;
    createdAt: ISODate;
}
export type ActorType = 'user' | 'agent' | 'team' | 'system';
export interface ActorRef {
    type: ActorType;
    id?: ID;
}
export interface Team {
    id: ID;
    workspaceId: ID;
    name: string;
    key: string;
    color: string;
    description?: string;
    memberIds: ID[];
}
export type GitProvider = 'github' | 'gitlab';
export interface Repository {
    id: ID;
    workspaceId: ID;
    provider: GitProvider;
    fullName: string;
    url: string;
    defaultBranch: string;
    teamIds: ID[];
    createdAt: ISODate;
}
export type Priority = 'none' | 'urgent' | 'high' | 'medium' | 'low';
export type WorkstreamStatus = 'draft' | 'planned' | 'working' | 'needs_input' | 'in_review' | 'blocked' | 'ready_to_land' | 'shipped' | 'canceled';
export type CriterionState = 'pending' | 'in_progress' | 'met';
export interface AcceptanceCriterion {
    id: ID;
    text: string;
    state: CriterionState;
}
export interface Workstream {
    id: ID;
    workspaceId: ID;
    key: string;
    number: number;
    title: string;
    objective: string;
    context?: string;
    ownerTeamId: ID;
    participatingTeamIds: ID[];
    accountableUserId?: ID;
    repositoryIds: ID[];
    acceptanceCriteria: AcceptanceCriterion[];
    priority: Priority;
    labels: string[];
    status: WorkstreamStatus;
    derivedStatus: WorkstreamStatus;
    statusOverride?: 'draft' | 'canceled';
    targetDate?: ISODate;
    createdById: ID;
    createdAt: ISODate;
    updatedAt: ISODate;
    shippedAt?: ISODate;
}
export type ExecutionState = 'queued' | 'running' | 'needs_input' | 'in_review' | 'blocked' | 'failed' | 'completed' | 'canceled';
export declare const TERMINAL_EXECUTION_STATES: readonly ExecutionState[];
export interface Execution {
    id: ID;
    workstreamId: ID;
    parentExecutionId?: ID;
    title: string;
    description?: string;
    teamId?: ID;
    repositoryIds: ID[];
    performers: ActorRef[];
    provider: ExecutionProvider;
    state: ExecutionState;
    dependsOnExecutionIds: ID[];
    sessionUrl?: string;
    branch?: string;
    progressNote?: string;
    startedAt?: ISODate;
    completedAt?: ISODate;
    createdAt: ISODate;
    updatedAt: ISODate;
}
export type InputRequestState = 'open' | 'answered' | 'dismissed';
export interface InputRequest {
    id: ID;
    workstreamId: ID;
    executionId?: ID;
    question: string;
    options?: string[];
    requestedBy: ActorRef;
    assigneeUserId?: ID;
    state: InputRequestState;
    answer?: string;
    answeredById?: ID;
    createdAt: ISODate;
    answeredAt?: ISODate;
}
export type IntakeKind = 'bug' | 'feature' | 'incident' | 'tech_debt' | 'feedback' | 'idea' | 'security';
export declare const INTAKE_KEY_PREFIX: Record<IntakeKind, string>;
export type IntakeState = 'new' | 'triaged' | 'accepted' | 'declined' | 'duplicate';
export type IntakeSource = 'manual' | 'github' | 'gitlab' | 'email' | 'api' | 'agent';
export interface IntakeItem {
    id: ID;
    workspaceId: ID;
    key: string;
    number: number;
    kind: IntakeKind;
    title: string;
    body?: string;
    source: IntakeSource;
    reporterName?: string;
    reporterId?: ID;
    teamId?: ID;
    priority: Priority;
    state: IntakeState;
    workstreamIds: ID[];
    duplicateOfId?: ID;
    externalUrl?: string;
    createdAt: ISODate;
    updatedAt: ISODate;
}
export type ArtifactKind = 'pull_request' | 'merge_request' | 'commit' | 'branch' | 'document' | 'design' | 'build' | 'test_report' | 'deployment' | 'release';
export type ArtifactProvider = 'github' | 'gitlab' | 'delta' | 'figma' | 'docs' | 'ci' | 'other';
export type ArtifactState = 'draft' | 'open' | 'merged' | 'closed' | 'pending' | 'running' | 'succeeded' | 'failed' | 'healthy' | 'degraded' | 'published';
export type CiState = 'pending' | 'passing' | 'failing';
export type ReviewState = 'none' | 'requested' | 'approved' | 'changes_requested';
export interface Artifact {
    id: ID;
    workstreamId: ID;
    executionId?: ID;
    repositoryId?: ID;
    kind: ArtifactKind;
    provider: ArtifactProvider;
    title: string;
    url?: string;
    externalId?: string;
    state: ArtifactState;
    ci?: CiState;
    review?: ReviewState;
    hasConflicts?: boolean;
    environment?: string;
    authorRef?: ActorRef;
    createdAt: ISODate;
    updatedAt: ISODate;
}
export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected';
export interface Decision {
    id: ID;
    workspaceId: ID;
    key: string;
    number: number;
    title: string;
    statement: string;
    rationale?: string;
    status: DecisionStatus;
    originWorkstreamId?: ID;
    originExecutionId?: ID;
    relatedWorkstreamIds: ID[];
    supersededById?: ID;
    proposedBy: ActorRef;
    decidedById?: ID;
    decidedAt?: ISODate;
    tags: string[];
    createdAt: ISODate;
    updatedAt: ISODate;
}
export type DependencyNodeType = 'workstream' | 'execution';
export interface Dependency {
    id: ID;
    workspaceId: ID;
    fromType: DependencyNodeType;
    fromId: ID;
    toType: DependencyNodeType;
    toId: ID;
    createdAt: ISODate;
}
export type SubjectType = 'workstream' | 'execution' | 'intake' | 'artifact' | 'decision' | 'input_request' | 'repository' | 'team';
export interface SubjectRef {
    type: SubjectType;
    id: ID;
}
export interface Comment {
    id: ID;
    workspaceId: ID;
    subject: SubjectRef;
    author: ActorRef;
    body: string;
    createdAt: ISODate;
    updatedAt: ISODate;
}
export interface DomainEvent {
    id: ID;
    workspaceId: ID;
    at: ISODate;
    actor: ActorRef;
    type: string;
    subject: SubjectRef;
    workstreamId?: ID;
    data: Record<string, unknown>;
}
export type AttentionKind = 'input_requested' | 'needs_decision' | 'review_requested' | 'blocked' | 'ci_failed' | 'conflict' | 'dependency' | 'deadline' | 'ready_to_land' | 'ready_to_ship' | 'triage';
export type AttentionSeverity = 'high' | 'medium' | 'low';
export interface AttentionItem {
    id: string;
    kind: AttentionKind;
    severity: AttentionSeverity;
    title: string;
    detail: string;
    workstreamId?: ID;
    executionId?: ID;
    artifactId?: ID;
    decisionId?: ID;
    inputRequestId?: ID;
    intakeId?: ID;
    since: ISODate;
    state: 'open' | 'snoozed' | 'dismissed';
    snoozedUntil?: ISODate;
}
export type ViewEntity = 'workstream' | 'intake' | 'execution' | 'decision';
export type ViewLayout = 'list' | 'board' | 'graph';
export interface ViewFilter {
    field: string;
    op: 'is' | 'is_not' | 'in' | 'not_in' | 'contains' | 'before' | 'after';
    value: string | string[];
}
export interface SavedView {
    id: ID;
    workspaceId: ID;
    ownerId: ID;
    name: string;
    entity: ViewEntity;
    filters: ViewFilter[];
    sort?: {
        field: string;
        direction: 'asc' | 'desc';
    };
    groupBy?: string;
    layout: ViewLayout;
    shared: boolean;
    createdAt: ISODate;
    updatedAt: ISODate;
}
export interface ApiToken {
    id: ID;
    workspaceId: ID;
    name: string;
    prefix: string;
    actor: ActorRef;
    lastUsedAt?: ISODate;
    createdAt: ISODate;
    expiresAt?: ISODate;
}
export interface IntegrationConnection {
    id: ID;
    workspaceId: ID;
    provider: GitProvider | 'delta';
    account: string;
    baseUrl?: string;
    webhookConfigured: boolean;
    status: 'connected' | 'error' | 'disconnected';
    lastSyncAt?: ISODate;
    lastError?: string;
    createdAt: ISODate;
}
export interface WorkspaceSnapshot {
    workspace: Workspace;
    me: User;
    myRole: Role;
    users: User[];
    memberships: Membership[];
    agents: Agent[];
    teams: Team[];
    repositories: Repository[];
    workstreams: Workstream[];
    executions: Execution[];
    inputRequests: InputRequest[];
    intake: IntakeItem[];
    artifacts: Artifact[];
    decisions: Decision[];
    dependencies: Dependency[];
    comments: Comment[];
    events: DomainEvent[];
    attention: AttentionItem[];
    views: SavedView[];
    integrations: IntegrationConnection[];
}
export interface LiveEvent {
    type: 'created' | 'updated' | 'deleted' | 'attention';
    entity: SubjectType | 'comment' | 'view' | 'dependency' | 'membership' | 'agent' | 'integration';
    id: ID;
    clientId?: string;
    at: ISODate;
}
