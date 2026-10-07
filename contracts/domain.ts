/**
 * Nabla domain contract — SINGLE SOURCE OF TRUTH for entity shapes shared by
 * the NestJS API (server/) and the Angular client (src/).
 *
 * Do not edit the synced copies (server/src/contracts/domain.ts,
 * src/app/core/contracts/domain.ts); edit this file and run
 * `node scripts/sync-contracts.mjs` from the project root.
 *
 * Conventions: ids are opaque strings (prefixed, e.g. `ws_…`, `ex_…`), dates
 * are ISO-8601 strings, optional fields are omitted (never null) in responses;
 * in PATCH bodies `null` clears an optional field.
 */

export type ID = string;
export type ISODate = string;

// ───────────────────────────── Identity & workspace ─────────────────────────────

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

/** Execution environments that can perform work. `human` = done by a person. */
export type ExecutionProvider = 'human' | 'delta' | 'claude_code' | 'codex' | 'cursor' | 'other';

/** A registered agent identity inside a workspace (its own actor, with API tokens). */
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
  /** omitted for `system` */
  id?: ID;
}

export interface Team {
  id: ID;
  workspaceId: ID;
  name: string;
  /** Uppercase identifier prefix, e.g. AUTH, WEB, INF. Unique per workspace. */
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
  /** e.g. "acme/api" */
  fullName: string;
  url: string;
  defaultBranch: string;
  teamIds: ID[];
  createdAt: ISODate;
}

// ───────────────────────────── Workstreams ─────────────────────────────

export type Priority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

/**
 * Derived from executions / artifacts / input requests / dependencies (see
 * PLAN.md §Derived status). `draft` and `canceled` can also be set manually via
 * `statusOverride`.
 */
export type WorkstreamStatus =
  | 'draft'
  | 'planned'
  | 'working'
  | 'needs_input'
  | 'in_review'
  | 'blocked'
  | 'ready_to_land'
  | 'shipped'
  | 'canceled';

export type CriterionState = 'pending' | 'in_progress' | 'met';
export interface AcceptanceCriterion {
  id: ID;
  text: string;
  state: CriterionState;
}

export interface Workstream {
  id: ID;
  workspaceId: ID;
  /** `${ownerTeam.key}-${number}`, e.g. AUTH-42; numbering is per owner team. */
  key: string;
  number: number;
  title: string;
  /** The outcome that needs to happen (markdown). */
  objective: string;
  /** Why this work exists (markdown). */
  context?: string;
  ownerTeamId: ID;
  participatingTeamIds: ID[];
  accountableUserId?: ID;
  repositoryIds: ID[];
  acceptanceCriteria: AcceptanceCriterion[];
  priority: Priority;
  labels: string[];
  /** Effective status (override ?? derived). Computed by the server. */
  status: WorkstreamStatus;
  /** The derived status, ignoring the override. Computed by the server. */
  derivedStatus: WorkstreamStatus;
  statusOverride?: 'draft' | 'canceled';
  targetDate?: ISODate;
  createdById: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  shippedAt?: ISODate;
}

// ───────────────────────────── Executions ─────────────────────────────

export type ExecutionState =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'in_review'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'canceled';

export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = ['completed', 'failed', 'canceled'];

/** A concrete attempt to perform part of a workstream, by humans and/or agents. */
export interface Execution {
  id: ID;
  workstreamId: ID;
  parentExecutionId?: ID;
  title: string;
  description?: string;
  teamId?: ID;
  repositoryIds: ID[];
  /** Who performs it — one or more users / agents / teams. */
  performers: ActorRef[];
  provider: ExecutionProvider;
  state: ExecutionState;
  /** Executions that must complete before this one can proceed. */
  dependsOnExecutionIds: ID[];
  /** Link to the agent session (e.g. a Delta thread) if any. */
  sessionUrl?: string;
  branch?: string;
  /** Latest progress note reported by the performer. */
  progressNote?: string;
  startedAt?: ISODate;
  completedAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export type InputRequestState = 'open' | 'answered' | 'dismissed';

/** A question an execution (usually an agent) needs a human to answer. */
export interface InputRequest {
  id: ID;
  workstreamId: ID;
  executionId?: ID;
  question: string;
  /** Optional suggested answers. */
  options?: string[];
  requestedBy: ActorRef;
  assigneeUserId?: ID;
  state: InputRequestState;
  answer?: string;
  answeredById?: ID;
  createdAt: ISODate;
  answeredAt?: ISODate;
}

// ───────────────────────────── Intake ─────────────────────────────

export type IntakeKind = 'bug' | 'feature' | 'incident' | 'tech_debt' | 'feedback' | 'idea' | 'security';
/** Key prefix per kind: BUG-142, FEAT-12, INC-3, DEBT-7, FB-20, IDEA-4, SEC-2 (numbering per kind). */
export const INTAKE_KEY_PREFIX: Record<IntakeKind, string> = {
  bug: 'BUG',
  feature: 'FEAT',
  incident: 'INC',
  tech_debt: 'DEBT',
  feedback: 'FB',
  idea: 'IDEA',
  security: 'SEC',
};

export type IntakeState = 'new' | 'triaged' | 'accepted' | 'declined' | 'duplicate';
export type IntakeSource = 'manual' | 'github' | 'gitlab' | 'email' | 'api' | 'agent';

/** Incoming information (bug reports, requests, incidents…), triaged into workstreams. */
export interface IntakeItem {
  id: ID;
  workspaceId: ID;
  key: string;
  number: number;
  kind: IntakeKind;
  title: string;
  body?: string;
  source: IntakeSource;
  /** Free-text reporter (customer, email…) when not a workspace user. */
  reporterName?: string;
  reporterId?: ID;
  teamId?: ID;
  priority: Priority;
  state: IntakeState;
  /** Workstreams this item contributes to (many intake → one workstream). */
  workstreamIds: ID[];
  duplicateOfId?: ID;
  externalUrl?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ───────────────────────────── Artifacts ─────────────────────────────

export type ArtifactKind =
  | 'pull_request'
  | 'merge_request'
  | 'commit'
  | 'branch'
  | 'document'
  | 'design'
  | 'build'
  | 'test_report'
  | 'deployment'
  | 'release';

export type ArtifactProvider = 'github' | 'gitlab' | 'delta' | 'figma' | 'docs' | 'ci' | 'other';

export type ArtifactState =
  | 'draft'
  | 'open'
  | 'merged'
  | 'closed'
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'healthy'
  | 'degraded'
  | 'published';

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
  /** e.g. "#182", a commit sha, "ADR-021", "staging/auth-2026-10-07". */
  externalId?: string;
  state: ArtifactState;
  /** PR/MR/commit CI status. */
  ci?: CiState;
  /** PR/MR review status. */
  review?: ReviewState;
  /** PR/MR has merge conflicts. */
  hasConflicts?: boolean;
  /** Deployment / release environment, e.g. "staging", "production". */
  environment?: string;
  authorRef?: ActorRef;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ───────────────────────────── Decisions ─────────────────────────────

export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected';

/** Reusable project knowledge: what was decided and why. Key: ADR-<n> per workspace. */
export interface Decision {
  id: ID;
  workspaceId: ID;
  key: string;
  number: number;
  title: string;
  /** What was decided (markdown). */
  statement: string;
  /** Why (markdown). */
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

// ───────────────────────────── Dependencies ─────────────────────────────

export type DependencyNodeType = 'workstream' | 'execution';

/** `from` blocks `to` until `from` is shipped (workstream) / completed (execution). */
export interface Dependency {
  id: ID;
  workspaceId: ID;
  fromType: DependencyNodeType;
  fromId: ID;
  toType: DependencyNodeType;
  toId: ID;
  createdAt: ISODate;
}

// ───────────────────────────── Comments & events ─────────────────────────────

export type SubjectType =
  | 'workstream'
  | 'execution'
  | 'intake'
  | 'artifact'
  | 'decision'
  | 'input_request'
  | 'repository'
  | 'team';

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

/**
 * Append-only activity log (event-based activity model). Written by the server
 * on every mutation and by integrations/agents. `type` examples:
 * workstream.created, workstream.updated, workstream.status_changed,
 * criterion.updated, execution.created, execution.state_changed,
 * execution.progress, input.requested, input.answered, artifact.attached,
 * artifact.updated, decision.proposed, decision.accepted, intake.created,
 * intake.triaged, dependency.added, comment.created, review.requested.
 */
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

// ───────────────────────────── Attention ─────────────────────────────

export type AttentionKind =
  | 'input_requested'
  | 'needs_decision'
  | 'review_requested'
  | 'blocked'
  | 'ci_failed'
  | 'conflict'
  | 'dependency'
  | 'deadline'
  | 'ready_to_land'
  | 'ready_to_ship'
  | 'triage';

export type AttentionSeverity = 'high' | 'medium' | 'low';

/** Derived server-side for the current user ("where is my attention required?"). */
export interface AttentionItem {
  /** Stable id derived from kind + source entity, so dismiss/snooze survive recomputation. */
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
  /** When the underlying condition started. */
  since: ISODate;
  /** Per-user state. */
  state: 'open' | 'snoozed' | 'dismissed';
  snoozedUntil?: ISODate;
}

// ───────────────────────────── Views & tokens ─────────────────────────────

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
  sort?: { field: string; direction: 'asc' | 'desc' };
  groupBy?: string;
  layout: ViewLayout;
  /** Visible to the whole workspace vs. only the owner. */
  shared: boolean;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** API token (for agents, MCP clients, scripts). The secret is only returned once on creation. */
export interface ApiToken {
  id: ID;
  workspaceId: ID;
  name: string;
  /** First chars of the token for display, e.g. "nbl_3f9a…". */
  prefix: string;
  /** Token acts as this actor (a user or an agent). */
  actor: ActorRef;
  lastUsedAt?: ISODate;
  createdAt: ISODate;
  expiresAt?: ISODate;
}

// ───────────────────────────── Integrations ─────────────────────────────

export interface IntegrationConnection {
  id: ID;
  workspaceId: ID;
  provider: GitProvider | 'delta';
  /** Display account, e.g. GitHub org/user. */
  account: string;
  /** Base URL for self-hosted GitLab / GitHub Enterprise. */
  baseUrl?: string;
  /** Whether a webhook secret is configured (secret itself never returned). */
  webhookConfigured: boolean;
  status: 'connected' | 'error' | 'disconnected';
  lastSyncAt?: ISODate;
  lastError?: string;
  createdAt: ISODate;
}

// ───────────────────────────── Snapshot ─────────────────────────────

/** GET /api/w/:slug/snapshot — everything the client needs to boot a workspace. */
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
  /** Most recent events (e.g. last 500); older ones via GET /events?before=. */
  events: DomainEvent[];
  attention: AttentionItem[];
  views: SavedView[];
  integrations: IntegrationConnection[];
}

/** Server-sent event on GET /api/w/:slug/events/stream. Clients refetch / patch on receipt. */
export interface LiveEvent {
  type: 'created' | 'updated' | 'deleted' | 'attention';
  entity: SubjectType | 'comment' | 'view' | 'dependency' | 'membership' | 'agent' | 'integration';
  id: ID;
  /** X-Client-Id of the originating request, so a tab can ignore its own echoes. */
  clientId?: string;
  at: ISODate;
}
