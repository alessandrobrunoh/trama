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
  /** Always fully resolved by the server (defaults filled in). */
  settings: WorkspaceSettings;
  createdAt: ISODate;
}

export interface Membership {
  id: ID;
  workspaceId: ID;
  userId: ID;
  role: Role;
  createdAt: ISODate;
}

/** Runtimes that can act in a workspace. `human` = a person. */
export type ExecutionProvider = 'human' | 'delta' | 'claude_code' | 'codex' | 'cursor' | 'other';

/** https URL on delta.dev (or a subdomain), e.g. a Delta thread. */
export function isDeltaThreadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'delta.dev' || host.endsWith('.delta.dev'));
  } catch {
    return false;
  }
}

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
  /** Team leads (a subset of `memberIds`). Leads may edit their team in the workspace settings of the team. */
  leadIds: ID[];
  /** Who may edit the workstreams / issues owned by this team. Workspace admins and owners always can. */
  editPolicy: TeamEditPolicy;
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
 * Derived from artifacts / input requests / decisions / dependencies.
 * Any status can be pinned manually via `statusOverride` (the board does this). `null` clears it.
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
  /** What this workstream is (markdown). */
  description?: string;
  /** The outcome that needs to happen (markdown). */
  objective: string;
  /** Why this work exists (markdown). */
  context?: string;
  /**
   * Delta thread that carries this workstream (a chat on delta.dev).
   * Required: one workstream is linked to one Delta thread.
   */
  deltaThreadUrl: string;
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
  statusOverride?: WorkstreamStatus;
  /** When work is planned to begin (timeline start). */
  startDate?: ISODate;
  targetDate?: ISODate;
  createdById: ID;
  createdAt: ISODate;
  updatedAt: ISODate;
  shippedAt?: ISODate;
}

/** Linear-style milestone inside a workstream. An issue is in at most one milestone per workstream. */
export interface Milestone {
  /** `ms_…` */
  id: ID;
  workspaceId: ID;
  workstreamId: ID;
  name: string;
  description?: string;
  targetDate?: ISODate;
  /** Ascending order inside the workstream (reorder by PATCHing it). */
  sortOrder: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ───────────────────────────── Input requests ─────────────────────────

export type InputRequestState = 'open' | 'answered' | 'dismissed';

/** A question on a workstream that needs a human answer. */
export interface InputRequest {
  id: ID;
  workstreamId: ID;
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

// ───────────────────────────── Issues ─────────────────────────────

export type IssueKind = 'bug' | 'feature' | 'incident' | 'tech_debt' | 'feedback' | 'idea' | 'security';
/** Key prefix per kind: BUG-142, FEAT-12, INC-3, DEBT-7, FB-20, IDEA-4, SEC-2 (numbering per kind). */
export const ISSUE_KEY_PREFIX: Record<IssueKind, string> = {
  bug: 'BUG',
  feature: 'FEAT',
  incident: 'INC',
  tech_debt: 'DEBT',
  feedback: 'FB',
  idea: 'IDEA',
  security: 'SEC',
};

/**
 * Tracker status, independent of workstream status.
 * `backlog` is unscheduled demand; linking an issue into a workstream usually moves it to `in_progress`.
 */
export type IssueStatus = 'draft' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';
export type IssueSource = 'manual' | 'github' | 'gitlab' | 'email' | 'api' | 'agent';

/**
 * A unit of demand: one bug, request, incident, or task.
 * Several issues can contribute to one workstream; an issue is not the unit of execution.
 */
export interface Issue {
  id: ID;
  workspaceId: ID;
  key: string;
  number: number;
  kind: IssueKind;
  title: string;
  /** Description. */
  body?: string;
  source: IssueSource;
  /** Free-text reporter (customer, email…) when not a workspace user. */
  reporterName?: string;
  reporterId?: ID;
  /** Person responsible for this issue. Distinct from workstream accountability. */
  assigneeId?: ID;
  teamId?: ID;
  priority: Priority;
  status: IssueStatus;
  /** Workstreams this issue contributes to (many issues → one workstream, and the reverse). */
  workstreamIds: ID[];
  /**
   * Milestones this issue is in: at most one per workstream, and only milestones of workstreams in
   * `workstreamIds`. Unlinking a workstream drops its milestone.
   */
  milestoneIds: ID[];
  /** Story-point estimate (non-negative). Scales live in src/app/core/estimates.ts. */
  estimate?: number;
  /** First time the status entered in_progress / in_review. Kept when moved back. */
  startedAt?: ISODate;
  /** Set when the status becomes done or canceled; cleared on reopen. */
  completedAt?: ISODate;
  /** Previous keys (changing `kind` re-keys the issue); lookups by key also match these. */
  aliases: string[];
  /** Set when this issue duplicates another. Status is `canceled`. */
  duplicateOfId?: ID;
  externalUrl?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ───────────────────────────── Artifacts ─────────────────────────────

export type ArtifactKind =
  | 'pull_request'
  | 'merge_request'
  | 'document'
  | 'design'
  | 'image'
  | 'file'
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

export type DecisionStatus = 'draft' | 'proposed' | 'accepted' | 'superseded' | 'rejected';

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

export type DependencyNodeType = 'workstream';

/** `from` blocks `to` until `from` is shipped. */
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
  | 'issue'
  | 'artifact'
  | 'decision'
  | 'input_request'
  | 'repository'
  | 'team'
  | 'milestone';

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
 * criterion.updated, input.requested, input.answered, artifact.attached,
 * artifact.updated, decision.proposed, decision.accepted, issue.created,
 * issue.status_changed, issue.rekeyed, issue.linked, milestone.created, milestone.updated, milestone.deleted, dependency.added, comment.created, review.requested.
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
  artifactId?: ID;
  decisionId?: ID;
  inputRequestId?: ID;
  issueId?: ID;
  /** When the underlying condition started. */
  since: ISODate;
  /** Per-user state. */
  state: 'open' | 'snoozed' | 'dismissed';
  snoozedUntil?: ISODate;
}

// ───────────────────────────── Views & tokens ─────────────────────────────

export type ViewEntity = 'workstream' | 'issue' | 'decision';
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
  /** What the token may do: read = GET only, write = everyday work (member role), admin = everything the actor's role allows. */
  scope: TokenScope;
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

// ───────────────────────────── Permissions & workspace settings ─────────────────────────────

export type TeamEditPolicy = 'workspace' | 'members';
export const TEAM_EDIT_POLICIES: Record<TeamEditPolicy, { label: string; description: string }> = {
  workspace: { label: 'Everyone in the workspace', description: 'Any member (or above) can edit this team\'s workstreams and issues.' },
  members: { label: 'Team members only', description: 'Only people on this team (and workspace admins) can edit its workstreams and issues.' },
};

export type TokenScope = 'read' | 'write' | 'admin';
export const TOKEN_SCOPES: Record<TokenScope, { label: string; description: string }> = {
  read: { label: 'Read', description: 'Read-only: GET requests. Good for dashboards and reporting.' },
  write: { label: 'Write', description: 'Create and update work (workstreams, issues, comments…) with at most the member role. Cannot change workspace settings.' },
  admin: { label: 'Admin', description: 'Everything the acting user\'s role allows, including members, integrations and settings. Only admins can create one.' },
};

/** Things the workspace owner can gate behind a minimum role (Settings → Roles & permissions). */
export type Capability =
  | 'createWorkstreams'
  | 'deleteWorkstreams'
  | 'createIssues'
  | 'deleteIssues'
  | 'acceptDecisions'
  | 'manageSharedViews'
  | 'createTeams'
  | 'manageTeams'
  | 'manageRepositories'
  | 'inviteMembers'
  | 'manageAgents'
  | 'manageTokens'
  | 'manageIntegrations';

/** Minimum role per capability. */
export type PermissionMap = Record<Capability, Role>;

/** Roles a capability can be set to. Viewers are read-only, so `viewer` is never offered. */
export const CAPABILITY_ROLES: Role[] = ['member', 'admin', 'owner'];

export interface CapabilityMeta {
  label: string;
  description: string;
  group: 'Work' | 'Organization' | 'Access & automation';
}

export const CAPABILITIES: Capability[] = [
  'createWorkstreams',
  'deleteWorkstreams',
  'createIssues',
  'deleteIssues',
  'acceptDecisions',
  'manageSharedViews',
  'createTeams',
  'manageTeams',
  'manageRepositories',
  'inviteMembers',
  'manageAgents',
  'manageTokens',
  'manageIntegrations',
];

export const CAPABILITY_META: Record<Capability, CapabilityMeta> = {
  createWorkstreams: { group: 'Work', label: 'Create workstreams', description: 'Start a new workstream.' },
  deleteWorkstreams: { group: 'Work', label: 'Delete workstreams', description: 'Permanently delete a workstream with its input requests, artifacts and comments.' },
  createIssues: { group: 'Work', label: 'Create issues', description: 'File bugs, features, incidents and other issues.' },
  deleteIssues: { group: 'Work', label: 'Delete issues', description: 'Permanently delete an issue (prefer canceling it).' },
  acceptDecisions: { group: 'Work', label: 'Accept and reject decisions', description: 'Accept, reject or supersede a proposed decision. Always needs a person, never an agent.' },
  manageSharedViews: { group: 'Work', label: 'Share views', description: 'Create or publish saved views for the whole workspace.' },
  createTeams: { group: 'Organization', label: 'Create teams', description: 'Add a team to the workspace.' },
  manageTeams: { group: 'Organization', label: 'Edit and delete teams', description: 'Rename, re-colour, change members or delete a team. A team lead can always edit their own team.' },
  manageRepositories: { group: 'Organization', label: 'Manage repositories', description: 'Add, edit and remove repositories.' },
  inviteMembers: { group: 'Access & automation', label: 'Invite members', description: 'Add people to the workspace. They can only be given a role up to your own.' },
  manageAgents: { group: 'Access & automation', label: 'Manage agents', description: 'Register agents, edit them, and mint tokens that act as an agent.' },
  manageTokens: { group: 'Access & automation', label: 'Create API tokens', description: 'Create personal API tokens (read / write scope). Admin-scope tokens always need an admin.' },
  manageIntegrations: { group: 'Access & automation', label: 'Manage integrations', description: 'Connect GitHub, GitLab and Delta, and manage outgoing webhooks.' },
};

/** Today's behaviour: everyday work for members, structure and access for admins. */
export const DEFAULT_PERMISSIONS: PermissionMap = {
  createWorkstreams: 'member',
  deleteWorkstreams: 'member',
  createIssues: 'member',
  deleteIssues: 'member',
  acceptDecisions: 'member',
  manageSharedViews: 'member',
  createTeams: 'admin',
  manageTeams: 'admin',
  manageRepositories: 'admin',
  inviteMembers: 'admin',
  manageAgents: 'admin',
  manageTokens: 'member',
  manageIntegrations: 'admin',
};

export type EstimateScale = 'fibonacci' | 'linear' | 'exponential' | 'tshirt' | 'none';
export const ESTIMATE_SCALES: EstimateScale[] = ['fibonacci', 'linear', 'exponential', 'tshirt', 'none'];
export type WeekStart = 'monday' | 'sunday' | 'saturday';
export const WEEK_STARTS: WeekStart[] = ['monday', 'sunday', 'saturday'];

export interface WorkspaceSettings {
  permissions: PermissionMap;
  /** Team preselected when creating issues and workstreams. */
  defaultTeamId?: ID;
  /** Scale offered for issue estimates. Estimates are stored as numbers either way. */
  estimateScale: EstimateScale;
  weekStart: WeekStart;
  /** IANA time zone used to display dates, or `auto` to follow each person's browser. */
  timeZone: string;
  /** Workspace icon background, `#rrggbb`. */
  iconColor?: string;
  /** 1-2 characters shown in the workspace icon (defaults to the name's initial). */
  iconInitial?: string;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  permissions: DEFAULT_PERMISSIONS,
  estimateScale: 'fibonacci',
  weekStart: 'monday',
  timeZone: 'auto',
};

/** Fills the gaps of a stored (partial) settings object with the defaults. */
export function resolveWorkspaceSettings(raw?: Partial<Omit<WorkspaceSettings, 'permissions'>> & { permissions?: Partial<PermissionMap> } | null): WorkspaceSettings {
  const r = raw ?? {};
  return {
    ...DEFAULT_WORKSPACE_SETTINGS,
    ...r,
    permissions: { ...DEFAULT_PERMISSIONS, ...(r.permissions ?? {}) },
  } as WorkspaceSettings;
}

const ROLE_ORDER: Role[] = ['viewer', 'member', 'admin', 'owner'];
/** True when `role` is at least `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

// ───────────────────────────── Outgoing webhooks ─────────────────────────────

/**
 * A custom integration: Nabla POSTs a signed JSON body to `url` for every domain event that matches `events`.
 * Body: `{ id, event, workspace, at, actor, subject, workstreamId?, data }`.
 * Headers: `X-Nabla-Event`, `X-Nabla-Delivery`, `X-Nabla-Signature: sha256=<hex hmac of the raw body with the secret>`.
 */
export interface OutgoingWebhook {
  id: ID;
  workspaceId: ID;
  name: string;
  url: string;
  /** Event types, `entity.*` wildcards (`issue.*`) or `*`. */
  events: string[];
  enabled: boolean;
  createdAt: ISODate;
  lastDeliveryAt?: ISODate;
  /** HTTP status of the last delivery, or 0 when it failed before getting a response. */
  lastStatus?: number;
}

export interface WebhookDeliveryLog {
  id: ID;
  webhookId: ID;
  event: string;
  /** 0 when there was no HTTP response (timeout, DNS, connection refused). */
  status: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  /** 1 or 2 (one retry at most). */
  attempt: number;
  at: ISODate;
}

/** Event types a webhook can subscribe to, grouped by entity (for pickers). */
export const WEBHOOK_EVENT_GROUPS: { entity: string; label: string; events: string[] }[] = [
  { entity: 'workstream', label: 'Workstreams', events: ['workstream.created', 'workstream.updated', 'workstream.status_changed', 'workstream.deleted'] },
  { entity: 'issue', label: 'Issues', events: ['issue.created', 'issue.updated', 'issue.status_changed', 'issue.linked', 'issue.deleted'] },
  { entity: 'decision', label: 'Decisions', events: ['decision.draft', 'decision.proposed', 'decision.accepted', 'decision.rejected', 'decision.superseded', 'decision.updated', 'decision.deleted'] },
  { entity: 'input', label: 'Input requests', events: ['input.requested', 'input.answered', 'input.dismissed', 'input.updated', 'input.deleted'] },
  { entity: 'artifact', label: 'Artifacts', events: ['artifact.attached', 'artifact.updated', 'artifact.deleted'] },
  { entity: 'comment', label: 'Comments', events: ['comment.created'] },
  { entity: 'dependency', label: 'Dependencies', events: ['dependency.added', 'dependency.removed'] },
  { entity: 'team', label: 'Teams', events: ['team.created', 'team.updated', 'team.deleted'] },
  { entity: 'repository', label: 'Repositories', events: ['repository.created', 'repository.updated', 'repository.deleted'] },
];

/** Does a webhook subscription pattern (`*`, `issue.*`, `issue.created`) match an event type? */
export function webhookEventMatches(patterns: readonly string[], type: string): boolean {
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
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
  milestones: Milestone[];
  inputRequests: InputRequest[];
  issues: Issue[];
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
  entity: SubjectType | 'comment' | 'view' | 'dependency' | 'membership' | 'agent' | 'integration' | 'workspace' | 'webhook';
  id: ID;
  /** X-Client-Id of the originating request, so a tab can ignore its own echoes. */
  clientId?: string;
  at: ISODate;
}
