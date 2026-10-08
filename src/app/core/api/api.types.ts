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
  EstimateScale,
  PermissionMap,
  TeamEditPolicy,
  TokenScope,
  WeekStart,
  OutgoingWebhook,
  DependencyNodeType,
  ExecutionProvider,
  GitProvider,
  ID,
  ISODate,
  Issue,
  IssueKind,
  IssueSource,
  IntegrationConnection,
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
/** `PATCH /w/:slug/settings` (admin; `permissions` is owner-only). `null` clears the optional fields. */
export interface UpdateWorkspaceSettingsInput {
  /** Partial: only the capabilities you send change. */
  permissions?: Partial<PermissionMap>;
  defaultTeamId?: ID | null;
  estimateScale?: EstimateScale;
  weekStart?: WeekStart;
  /** IANA zone or `auto`. */
  timeZone?: string;
  iconColor?: string | null;
  iconInitial?: string | null;
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
  /** Default `write`. `admin` needs an admin caller and cannot be used for agents. */
  scope?: TokenScope;
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
  /** Subset of `memberIds`. */
  leadIds?: ID[];
  editPolicy?: TeamEditPolicy;
}
/** The team key is immutable (workstream keys depend on it). */
export interface UpdateTeamInput {
  name?: string;
  color?: string;
  description?: string | null;
  memberIds?: ID[];
  leadIds?: ID[];
  editPolicy?: TeamEditPolicy;
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
  startDate?: ISODate;
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
  startDate?: ISODate | null;
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
/** PATCH /input-requests/:id (open requests only). `null` clears. */
export interface UpdateInputRequestInput {
  question?: string;
  options?: string[] | null;
  assigneeUserId?: ID | null;
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
  estimate?: number;
}
export interface UpdateIssueInput {
  title?: string;
  /** Re-keys the issue (BUG-148 → FEAT-35); the old key stays valid as an alias. */
  kind?: IssueKind;
  /** Story points (non-negative). `null` clears. */
  estimate?: number | null;
  body?: string | null;
  assigneeId?: ID | null;
  teamId?: ID | null;
  priority?: Priority;
  status?: IssueStatus;
  reporterName?: string | null;
  externalUrl?: string | null;
  workstreamIds?: ID[];
  /** At most one per linked workstream; only milestones of linked workstreams. */
  milestoneIds?: ID[];
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

// ───── milestones ─────
export interface CreateMilestoneInput {
  workstreamId: ID;
  name: string;
  description?: string;
  targetDate?: ISODate;
  /** Defaults to last in the workstream. */
  sortOrder?: number;
}
export interface UpdateMilestoneInput {
  name?: string;
  description?: string | null;
  targetDate?: ISODate | null;
  sortOrder?: number;
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
  /** Event type prefix, e.g. `issue.` or `decision.accepted`. */
  type?: string;
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
/** `POST /integrations`. The account is read from the provider; Delta needs `baseUrl`. */
export interface CreateIntegrationInput {
  provider: GitProvider | 'delta';
  /** PAT / app credential / Delta token. Stored server-side, never returned. */
  token: string;
  /** GitHub Enterprise / self-hosted GitLab / Delta base URL. */
  baseUrl?: string;
}
/** `PATCH /integrations/:id` — re-validates against the provider and refreshes account/status. */
export interface UpdateIntegrationInput {
  token?: string;
  baseUrl?: string | null;
}
/** What `GET /integrations` returns: the contract entity plus webhook / link details. */
export type IntegrationDetail = IntegrationConnection & {
  webhookUrl?: string;
  repositoryIds: ID[];
  lastWebhookAt?: ISODate;
};
/** One-time webhook setup (the secret is only returned on create and rotate). */
export interface WebhookSetup {
  url: string;
  secret: string;
  contentType: string;
  events: string[];
}
export interface IntegrationWithWebhook {
  connection: IntegrationDetail;
  webhook?: WebhookSetup;
}
export interface RemoteRepository {
  fullName: string;
  url: string;
  defaultBranch: string;
  private?: boolean;
  description?: string;
  linked: boolean;
  repositoryId?: ID;
}
export interface RemoteRepositoryPage {
  items: RemoteRepository[];
  page: number;
  perPage: number;
  hasMore: boolean;
}
export interface LinkRepositoryInput {
  fullName: string;
  teamIds?: ID[];
}

// ───── outgoing webhooks (custom integrations) ─────
export interface CreateWebhookInput {
  name: string;
  url: string;
  /** Event types, `entity.*` wildcards or `*`. */
  events: string[];
  enabled?: boolean;
}
export interface UpdateWebhookInput {
  name?: string;
  url?: string;
  events?: string[];
  enabled?: boolean;
}
/** Returned on create and on secret rotation: the signing secret is shown once. */
export interface WebhookWithSecret {
  webhook: OutgoingWebhook;
  secret: string;
}
