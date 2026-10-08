// Request / response shapes for ApiClient that are not entities in contracts/domain.ts.
// Entity types come from `../contracts/domain`. In PATCH bodies `null` clears an optional field.
import type {
  ActorRef,
  Artifact,
  ArtifactKind,
  ArtifactProvider,
  ArtifactState,
  ApiToken,
  CiState,
  CriterionState,
  Decision,
  DependencyNodeType,
  ExecutionProvider,
  GitProvider,
  ID,
  ISODate,
  Issue,
  IssueKind,
  IssueSource,
  IssueStatus,
  Priority,
  ReviewState,
  Role,
  SubjectRef,
  User,
  ViewEntity,
  ViewFilter,
  ViewLayout,
  Workspace,
  Workstream,
  WorkstreamStatus,
} from '../contracts/domain';

// ───── auth ─────
export interface LoginInput {
  email: string;
  password: string;
}
export interface SignupInput {
  name: string;
  email: string;
  password: string;
}
/** GET /auth/me. The client also accepts a bare `User`. */
export interface MeResponse {
  user: User;
  workspaces?: Workspace[];
}

// ───── workspaces ─────
export interface CreateWorkspaceInput {
  name: string;
  /** 3-40 chars: lowercase letters, digits, dashes. Derived from `name` when omitted. */
  slug?: string;
}
export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
}
export interface AddMemberInput {
  /** The person must already have an account. */
  email: string;
  role: Role;
}
export interface UpdateMemberInput {
  role: Role;
}
export interface CreateAgentInput {
  name: string;
  provider: Exclude<ExecutionProvider, 'human'>;
  description?: string;
  ownerUserId?: ID;
}
export interface CreateTokenInput {
  name: string;
  /** Omit: the token acts as you. Set (admin only): the token acts as this agent. */
  agentId?: ID;
  expiresAt?: ISODate;
}
export interface UpdateAgentInput {
  name?: string;
  provider?: Exclude<ExecutionProvider, 'human'>;
  description?: string | null;
  ownerUserId?: ID | null;
}
/** The `secret` is only returned once, on creation. */
export interface CreatedToken {
  token: ApiToken;
  secret: string;
}

// ───── teams / repositories ─────
export interface CreateTeamInput {
  name: string;
  key: string;
  color?: string;
  description?: string;
  memberIds?: ID[];
}
/** The team key is immutable (workstream keys depend on it). */
export interface UpdateTeamInput {
  name?: string;
  color?: string;
  description?: string | null;
  memberIds?: ID[];
}
export interface CreateRepositoryInput {
  provider: GitProvider;
  fullName: string;
  url?: string;
  defaultBranch?: string;
  teamIds?: ID[];
}
export interface UpdateRepositoryInput {
  url?: string;
  defaultBranch?: string;
  teamIds?: ID[];
}

// ───── workstreams ─────
export interface CreateWorkstreamInput {
  title: string;
  description?: string;
  objective?: string;
  context?: string;
  /** https link on delta.dev. Required. */
  deltaThreadUrl: string;
  ownerTeamId: ID;
  participatingTeamIds?: ID[];
  accountableUserId?: ID;
  repositoryIds?: ID[];
  acceptanceCriteria?: { text: string; state?: CriterionState }[];
  priority?: Priority;
  labels?: string[];
  targetDate?: ISODate;
  statusOverride?: WorkstreamStatus;
}
export interface UpdateWorkstreamInput {
  title?: string;
  description?: string | null;
  objective?: string;
  context?: string | null;
  deltaThreadUrl?: string;
  ownerTeamId?: ID;
  participatingTeamIds?: ID[];
  accountableUserId?: ID | null;
  repositoryIds?: ID[];
  /** Replace the whole checklist (prefer the criterion methods for single edits). */
  acceptanceCriteria?: { id?: ID; text: string; state?: CriterionState }[];
  priority?: Priority;
  labels?: string[];
  targetDate?: ISODate | null;
  statusOverride?: WorkstreamStatus | null;
}
export interface CriterionInput {
  text: string;
  state?: CriterionState;
}
export type CriterionPatch = Partial<CriterionInput>;

// ───── input requests ─────
export interface CreateInputRequestInput {
  workstreamId: ID;
  question: string;
  options?: string[];
  assigneeUserId?: ID;
}

// ───── issues ─────
export interface CreateIssueInput {
  kind: IssueKind;
  title: string;
  body?: string;
  source?: IssueSource;
  reporterName?: string;
  assigneeId?: ID;
  teamId?: ID;
  priority?: Priority;
  status?: IssueStatus;
  externalUrl?: string;
}
export interface UpdateIssueInput {
  title?: string;
  body?: string | null;
  assigneeId?: ID | null;
  teamId?: ID | null;
  priority?: Priority;
  status?: IssueStatus;
  reporterName?: string | null;
  externalUrl?: string | null;
  workstreamIds?: ID[];
  /** Id or key. `null` clears the duplicate relation. */
  duplicateOfId?: ID | null;
}
export interface LinkIssueInput {
  workstreamIds?: ID[];
  /** Create a workstream from this issue (title + ownerTeamId required). */
  createWorkstream?: CreateWorkstreamInput;
  /** Defaults to `in_progress` when the issue is `backlog` or `todo`. */
  status?: IssueStatus;
}

// ───── artifacts ─────
export interface CreateArtifactInput {
  workstreamId: ID;
  repositoryId?: ID;
  kind: ArtifactKind;
  provider?: ArtifactProvider;
  title: string;
  url?: string;
  externalId?: string;
  state?: ArtifactState;
  ci?: CiState;
  review?: ReviewState;
  hasConflicts?: boolean;
  environment?: string;
}
export interface UpdateArtifactInput {
  repositoryId?: ID | null;
  title?: string;
  url?: string | null;
  externalId?: string | null;
  state?: ArtifactState;
  ci?: CiState | null;
  review?: ReviewState | null;
  hasConflicts?: boolean | null;
  environment?: string | null;
}

// ───── decisions ─────
export interface CreateDecisionInput {
  title: string;
  statement: string;
  rationale?: string;
  /** Default `proposed`; people can also record it directly as accepted / rejected. */
  status?: 'proposed' | 'accepted' | 'rejected';
  originWorkstreamId?: ID;
  originExecutionId?: ID;
  relatedWorkstreamIds?: ID[];
  tags?: string[];
}
export interface UpdateDecisionInput {
  title?: string;
  statement?: string;
  rationale?: string | null;
  originWorkstreamId?: ID | null;
  originExecutionId?: ID | null;
  relatedWorkstreamIds?: ID[];
  tags?: string[];
}

// ───── dependencies / comments ─────
export interface CreateDependencyInput {
  fromType: DependencyNodeType;
  fromId: ID;
  toType: DependencyNodeType;
  toId: ID;
}
export interface CreateCommentInput {
  subject: SubjectRef;
  body: string;
}

// ───── events / attention / views ─────
export interface EventsQuery {
  workstreamId?: ID;
  /** `type:id`, e.g. `execution:ex_1`. */
  subject?: string;
  /** ISO date cursor: events strictly older than this. */
  before?: ISODate;
  limit?: number;
}
export interface AttentionQuery {
  /** `all` is admin/owner only. */
  scope?: 'mine' | 'all';
}
export interface CreateViewInput {
  name: string;
  entity: ViewEntity;
  filters?: ViewFilter[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  groupBy?: string;
  layout?: ViewLayout;
  shared?: boolean;
}
export interface UpdateViewInput {
  name?: string;
  entity?: ViewEntity;
  filters?: ViewFilter[];
  sort?: { field: string; direction: 'asc' | 'desc' } | null;
  groupBy?: string | null;
  layout?: ViewLayout;
  shared?: boolean;
}

// ───── graph / search ─────
export type GraphNodeType = 'workstream' | 'execution' | 'artifact' | 'decision' | 'issue';
export interface GraphNode {
  id: ID;
  type: GraphNodeType;
  label: string;
  /** Workstream status / execution state / artifact state. */
  status?: string;
  /** Workstream key for workstream nodes. */
  key?: string;
  /** Parent node (execution → workstream / parent execution, artifact → execution/workstream). */
  parentId?: ID;
  teamId?: ID;
  [extra: string]: unknown;
}
export interface GraphEdge {
  id?: ID;
  from: ID;
  to: ID;
  /** `contains` (hierarchy), `dependency` (from blocks to), `artifact`. */
  kind: 'contains' | 'dependency' | 'artifact' | string;
  [extra: string]: unknown;
}
export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface SearchResults {
  workstreams: Workstream[];
  issues: Issue[];
  decisions: Decision[];
  artifacts: Artifact[];
}

// ───── integrations ─────
export interface CreateIntegrationInput {
  provider: GitProvider | 'delta';
  account?: string;
  baseUrl?: string;
  /** PAT / app credential / Delta token. Stored server-side, never returned. */
  token?: string;
  webhookSecret?: string;
}
