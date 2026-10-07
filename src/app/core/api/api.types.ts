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
  Execution,
  ExecutionProvider,
  ExecutionState,
  GitProvider,
  ID,
  ISODate,
  IntakeItem,
  IntakeKind,
  IntakeSource,
  IntakeState,
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
  objective?: string;
  context?: string;
  ownerTeamId: ID;
  participatingTeamIds?: ID[];
  accountableUserId?: ID;
  repositoryIds?: ID[];
  acceptanceCriteria?: { text: string; state?: CriterionState }[];
  priority?: Priority;
  labels?: string[];
  targetDate?: ISODate;
  statusOverride?: 'draft' | 'canceled';
}
export interface UpdateWorkstreamInput {
  title?: string;
  objective?: string;
  context?: string | null;
  ownerTeamId?: ID;
  participatingTeamIds?: ID[];
  accountableUserId?: ID | null;
  repositoryIds?: ID[];
  /** Replace the whole checklist (prefer the criterion methods for single edits). */
  acceptanceCriteria?: { id?: ID; text: string; state?: CriterionState }[];
  priority?: Priority;
  labels?: string[];
  targetDate?: ISODate | null;
  statusOverride?: 'draft' | 'canceled' | null;
}
export interface CriterionInput {
  text: string;
  state?: CriterionState;
}
export type CriterionPatch = Partial<CriterionInput>;

// ───── executions / input requests ─────
export interface CreateExecutionInput {
  workstreamId: ID;
  title: string;
  description?: string;
  parentExecutionId?: ID;
  teamId?: ID;
  repositoryIds?: ID[];
  performers?: ActorRef[];
  provider?: ExecutionProvider;
  state?: ExecutionState;
  dependsOnExecutionIds?: ID[];
  sessionUrl?: string;
  branch?: string;
  progressNote?: string;
}
export interface UpdateExecutionInput {
  title?: string;
  description?: string | null;
  teamId?: ID | null;
  repositoryIds?: ID[];
  performers?: ActorRef[];
  provider?: ExecutionProvider;
  state?: ExecutionState;
  parentExecutionId?: ID | null;
  dependsOnExecutionIds?: ID[];
  sessionUrl?: string | null;
  branch?: string | null;
  progressNote?: string | null;
}
export interface ReportProgressInput {
  note: string;
  state?: ExecutionState;
}
export interface CreateInputRequestInput {
  /** Optional when `executionId` is given. */
  workstreamId?: ID;
  executionId?: ID;
  question: string;
  options?: string[];
  assigneeUserId?: ID;
}

// ───── intake ─────
export interface CreateIntakeInput {
  kind: IntakeKind;
  title: string;
  body?: string;
  source?: IntakeSource;
  reporterName?: string;
  teamId?: ID;
  priority?: Priority;
  externalUrl?: string;
}
export interface UpdateIntakeInput {
  title?: string;
  body?: string | null;
  teamId?: ID | null;
  priority?: Priority;
  reporterName?: string | null;
  externalUrl?: string | null;
  workstreamIds?: ID[];
}
export interface TriageIntakeInput {
  state: Exclude<IntakeState, 'new'>;
  workstreamIds?: ID[];
  /** Create a workstream from this item (title + ownerTeamId required). */
  createWorkstream?: CreateWorkstreamInput;
  /** Id or key of the item this duplicates (required when state = duplicate). */
  duplicateOfId?: ID;
  teamId?: ID | null;
  priority?: Priority;
}

// ───── artifacts ─────
export interface CreateArtifactInput {
  workstreamId: ID;
  executionId?: ID;
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
  executionId?: ID | null;
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
export type GraphNodeType = 'workstream' | 'execution' | 'artifact' | 'decision' | 'intake';
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
  intake: IntakeItem[];
  decisions: Decision[];
  executions: Execution[];
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
