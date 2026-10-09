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

// ───────────────────────────── Notifications ─────────────────────────────

/** Why a notification was sent. Each kind can be switched on or off per person and channel. */
export const NOTIFICATION_KINDS = [
  'assigned',
  'input_requested',
  'decision_proposed',
  'review_requested',
  'ci_failed',
  'comment',
  'workstream_update',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_KIND_META: Record<NotificationKind, { label: string; description: string }> = {
  assigned: { label: 'Assigned to me', description: 'An issue is assigned to you.' },
  input_requested: { label: 'Questions for me', description: 'Someone, or an agent, asks you a question on a workstream.' },
  decision_proposed: { label: 'Decisions to review', description: 'A decision is proposed on a workstream you are accountable for.' },
  review_requested: { label: 'Review requested', description: 'A pull request on a workstream you are accountable for needs a review.' },
  ci_failed: { label: 'Failing checks', description: 'CI fails on a workstream you are accountable for.' },
  comment: { label: 'Comments', description: 'New comments on issues you are assigned or reported, and on workstreams you are accountable for.' },
  workstream_update: { label: 'Workstream updates', description: 'A workstream you are accountable for ships, becomes blocked or is ready to land.' },
};

export type NotificationChannel = 'inApp' | 'email' | 'push';
export type NotificationChannels = Record<NotificationChannel, boolean>;
/**
 * Per kind and channel. Missing entries use the defaults (in-app on, email off, push on: a push only
 * reaches the devices where the person turned notifications on).
 */
export type NotificationSettings = Record<NotificationKind, NotificationChannels>;

export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannels = { inApp: true, email: false, push: true };

/** Fills the gaps of a stored (partial) settings object with the defaults. */
export function resolveNotificationSettings(raw?: Partial<Record<string, Partial<NotificationChannels>>> | null): NotificationSettings {
  const out = {} as NotificationSettings;
  for (const kind of NOTIFICATION_KINDS) out[kind] = { ...DEFAULT_NOTIFICATION_CHANNELS, ...(raw?.[kind] ?? {}) };
  return out;
}

/** A message for one person, created from something that happened in a workspace. */
export interface Notification {
  /** `ntf_…` */
  id: ID;
  workspaceId: ID;
  kind: NotificationKind;
  title: string;
  /** A short excerpt (a comment, a question), when there is one. */
  body?: string;
  /** Who caused it. */
  actor: ActorRef;
  /** The record it is about. */
  subject: SubjectRef;
  /** Where it leads, relative to the workspace, e.g. `issues/BUG-142`. */
  link: string;
  createdAt: ISODate;
  /** Absent while unread. */
  readAt?: ISODate;
}

/** Response of GET /w/:slug/notifications. */
export interface NotificationList {
  items: Notification[];
  /** Unread in this workspace, whatever the page size. */
  unread: number;
}

/** What a person can pin to their Favorites (per user and workspace, shown in the sidebar). */
export const FAVORITE_TYPES = ['issue', 'workstream', 'project', 'decision', 'team', 'repository', 'view'] as const;
export type FavoriteType = (typeof FAVORITE_TYPES)[number];
/** Most favorites one person can keep in a workspace. */
export const MAX_FAVORITES = 100;

/** A pinned entity. Private to its owner: other people never see it. */
export interface Favorite {
  /** `fav_…` */
  id: ID;
  workspaceId: ID;
  type: FavoriteType;
  /** Id (not key) of the issue, workstream, project, decision, team, repository or view. */
  subjectId: ID;
  createdAt: ISODate;
}

/** Days an invitation stays valid. Resending an invitation starts a new period. */
export const INVITE_TTL_DAYS = 7;

/**
 * A pending invitation to join a workspace, bound to one email address. The secret link is returned
 * only when the invitation is created or resent (`InviteLink`); the server stores just its hash.
 */
export interface WorkspaceInvite {
  /** `inv_…` */
  id: ID;
  workspaceId: ID;
  email: string;
  role: Role;
  invitedByUserId?: ID;
  createdAt: ISODate;
  expiresAt: ISODate;
  /** When an email was last sent (absent when the server has no mail configured). */
  emailedAt?: ISODate;
}

/** Response of creating or resending an invitation: share `url` if the email did not arrive. */
export interface InviteLink {
  invite: WorkspaceInvite;
  url: string;
  /** False when the server has no mail transport configured (SMTP_URL), so the link must be shared by hand. */
  emailed: boolean;
}

/** What anyone holding an invitation link may see before signing in. */
export interface InvitePreview {
  workspaceName: string;
  role: Role;
  email: string;
  invitedByName?: string;
  expiresAt: ISODate;
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

export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

export const GIT_PROVIDERS: GitProvider[] = ['github', 'gitlab', 'bitbucket'];

/**
 * What differs between git hosts. `host` is the public web host used to build repository URLs
 * (`https://<host>/<fullName>`); `selfHosted` is whether a connection may point at another instance
 * (GitHub Enterprise Server, self-hosted GitLab) via its base URL. To add a host: extend `GitProvider`,
 * add its entry here, implement a client in server/src/integrations/providers.ts and a webhook parser
 * in server/src/webhooks.
 */
export const GIT_PROVIDER_META: Record<GitProvider, { label: string; host: string; selfHosted: boolean }> = {
  github: { label: 'GitHub', host: 'github.com', selfHosted: true },
  gitlab: { label: 'GitLab', host: 'gitlab.com', selfHosted: true },
  bitbucket: { label: 'Bitbucket', host: 'bitbucket.org', selfHosted: false },
};

export interface Repository {
  id: ID;
  workspaceId: ID;
  provider: GitProvider;
  /** e.g. "acme/api" */
  fullName: string;
  url: string;
  defaultBranch: string;
  teamIds: ID[];
  /** Workspace label ids (`WorkspaceSettings.labels`). */
  labels: ID[];
  createdAt: ISODate;
}

// ───────────────────────────── Projects ─────────────────────────────

/** Linear-style project lifecycle. Planning-level: independent of workstream status. */
export type ProjectStatus = 'backlog' | 'planned' | 'in_progress' | 'paused' | 'completed' | 'canceled';
export const PROJECT_STATUSES: ProjectStatus[] = ['backlog', 'planned', 'in_progress', 'paused', 'completed', 'canceled'];

/**
 * A planned outcome (Linear-style): what we want to achieve, by when, in which repositories.
 * Workstreams are the execution of a project; milestones belong to the project.
 */
export interface Project {
  /** `pj_…` */
  id: ID;
  workspaceId: ID;
  name: string;
  /** One-line summary shown in lists. */
  summary?: string;
  /** Longer description (markdown). */
  description?: string;
  color: string;
  /** Lucide icon name (kebab-case, e.g. `rocket`) or a single emoji. Absent = the default project glyph. */
  icon?: string;
  status: ProjectStatus;
  /** Health from the latest project update; absent until the first update is posted. */
  health?: ProjectHealth;
  /** When the latest update was posted (drives "updated 3d ago" and update reminders). */
  lastUpdateAt?: ISODate;
  priority: Priority;
  leadId?: ID;
  /** Teams involved. */
  teamIds: ID[];
  /** Where the work happens. A workstream of this project picks its repositories from this list. */
  repositoryIds: ID[];
  /** Workspace label ids (`WorkspaceSettings.labels`). */
  labels: ID[];
  startDate?: ISODate;
  targetDate?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Set when the status becomes completed or canceled; cleared on reopen. */
  completedAt?: ISODate;
}

/** Linear-style project health, set by whoever posts a project update. */
export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track';
export const PROJECT_HEALTHS: ProjectHealth[] = ['on_track', 'at_risk', 'off_track'];

/**
 * A status post on a project (Linear "Project update"): a health value plus a markdown write-up, newest first
 * in the project's Updates feed. Discussed through comments (`SubjectRef` type `project_update`).
 * The newest update drives `Project.health` and `Project.lastUpdateAt`; deleting it falls back to the previous one.
 */
export interface ProjectUpdate {
  /** `pu_…` */
  id: ID;
  workspaceId: ID;
  projectId: ID;
  health: ProjectHealth;
  /** Markdown body. */
  body: string;
  author: ActorRef;
  /** True when the update was drafted by the AI assistant and posted from that draft (informational). */
  aiDrafted?: boolean;
  createdAt: ISODate;
  /** Set once the body or health was edited after posting. */
  editedAt?: ISODate;
}

/** An artifact reached from a project, with the chain that links it back to where it was attached. */
export interface ProjectContextArtifact {
  artifact: Artifact;
  /**
   * Chain from the project down to the artifact's owner, e.g. [project, workstream, issue] for a PR attached to
   * an issue that is part of a workstream of the project. A one-element chain means it is attached to the project itself.
   */
  path: SubjectRef[];
}

/**
 * GET /w/:slug/projects/:id/context — the whole tree under a project in one response ("mega context"):
 * Project → workstreams → issues → artifacts (+ the project's own artifacts, issues and updates).
 * Every item is reachable from the project and carries the ids needed to trace it back.
 */
export interface ProjectContext {
  project: Project;
  milestones: Milestone[];
  updates: ProjectUpdate[];
  workstreams: Workstream[];
  /** Issues with `projectId` = project OR linked to one of its workstreams. */
  issues: Issue[];
  artifacts: ProjectContextArtifact[];
  decisions: Decision[];
  inputRequests: InputRequest[];
}

// ── AI suggestions for a project (POST /w/:slug/projects/:id/ai/:kind) ──

export type ProjectAiKind = 'update_draft' | 'summary' | 'issues' | 'risks';
export const PROJECT_AI_KINDS: ProjectAiKind[] = ['update_draft', 'summary', 'issues', 'risks'];

export interface ProjectAiUpdateDraft {
  kind: 'update_draft';
  health: ProjectHealth;
  body: string;
}
export interface ProjectAiSummary {
  kind: 'summary';
  summary: string;
  description: string;
}
export interface ProjectAiIssueSuggestion {
  issueId: ID;
  reason: string;
}
export interface ProjectAiIssues {
  kind: 'issues';
  suggestions: ProjectAiIssueSuggestion[];
}
export interface ProjectAiRisk {
  title: string;
  detail: string;
  severity: AttentionSeverity;
  issueId?: ID;
  workstreamId?: ID;
}
export interface ProjectAiRisks {
  kind: 'risks';
  health: ProjectHealth;
  risks: ProjectAiRisk[];
}
export type ProjectAiResult = ProjectAiUpdateDraft | ProjectAiSummary | ProjectAiIssues | ProjectAiRisks;

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
  /** The project this workstream carries out (at most one). */
  projectId?: ID;
  /** Always a subset of the project's `repositoryIds` when `projectId` is set. */
  repositoryIds: ID[];
  acceptanceCriteria: AcceptanceCriterion[];
  priority: Priority;
  /** Workspace label ids (`WorkspaceSettings.labels`), not free text. */
  labels: ID[];
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

/** Linear-style milestone inside a project. An issue is in at most one milestone per project. */
export interface Milestone {
  /** `ms_…` */
  id: ID;
  workspaceId: ID;
  projectId: ID;
  name: string;
  description?: string;
  targetDate?: ISODate;
  /** Ascending order inside the project (reorder by PATCHing it). */
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
 * `backlog` is unscheduled demand; linking an issue into a workstream does not change its status; moving it to `in_progress` is a separate, intentional action.
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
  /**
   * Person responsible for this issue. Distinct from workstream accountability.
   * When a user moves an unassigned issue to `in_progress`, the server sets this to that user.
   */
  assigneeId?: ID;
  teamId?: ID;
  priority: Priority;
  status: IssueStatus;
  /** Workstreams this issue contributes to (many issues → one workstream, and the reverse). */
  workstreamIds: ID[];
  /** Project this issue is planned under. Independent of `workstreamIds`; deleting the project clears it. */
  projectId?: ID;
  /**
   * Milestones this issue is in: at most one per project, and only milestones of `projectId` or of the
   * projects of the workstreams in `workstreamIds`. Clearing `projectId` or unlinking the last
   * workstream of a project drops that project's milestone.
   */
  milestoneIds: ID[];
  /** Story-point estimate (non-negative). Scales live in src/app/core/estimates.ts. */
  estimate?: number;
  /** First time the status entered in_progress / in_review. Kept when moved back. */
  startedAt?: ISODate;
  /** Set when the status becomes done or canceled; cleared on reopen. */
  completedAt?: ISODate;
  /** Workspace label ids (`WorkspaceSettings.labels`). */
  labels: ID[];
  /** Previous keys (changing `kind` re-keys the issue); lookups by key also match these. */
  aliases: string[];
  /** Set when this issue duplicates another. Status is `canceled`. */
  duplicateOfId?: ID;
  externalUrl?: string;
  /**
   * Distinct customers linked to this issue. Set on issue reads and in the snapshot.
   * `0` when nobody is linked. Not stored on the issue row.
   */
  customerCount?: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

// ───────────────────────────── Customers ─────────────────────────────

/**
 * A company that asked for something, not a contact and not a CRM account.
 * `domain` is the identity inside the workspace: stored lower-case, without a scheme,
 * path, port or leading `www.`. Two customers cannot share one.
 */
export interface Customer {
  /** `cus_…` */
  id: ID;
  workspaceId: ID;
  name: string;
  domain: string;
  /** Who created the record. */
  createdBy: ActorRef;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Set when the customer is archived. The record and its links stay; issues are untouched. */
  archivedAt?: ISODate;
}

/**
 * One piece of feedback: a customer linked to an existing issue.
 * The pair is unique. Deleting the customer or the issue removes the link and nothing else.
 */
export interface CustomerRequest {
  /** `crq_…` */
  id: ID;
  workspaceId: ID;
  customerId: ID;
  issueId: ID;
  /** Optional note about what this customer asked for. */
  body?: string;
  createdBy: ActorRef;
  createdAt: ISODate;
}

const CUSTOMER_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * `https://WWW.Acme.com/pricing` → `acme.com`. `null` when it is not a domain
 * (empty, a single label, an IP, or anything with characters a hostname cannot have).
 */
export function normalizeCustomerDomain(input: string): string | null {
  let raw = input.trim().toLowerCase();
  if (!raw) return null;
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  raw = (raw.split(/[/?#]/)[0] ?? '').replace(/:\d+$/, '');
  if (raw.startsWith('www.')) raw = raw.slice(4);
  raw = raw.replace(/\.+$/, '');
  return CUSTOMER_DOMAIN.test(raw) ? raw : null;
}

// ───────────────────────────── Artifacts ─────────────────────────────

export type ArtifactKind =
  | 'pull_request'
  | 'merge_request'
  | 'document'
  | 'link'
  | 'design'
  | 'image'
  | 'file'
  | 'build'
  | 'test_report'
  | 'deployment'
  | 'release';

export type ArtifactProvider = 'github' | 'gitlab' | 'bitbucket' | 'delta' | 'figma' | 'docs' | 'ci' | 'other';

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

/**
 * Something the work produced or points to: a PR, a build, a document, a link.
 * Attached to at least one owner: a project, a workstream and/or an issue. A project sees the artifacts of
 * its own, of its workstreams and of the issues under it (see `ProjectContext`); an issue that belongs to a
 * workstream of a project makes its artifacts part of that project (a tree: project → workstream/issue → artifact).
 */
export interface Artifact {
  id: ID;
  /** Owner. At least one of `projectId` / `workstreamId` / `issueId` is always set. */
  workstreamId?: ID;
  projectId?: ID;
  issueId?: ID;
  repositoryId?: ID;
  /** Short note on what it is / why it is attached (markdown allowed). */
  description?: string;
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
  | 'customer'
  | 'customer_request'
  | 'artifact'
  | 'decision'
  | 'input_request'
  | 'repository'
  | 'team'
  | 'project'
  | 'project_update'
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

export type ViewEntity = 'workstream' | 'issue' | 'decision' | 'project';
/** `timeline` (Gantt) is a layout of a saved view, offered for workstream and project views. */
export type ViewLayout = 'list' | 'board' | 'graph' | 'timeline';

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
  /** Granted permissions; present only for `custom` tokens. */
  permissions?: ApiPermission[];
  /** Request / write budget (defaults apply when not customized). */
  limits: TokenLimits;
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
  /** Base URL for self-hosted GitLab / GitHub Enterprise (not used by Bitbucket Cloud). */
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

export type TokenScope = 'read' | 'write' | 'admin' | 'custom';
export const TOKEN_SCOPES: Record<TokenScope, { label: string; description: string }> = {
  read: { label: 'Read', description: 'Read-only: GET requests. Good for dashboards and reporting.' },
  write: { label: 'Write', description: 'Create and update work (workstreams, issues, comments…) with at most the member role. Cannot change workspace settings.' },
  admin: { label: 'Admin', description: 'Everything the acting user\'s role allows, including members, integrations and settings. Only admins can create one.' },
  custom: { label: 'Custom', description: 'Only the listed permissions (resource × action), always within the acting user\'s role.' },
};

/**
 * Fine-grained API permissions (`<resource>:<action>`), used by `custom` tokens. The required
 * permission of a request is derived from its route: `/w/:slug/<resource>/…` plus the HTTP method
 * (GET → read, POST/PUT/PATCH → write, DELETE → delete), with a few named exceptions
 * (`decisions:accept`). A route whose resource is not listed here is denied to custom tokens.
 */
export type ApiAction = 'read' | 'write' | 'delete' | 'accept';
export type ApiResource =
  | 'workspace' | 'projects' | 'workstreams' | 'issues' | 'customers' | 'decisions' | 'milestones' | 'comments' | 'artifacts'
  | 'dependencies' | 'input-requests' | 'views' | 'attention' | 'search' | 'graph' | 'events' | 'snapshot'
  | 'teams' | 'repositories' | 'members' | 'agents' | 'tokens' | 'integrations' | 'outgoing-webhooks';
export type ApiPermission = `${ApiResource}:${ApiAction}`;

export interface ApiResourceMeta {
  label: string;
  group: 'Work' | 'Insight' | 'Organization' | 'Access & automation';
  actions: readonly ApiAction[];
}

const RWD = ['read', 'write', 'delete'] as const;
export const API_RESOURCES: Record<ApiResource, ApiResourceMeta> = {
  projects: { label: 'Projects', group: 'Work', actions: RWD },
  workstreams: { label: 'Workstreams', group: 'Work', actions: RWD },
  issues: { label: 'Issues', group: 'Work', actions: RWD },
  customers: { label: 'Customers', group: 'Work', actions: RWD },
  decisions: { label: 'Decisions', group: 'Work', actions: [...RWD, 'accept'] },
  milestones: { label: 'Milestones', group: 'Work', actions: RWD },
  comments: { label: 'Comments', group: 'Work', actions: RWD },
  artifacts: { label: 'Artifacts', group: 'Work', actions: RWD },
  dependencies: { label: 'Dependencies', group: 'Work', actions: RWD },
  'input-requests': { label: 'Input requests', group: 'Work', actions: RWD },
  views: { label: 'Views', group: 'Work', actions: RWD },
  attention: { label: 'Attention', group: 'Work', actions: ['read', 'write'] },
  search: { label: 'Search', group: 'Insight', actions: ['read'] },
  graph: { label: 'Graph', group: 'Insight', actions: ['read'] },
  events: { label: 'Activity log', group: 'Insight', actions: ['read'] },
  snapshot: { label: 'Snapshot', group: 'Insight', actions: ['read'] },
  teams: { label: 'Teams', group: 'Organization', actions: RWD },
  repositories: { label: 'Repositories', group: 'Organization', actions: RWD },
  workspace: { label: 'Workspace & settings', group: 'Organization', actions: RWD },
  members: { label: 'Members', group: 'Access & automation', actions: RWD },
  agents: { label: 'Agents', group: 'Access & automation', actions: RWD },
  tokens: { label: 'API tokens', group: 'Access & automation', actions: RWD },
  integrations: { label: 'Integrations', group: 'Access & automation', actions: RWD },
  'outgoing-webhooks': { label: 'Outgoing webhooks', group: 'Access & automation', actions: RWD },
};

export const API_PERMISSIONS: readonly ApiPermission[] = (Object.keys(API_RESOURCES) as ApiResource[]).flatMap((r) =>
  API_RESOURCES[r].actions.map((a) => `${r}:${a}` as ApiPermission),
);

/** Every `*:read` permission. */
const READ_ALL = API_PERMISSIONS.filter((p) => p.endsWith(':read'));
const WORK: ApiResource[] = ['projects', 'workstreams', 'issues', 'customers', 'decisions', 'milestones', 'comments', 'artifacts', 'dependencies', 'input-requests', 'views', 'attention'];

/** Starting points offered in Settings; the final selection is always an explicit permission list. */
export const PERMISSION_PRESETS: Record<'read-only' | 'contributor' | 'everything', { label: string; description: string; permissions: readonly ApiPermission[] }> = {
  'read-only': { label: 'Read-only', description: 'Read every resource. Nothing can be changed.', permissions: READ_ALL },
  contributor: {
    label: 'Contributor',
    description: 'Read everything and create/update work items. No deletes, no members, tokens or integrations.',
    permissions: [...READ_ALL, ...WORK.filter((r) => r !== 'attention').map((r) => `${r}:write` as ApiPermission), 'attention:write'],
  },
  everything: { label: 'Everything', description: 'All permissions. The acting user\'s role still applies.', permissions: API_PERMISSIONS },
};

/** Request budget of an API token (enforced server-side; sessions are not limited). */
export interface TokenLimits {
  requestsPerMinute: number;
  writesPerMinute: number;
  writesPerDay: number;
}
export const DEFAULT_TOKEN_LIMITS: TokenLimits = { requestsPerMinute: 600, writesPerMinute: 60, writesPerDay: 2000 };
/** Upper bounds a token can be configured with. */
export const MAX_TOKEN_LIMITS: TokenLimits = { requestsPerMinute: 6000, writesPerMinute: 600, writesPerDay: 20000 };

/** Things the workspace owner can gate behind a minimum role (Settings → Roles & permissions). */
export type Capability =
  | 'manageProjects'
  | 'createWorkstreams'
  | 'deleteWorkstreams'
  | 'createIssues'
  | 'deleteIssues'
  | 'manageCustomers'
  | 'deleteCustomers'
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
  'manageProjects',
  'createWorkstreams',
  'deleteWorkstreams',
  'createIssues',
  'deleteIssues',
  'manageCustomers',
  'deleteCustomers',
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
  manageProjects: { group: 'Work', label: 'Manage projects', description: 'Create, edit and delete projects and their milestones.' },
  createWorkstreams: { group: 'Work', label: 'Create workstreams', description: 'Start a new workstream.' },
  deleteWorkstreams: { group: 'Work', label: 'Delete workstreams', description: 'Permanently delete a workstream with its input requests, artifacts and comments.' },
  createIssues: { group: 'Work', label: 'Create issues', description: 'File bugs, features, incidents and other issues.' },
  deleteIssues: { group: 'Work', label: 'Delete issues', description: 'Permanently delete an issue (prefer canceling it).' },
  manageCustomers: { group: 'Work', label: 'Manage customers', description: 'Create and edit customers, archive them, and link or unlink their feedback on issues.' },
  deleteCustomers: { group: 'Work', label: 'Delete customers', description: 'Permanently delete a customer. Linked issues are kept; the links are removed.' },
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
  manageProjects: 'member',
  createWorkstreams: 'member',
  deleteWorkstreams: 'member',
  createIssues: 'member',
  deleteIssues: 'member',
  manageCustomers: 'member',
  deleteCustomers: 'member',
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

/** A label defined once for the workspace and assigned by id. */
export interface WorkspaceLabel {
  id: ID;
  name: string;
  /** `#rrggbb`. */
  color: string;
  /** Templates are always present and cannot be renamed or removed. */
  template: boolean;
}

/** Always available. Ids are stable so existing assignments survive a settings rewrite. */
export const LABEL_TEMPLATES: readonly WorkspaceLabel[] = [
  { id: 'lb_bug', name: 'Bug', color: '#e11d48', template: true },
  { id: 'lb_feature', name: 'Feature', color: '#2563eb', template: true },
  { id: 'lb_improvement', name: 'Improvement', color: '#16a34a', template: true },
  { id: 'lb_documentation', name: 'Documentation', color: '#7c3aed', template: true },
];

/** Swatches offered when creating or recoloring a label. */
export const LABEL_SWATCHES = ['#e11d48', '#f97316', '#eab308', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#db2777', '#64748b'] as const;

export const LABEL_NAME_MAX = 40;
export const LABEL_ASSIGN_MAX = 20;
const LABEL_COLOR = /^#[0-9a-f]{6}$/;

/** Templates first, then stored custom labels. Template names cannot drift. */
export function resolveLabelCatalog(stored?: readonly WorkspaceLabel[] | null): WorkspaceLabel[] {
  const incoming = Array.isArray(stored) ? stored : [];
  const byId = new Map(incoming.filter((item) => item && typeof item.id === 'string').map((item) => [item.id, item]));
  const templates = LABEL_TEMPLATES.map((template) => {
    const saved = byId.get(template.id);
    const color = saved && LABEL_COLOR.test(saved.color) ? saved.color : template.color;
    return { id: template.id, name: template.name, color, template: true };
  });
  const templateIds = new Set(templates.map((label) => label.id));
  const custom: WorkspaceLabel[] = [];
  for (const item of incoming) {
    if (!item || item.template || templateIds.has(item.id) || custom.some((label) => label.id === item.id)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > LABEL_NAME_MAX || !LABEL_COLOR.test(item.color ?? '')) continue;
    custom.push({ id: item.id, name, color: item.color, template: false });
  }
  return [...templates, ...custom];
}

/** Unique catalog ids, in order. Throws when an id is not in the catalog or the list is too long. */
export function assignLabelIds(catalog: readonly WorkspaceLabel[], ids: readonly string[] | null | undefined): string[] {
  const known = new Set(catalog.map((label) => label.id));
  const out: string[] = [];
  for (const id of ids ?? []) {
    if (!known.has(id)) throw new Error(`Unknown label "${id}"`);
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > LABEL_ASSIGN_MAX) throw new Error(`A record can have at most ${LABEL_ASSIGN_MAX} labels`);
  return out;
}

/**
 * Turn free-text label lists into catalog ids.
 * A string that is already a catalog id is kept. A name that matches a label (case-insensitive) reuses it.
 * Anything else becomes a custom label. `groups` is rewritten in the same order.
 */
export function adoptFreeTextLabels(
  stored: readonly WorkspaceLabel[] | null | undefined,
  groups: readonly (readonly string[])[],
): { catalog: WorkspaceLabel[]; groups: string[][]; lookup: Map<string, string> } {
  let catalog = resolveLabelCatalog(stored);
  const byName = new Map(catalog.map((label) => [label.name.toLowerCase(), label.id]));
  const taken = new Set(catalog.map((label) => label.id));
  const lookup = new Map<string, string>();
  let colorAt = catalog.filter((label) => !label.template).length;
  const mapOne = (raw: string): string => {
    const name = raw.trim();
    if (!name) return '';
    const known = lookup.get(name) ?? (taken.has(name) ? name : byName.get(name.toLowerCase()));
    if (known) {
      lookup.set(name, known);
      return known;
    }
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'label';
    let id = `lb_${slug}`;
    for (let n = 2; taken.has(id); n++) id = `lb_${slug}${n}`;
    const color = LABEL_SWATCHES[colorAt % LABEL_SWATCHES.length];
    colorAt += 1;
    catalog = [...catalog, { id, name: name.slice(0, LABEL_NAME_MAX), color, template: false }];
    taken.add(id);
    byName.set(name.toLowerCase(), id);
    lookup.set(name, id);
    return id;
  };
  const rewritten = groups.map((group) => [...new Set(group.map(mapOne).filter(Boolean))]);
  return { catalog, lookup, groups: rewritten };
}

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
  /**
   * Whether workstreams are linked to a Delta thread. Recommended for teams working in Delta. When off,
   * the thread is hidden everywhere and no longer required to create a workstream.
   */
  deltaThreads: boolean;
  /** Template labels plus any custom labels. Assign these ids; do not invent names. */
  labels: WorkspaceLabel[];
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  permissions: DEFAULT_PERMISSIONS,
  estimateScale: 'fibonacci',
  weekStart: 'monday',
  timeZone: 'auto',
  deltaThreads: true,
  labels: LABEL_TEMPLATES.map((label) => ({ ...label })),
};

/** Fills the gaps of a stored (partial) settings object with the defaults. */
export function resolveWorkspaceSettings(raw?: Partial<Omit<WorkspaceSettings, 'permissions'>> & { permissions?: Partial<PermissionMap> } | null): WorkspaceSettings {
  const r = raw ?? {};
  return {
    ...DEFAULT_WORKSPACE_SETTINGS,
    ...r,
    permissions: { ...DEFAULT_PERMISSIONS, ...(r.permissions ?? {}) },
    labels: resolveLabelCatalog(r.labels),
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
  { entity: 'project', label: 'Projects', events: ['project.created', 'project.updated', 'project.status_changed', 'project.deleted'] },
  { entity: 'project_update', label: 'Project updates', events: ['project_update.created', 'project_update.updated', 'project_update.deleted'] },
  { entity: 'workstream', label: 'Workstreams', events: ['workstream.created', 'workstream.updated', 'workstream.status_changed', 'workstream.deleted'] },
  { entity: 'issue', label: 'Issues', events: ['issue.created', 'issue.updated', 'issue.status_changed', 'issue.linked', 'issue.deleted'] },
  { entity: 'customer', label: 'Customers', events: ['customer.created', 'customer.updated', 'customer.archived', 'customer.restored', 'customer.deleted', 'customer_request.linked', 'customer_request.unlinked'] },
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
  projects: Project[];
  workstreams: Workstream[];
  milestones: Milestone[];
  inputRequests: InputRequest[];
  issues: Issue[];
  /** Companies whose feedback is linked to issues. Includes archived customers. */
  customers: Customer[];
  /** Customer ↔ issue links. Deleting either side removes the row. */
  customerRequests: CustomerRequest[];
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
  entity: SubjectType | 'comment' | 'view' | 'dependency' | 'membership' | 'invite' | 'favorite' | 'notification' | 'agent' | 'integration' | 'workspace' | 'webhook';
  id: ID;
  /** X-Client-Id of the originating request, so a tab can ignore its own echoes. */
  clientId?: string;
  at: ISODate;
}
