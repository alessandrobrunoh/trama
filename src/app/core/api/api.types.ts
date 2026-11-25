// Request / response shapes for ApiClient that are not entities in contracts/domain.ts.
// Entity types come from `../contracts/domain`. In PATCH bodies `null` clears an optional field.
import type {
  ActorRef,
  Artifact,
  ApiToken,
  EstimateScale,
  ExternalProvider,
  ImportCredentialRef,
  ImportMapping,
  ImportOptions,
  ImportSource,
  MemberAccess,
  MemberGrant,
  PermissionMap,
  TokenScope,
  ApiPermission,
  TokenLimits,
  WeekStart,
  OutgoingWebhook,
  ExecutionProvider,
  GitProvider,
  ID,
  ISODate,
  Capability,
  LabelScope,
  Issue,
  IssueKind,
  IssueSource,
  IntegrationConnection,
  IssueStatus,
  Priority,
  ProjectHealth,
  ProjectStatus,
  Role,
  ShareGrant,
  ShareLevel,
  ShareVisibility,
  SubjectRef,
  User,
  ViewEntity,
  ViewFilter,
  ViewLayout,
  Workspace,
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
  /** Replaces the work permissions of each role included (viewer, member, admin). */
  roleGrants?: Partial<Record<Role, MemberGrant[]>>;
  defaultTeamId?: ID | null;
  estimateScale?: EstimateScale;
  weekStart?: WeekStart;
  /** IANA zone or `auto`. */
  timeZone?: string;
  iconColor?: string | null;
  iconInitial?: string | null;
}
export interface CreateLabelInput {
  name: string;
  color?: string;
  scope: LabelScope;
}
export interface UpdateLabelInput {
  name?: string;
  color?: string;
  /** `true` archives (hidden from pickers, kept where used), `false` restores. */
  archived?: boolean;
  /** Custom labels only. Templates stay `issue`. */
  scope?: LabelScope;
}

export interface RoleInput {
  name: string;
  capabilities?: Capability[];
  grants?: MemberGrant[];
}

export interface UpdateRoleInput {
  name?: string;
  capabilities?: Capability[];
  grants?: MemberGrant[];
}

export interface CreateStatusInput {
  name?: string;
  icon: string;
  color: string;
  type: string;
}

export interface UpdateStatusInput {
  name?: string;
  icon?: string;
  color?: string;
}
export interface MergeLabelInput {
  /** Label id that takes over everything labelled with the one being merged away. */
  into: ID;
}
export interface CreateInviteInput {
  email: string;
  role: Role;
  /** Narrower than `role`. Omit for the role in full. */
  access?: MemberAccess | null;
}
export interface AddMemberInput {
  /** The person must already have an account. */
  email: string;
  role: Role;
}
export interface UpdateMemberInput {
  role?: Role;
  /** `null` restores the role in full. Omit to leave access unchanged. */
  access?: MemberAccess | null;
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
  /** Explicit resource × action grants; implies `scope: 'custom'`. */
  permissions?: ApiPermission[];
  /** Request / write caps; omitted values use the defaults. */
  limits?: Partial<TokenLimits>;
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

// ───── projects ─────
export interface CreateProjectInput {
  name: string;
  /** Uppercase tag used to prefix this project's issue keys. */
  key?: string;
  summary?: string;
  description?: string;
  color?: string;
  /** Lucide icon name (kebab-case) or a single emoji. */
  icon?: string;
  status?: ProjectStatus;
  /** Health, set by hand. */
  health?: ProjectHealth;
  priority?: Priority;
  leadId?: ID;
  /** Optional git repository name or URL. Not a repository registry id. */
  repository?: string | null;
  /** Workspace label ids. */
  labels?: ID[];
  startDate?: ISODate;
  targetDate?: ISODate;
}
export interface UpdateProjectInput {
  name?: string;
  /** Uppercase tag used to prefix this project's issue keys. */
  key?: string;
  summary?: string | null;
  description?: string | null;
  color?: string;
  /** Lucide icon name (kebab-case) or a single emoji. `null` resets to the default glyph. */
  icon?: string | null;
  status?: ProjectStatus;
  /** Health, set by hand. `null` clears it. */
  health?: ProjectHealth | null;
  priority?: Priority;
  leadId?: ID | null;
  /** Optional git repository name or URL. `null` clears it. */
  repository?: string | null;
  /** Workspace label ids. Replaces the whole list. */
  labels?: ID[];
  startDate?: ISODate | null;
  targetDate?: ISODate | null;
}

// ───── issues ─────
export interface CreateIssueInput {
  kind: IssueKind;
  title: string;
  body?: string;
  /** Parent issue id when creating a sub-issue. */
  parentId?: ID;
  source?: IssueSource;
  reporterName?: string;
  assigneeId?: ID;
  /** Project the issue is planned under. */
  projectId?: ID;
  priority?: Priority;
  status?: string;
  externalUrl?: string;
  /** Link to the Delta thread (delta.dev) working on this task. */
  threadUrl?: string;
  estimate?: number;
  /** Workspace label ids. */
  labels?: ID[];
}
export interface UpdateIssueInput {
  title?: string;
  /** Changes the issue classification without changing its key. */
  kind?: IssueKind;
  /** Story points (non-negative). `null` clears. */
  estimate?: number | null;
  body?: string | null;
  assigneeId?: ID | null;
  /** `null` clears it and drops that project's milestone. */
  projectId?: ID | null;
  priority?: Priority;
  status?: string;
  reporterName?: string | null;
  externalUrl?: string | null;
  /** Link to the Delta thread (delta.dev) working on this task. `null` clears it. */
  threadUrl?: string | null;
  /** At most one per project; milestones must belong to the issue's project. */
  milestoneIds?: ID[];
  /** Id or key. `null` clears the duplicate relation. */
  duplicateOfId?: ID | null;
  /** Workspace label ids. Replaces the whole list. */
  labels?: ID[];
}
/** One change applied to every issue of a bulk request. */
export interface BulkIssuePatch {
  status?: string;
  priority?: Priority;
  assigneeId?: ID | null;
  projectId?: ID | null;
  addLabels?: ID[];
  removeLabels?: ID[];
}

// ───── milestones ─────
export interface CreateMilestoneInput {
  projectId: ID;
  name: string;
  description?: string;
  targetDate?: ISODate;
  /** Defaults to last in the project. */
  sortOrder?: number;
}
export interface UpdateMilestoneInput {
  name?: string;
  description?: string | null;
  targetDate?: ISODate | null;
  sortOrder?: number;
}

// ───── comments ─────
export interface CreateCommentInput {
  subject: SubjectRef;
  body: string;
}

// ───── events / attention / views ─────
export interface EventsQuery {
  /** `type:id`, e.g. `execution:ex_1`. */
  subject?: string;
  /** Event type prefix, e.g. `issue.` or `issue.status_changed`. */
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
  sharing?: SharingInput;
}
/** Who can open a view. `grants` replaces the whole list of invited workspace members. */
export interface SharingInput {
  visibility?: ShareVisibility;
  grants?: ShareGrant[];
}
export interface InviteViewInput {
  /** Existing workspace members, by email. */
  emails: string[];
  level?: ShareLevel;
}
export interface UpdateViewInput {
  name?: string;
  entity?: ViewEntity;
  filters?: ViewFilter[];
  sort?: { field: string; direction: 'asc' | 'desc' } | null;
  groupBy?: string | null;
  layout?: ViewLayout;
  shared?: boolean;
  sharing?: SharingInput;
}

// ───── search ─────
export interface SearchResults {
  issues: Issue[];
  artifacts: Artifact[];
}

// ───── integrations ─────
/** `POST /integrations`. The account is read from the provider; Delta needs `baseUrl`. */
export interface CreateIntegrationInput {
  provider: GitProvider | 'delta';
  /** PAT / app credential / Delta token. Stored server-side, never returned. */
  token: string;
  /** GitHub Enterprise / self-hosted GitLab / Delta base URL (Bitbucket Cloud has none). */
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

// ───── imports from GitHub Issues / Linear ─────
export interface ImportTargetInput extends ImportCredentialRef {
  provider: ExternalProvider;
  source: ImportSource;
}
export interface StartImportInput extends ImportTargetInput {
  /** Omit to use the preview's suggestions. */
  mapping?: ImportMapping;
  options?: Partial<ImportOptions>;
}
export interface CreateImportCredentialInput {
  provider: ExternalProvider;
  token: string;
  /** GitHub Enterprise only. */
  baseUrl?: string;
}

export interface TimeEntry {
  id: ID;
  workspaceId: ID;
  userId: ID;
  projectId: ID | null;
  issueId: ID | null;
  description: string;
  startedAt: ISODate;
  endedAt: ISODate | null;
  createdAt: ISODate;
  updatedAt: ISODate;
}
export interface TimeEntryTarget {
  description?: string;
  projectId?: ID | null;
  issueId?: ID | null;
}
export interface ManualTimeEntryInput extends TimeEntryTarget {
  startedAt: ISODate;
  endedAt: ISODate;
}
