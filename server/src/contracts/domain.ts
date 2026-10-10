// GENERATED — copied from contracts/domain.ts by scripts/sync-contracts.mjs. Do not edit.
/**
 * Trama domain contract — SINGLE SOURCE OF TRUTH for entity shapes shared by
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
  /**
   * The user who owns the workspace: its creator until ownership is transferred. Nobody else can remove
   * or demote them, and only they can remove or demote other owners. Absent on legacy rows.
   */
  primaryOwnerId?: ID;
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
  'customer_request',
  'customer_important',
  'customer_delivered',
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
  customer_request: { label: 'Customer requests', description: 'A request is added for a customer you follow.' },
  customer_important: { label: 'Important customer requests', description: 'A request of a customer you follow is flagged as important.' },
  customer_delivered: { label: 'Delivered to customers', description: 'The issue or project behind a request is done, for a customer you follow or a request you recorded.' },
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
export const FAVORITE_TYPES = ['issue', 'workstream', 'project', 'decision', 'team', 'repository', 'view', 'customer'] as const;
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
  /**
   * Distinct customers with a request on this project or on its issues. Set on project reads and in the snapshot;
   * `0` when nobody asked. Not stored on the project row.
   */
  customerCount?: number;
}

/** A project is delivered to the customers who asked for it once it is completed (canceled is not delivery). */
export function isProjectDelivered(status: string): boolean {
  return status === 'completed';
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
 * Outcome status, derived from artifacts / input requests / decisions / dependencies / criteria.
 * `shipped` means the outcome is achieved (criteria met, no blockers, nothing waiting on a person),
 * not merely that code landed: see {@link DeliveryState} for that.
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

/**
 * How far the code got, derived from artifacts only (highest evidence wins):
 * `deployed` (healthy deployment) > `released` (published release) > `merged` (every live PR
 * merged) > `in_review` (an open PR) > `none`. This is delivery evidence, not the outcome:
 * a merged PR never makes a workstream `shipped` unless its criteria are met and nothing
 * blocks it or waits on a person.
 */
export type DeliveryState = 'none' | 'in_review' | 'merged' | 'released' | 'deployed';

/**
 * Where a workstream's effective `status` comes from, so a `shipped` is never mistaken for proof:
 * - `derived`: computed from the facts (criteria, delivery, blockers, people);
 * - `override`: pinned by hand through `statusOverride`; the facts may say otherwise (`derivedStatus`);
 * - `legacy`: a historic `shipped` with no acceptance criteria, kept as it was when "no criteria never
 *   ships" was introduced (see `legacyShipped`).
 */
export type StatusSource = 'derived' | 'override' | 'legacy';

export type CriterionState = 'pending' | 'in_progress' | 'met';

/**
 * Why a workstream is not (yet) a finished outcome. Computed by the server; clients show it and
 * never re-derive it. `shipped` (derived) means no gaps.
 * - `no_criteria`: nothing defines "done" yet (add at least one acceptance criterion).
 * - `criteria_pending`: some criterion is not `met`.
 * - `blocked`: a failing/conflicting open PR or an unresolved dependency.
 * - `needs_input`: an open input request or a proposed decision waits on a person.
 * - `no_delivery`: no merged/released/deployed work and not every linked issue is done.
 */
export type CompletionGap = 'no_criteria' | 'criteria_pending' | 'blocked' | 'needs_input' | 'no_delivery';
export interface WorkstreamCompletion {
  /** True when the outcome is achieved by the facts (ignores any manual `statusOverride`). */
  achieved: boolean;
  gaps: CompletionGap[];
}
/** Proof attached to a criterion. Artifacts must belong to the same workstream. */
export interface CriterionEvidence {
  artifactIds: ID[];
  /** Short free-text verification (e.g. "checked manually on staging"). */
  note?: string;
}
export interface AcceptanceCriterion {
  id: ID;
  text: string;
  state: CriterionState;
  /**
   * Optional proof. Signalled, never required: a `met` criterion without evidence is shown as
   * "no proof", not rejected. Linking an artifact (a PR, say) never changes `state`.
   */
  evidence?: CriterionEvidence;
  /** Who set the criterion to `met` (user or agent). Set by the server, cleared when it leaves `met`. */
  verifiedBy?: ActorRef;
  verifiedAt?: ISODate;
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
  /**
   * Delivery state (PR / release / deployment evidence), separate from the outcome `status`.
   * Computed by the server; `status === 'shipped'` additionally requires the outcome gates.
   */
  delivery: DeliveryState;
  /** Whether the outcome is achieved and what is missing, computed from the facts (not from the override). */
  completion: WorkstreamCompletion;
  /**
   * Set once by a migration on workstreams that were already `shipped` with no acceptance criteria
   * when "no criteria never ships" was introduced. They keep shipping; everything else needs a criterion.
   */
  legacyShipped?: boolean;
  /** A manual pin. When set, `status` is this value and `derivedStatus` is what the facts say. */
  statusOverride?: WorkstreamStatus;
  /** Whether `status` is derived from the facts, pinned by hand, or a historic shipped (see {@link StatusSource}). Computed by the server. */
  statusSource: StatusSource;
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
export type IssueSource = 'manual' | 'github' | 'gitlab' | 'linear' | 'email' | 'api' | 'agent';

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
  /** The issue this one was imported from or is linked to in an external tracker (read-only mirror of its status). */
  externalRef?: ExternalRef;
  /**
   * Distinct customers linked to this issue. Set on issue reads and in the snapshot.
   * `0` when nobody is linked. Not stored on the issue row.
   */
  customerCount?: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** An issue is delivered to the customers who asked for it once it is done (canceled is not delivery). */
export function isIssueDelivered(status: string): boolean {
  return status === 'done';
}

// ───────────────────────────── Customers ─────────────────────────────

export type CustomerStatus = 'prospect' | 'active' | 'churned';
export const CUSTOMER_STATUSES: CustomerStatus[] = ['prospect', 'active', 'churned'];

/** A tier defined once for the workspace (settings) and assigned to customers by id. */
export interface CustomerTier {
  /** `ct_…` */
  id: ID;
  name: string;
  /** `#rrggbb`. */
  color: string;
}

export const CUSTOMER_TIER_NAME_MAX = 40;
export const CUSTOMER_TIERS_MAX = 20;
export const CUSTOMER_DOMAINS_MAX = 20;
export const CUSTOMER_REVENUE_MAX = 1_000_000_000_000;
export const CUSTOMER_SIZE_MAX = 10_000_000;
export const CUSTOMER_REQUEST_BODY_MAX = 20_000;
const TIER_COLOR = /^#[0-9a-f]{6}$/;

/** Stored tiers that are well-formed, unique by id and capped. Nothing is invented: a workspace starts with none. */
export function resolveCustomerTiers(stored?: readonly CustomerTier[] | null): CustomerTier[] {
  const out: CustomerTier[] = [];
  for (const item of Array.isArray(stored) ? stored : []) {
    if (!item || typeof item.id !== 'string' || out.some((t) => t.id === item.id)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > CUSTOMER_TIER_NAME_MAX || !TIER_COLOR.test(item.color ?? '')) continue;
    out.push({ id: item.id, name, color: item.color });
    if (out.length >= CUSTOMER_TIERS_MAX) break;
  }
  return out;
}

/**
 * A company that asked for something, not a contact and not a CRM account.
 * `domains` are its identity inside the workspace: each is stored lower-case, without a scheme,
 * path, port or leading `www.`, and no two customers share one. `domain` is the primary one (`domains[0]`).
 */
export interface Customer {
  /** `cus_…` */
  id: ID;
  workspaceId: ID;
  name: string;
  /** Primary domain, always `domains[0]`. */
  domain: string;
  /** Every domain of the company, primary first (1-20). */
  domains: string[];
  /** `http(s)` image URL shown as the company logo. */
  logoUrl?: string;
  /** Annual revenue as a whole number in the workspace's own currency (>= 0). */
  revenue?: number;
  /** Company size in people (>= 0). */
  size?: number;
  /** Workspace tier id (`WorkspaceSettings.customerTiers`). */
  tierId?: ID;
  status: CustomerStatus;
  /** Who created the record. */
  createdBy: ActorRef;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Set when the customer is archived. The record and its links stay; issues are untouched. */
  archivedAt?: ISODate;
}

/**
 * One customer request: what a customer asked for, attached to exactly one issue or one project.
 * A customer can have several requests on the same issue. Deleting the customer, the issue or the
 * project removes its requests and nothing else.
 */
export interface CustomerRequest {
  /** `crq_…` */
  id: ID;
  workspaceId: ID;
  customerId: ID;
  /** Set when the request lives on an issue. Exactly one of `issueId` / `projectId` is set. */
  issueId?: ID;
  /** Set when the request lives on a project. */
  projectId?: ID;
  /** What the customer asked for, in markdown. */
  body?: string;
  /** Flagged by the team as important. */
  important: boolean;
  /** Where the request came from (ticket, email thread, call notes): an http(s) URL. */
  sourceUrl?: string;
  /** Set when the request arrived through a customer-request source (Intercom, Zendesk, Front, Slack, email, generic webhook). */
  source?: IntakeProvider;
  /** The ticket / conversation / message id in the source system (with `source`). */
  externalId?: string;
  /** Who asked, as reported by the source. */
  requesterEmail?: string;
  requesterName?: string;
  /** Who recorded the request. */
  createdBy: ActorRef;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/**
 * A person following a customer (the bell on its page): they are told when a request is added, flagged as
 * important, or delivered. Private to the person; others never see it. Unique per person and customer.
 */
export interface CustomerSubscription {
  /** `csub_…` */
  id: ID;
  workspaceId: ID;
  customerId: ID;
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

/**
 * Normalizes a list of domains (see {@link normalizeCustomerDomain}), keeping the first occurrence of each
 * and the given order. `invalid` lists the inputs that are not domains; empty entries are skipped.
 */
export function normalizeCustomerDomains(inputs: readonly string[]): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const input of inputs) {
    if (!input.trim()) continue;
    const domain = normalizeCustomerDomain(input);
    if (!domain) invalid.push(input);
    else if (!domains.includes(domain)) domains.push(domain);
  }
  return { domains, invalid };
}

// ───────────────────────────── Customer intake ─────────────────────────────

/**
 * Where inbound customer requests come from. Each source of a workspace has its own webhook URL and secret.
 * `generic` is a signed JSON webhook, `email` takes a parsed inbound email (Postmark / SendGrid style JSON).
 */
export type IntakeProvider = 'intercom' | 'zendesk' | 'front' | 'slack' | 'email' | 'generic';
export const INTAKE_PROVIDERS: IntakeProvider[] = ['intercom', 'zendesk', 'front', 'slack', 'email', 'generic'];

export interface IntakeProviderMeta {
  label: string;
  /** Trama generates the secret (shown once). Otherwise the provider issues it and an admin pastes it. */
  generatesSecret: boolean;
  /** Where the secret comes from, for the setup instructions. */
  secretName: string;
}

export const INTAKE_PROVIDER_META: Record<IntakeProvider, IntakeProviderMeta> = {
  intercom: { label: 'Intercom', generatesSecret: false, secretName: 'the app client secret (Developer Hub → your app → Basic information)' },
  zendesk: { label: 'Zendesk', generatesSecret: false, secretName: 'the webhook signing secret (Admin Center → the webhook → Signing secret)' },
  front: { label: 'Front', generatesSecret: false, secretName: 'the application secret (Settings → Developers → your app → Basic information)' },
  slack: { label: 'Slack', generatesSecret: false, secretName: 'the signing secret (api.slack.com/apps → Basic Information)' },
  email: { label: 'Email forward', generatesSecret: true, secretName: 'the secret Trama generates' },
  generic: { label: 'Signed webhook', generatesSecret: true, secretName: 'the secret Trama generates' },
};

export const INTAKE_SOURCE_NAME_MAX = 80;
export const INTAKE_ITEM_STATUSES = ['pending', 'linked', 'dismissed'] as const;
export type IntakeItemStatus = (typeof INTAKE_ITEM_STATUSES)[number];

/**
 * An endpoint that turns a provider's tickets or messages into inbound customer requests.
 * The secret is never returned except once, when Trama generates it (create / rotate).
 */
export interface IntakeSource {
  /** `isrc_…` */
  id: ID;
  workspaceId: ID;
  provider: IntakeProvider;
  name: string;
  enabled: boolean;
  /** False until the provider's secret has been pasted in: deliveries are refused until then. */
  hasSecret: boolean;
  /** Create the customer from the sender's email domain when none matches. Free mail domains never do. */
  autoCreateCustomers: boolean;
  /** Requests are attached straight to this project; without one they wait in the triage inbox. */
  targetProjectId?: ID;
  /** Provider settings that are not secret (Zendesk: `subdomain`, used to build ticket links). */
  subdomain?: string;
  /** Where the provider should POST. */
  webhookUrl: string;
  lastReceivedAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** A request that came in through an {@link IntakeSource}; `pending` ones wait in the triage inbox. */
export interface IntakeItem {
  /** `cin_…` */
  id: ID;
  workspaceId: ID;
  sourceId: ID;
  provider: IntakeProvider;
  /** Ticket / conversation / message id in the source system. Unique per source: a second delivery is ignored. */
  externalId: string;
  externalUrl?: string;
  requesterEmail?: string;
  requesterName?: string;
  subject?: string;
  body: string;
  status: IntakeItemStatus;
  /** The customer matched (or created) from the sender's email domain. */
  customerId?: ID;
  /** Set once linked. */
  issueId?: ID;
  projectId?: ID;
  customerRequestId?: ID;
  receivedAt: ISODate;
  resolvedAt?: ISODate;
}

/**
 * How much customers want something: the requests on one issue or project (or, rolled up, on a whole
 * workstream), seen through the customers who made them. Derived, never stored.
 */
export interface Demand {
  /** Distinct customers who asked, in the order of their first request. */
  customerIds: ID[];
  customerCount: number;
  requestCount: number;
  /** Requests flagged important. */
  importantCount: number;
  /** Distinct tiers of those customers (customers without a tier add nothing). */
  tierIds: ID[];
  /** Annual revenue of the customers, each counted once. Customers without revenue add 0. */
  revenue: number;
  /** Size of the largest customer, 0 when unknown. */
  size: number;
}

export const NO_DEMAND: Demand = Object.freeze({
  customerIds: [] as ID[],
  customerCount: 0,
  requestCount: 0,
  importantCount: 0,
  tierIds: [] as ID[],
  revenue: 0,
  size: 0,
}) as Demand;

/** Demand made of requests (any mix of targets) and the customers behind them. Requests of unknown customers are ignored. */
export function demandOf(
  requests: readonly Pick<CustomerRequest, 'customerId' | 'important'>[],
  customers: ReadonlyMap<ID, Pick<Customer, 'tierId' | 'revenue' | 'size'>>,
): Demand {
  const customerIds: ID[] = [];
  let requestCount = 0;
  let importantCount = 0;
  for (const r of requests) {
    if (!customers.has(r.customerId)) continue;
    requestCount += 1;
    if (r.important) importantCount += 1;
    if (!customerIds.includes(r.customerId)) customerIds.push(r.customerId);
  }
  return finishDemand(customerIds, requestCount, importantCount, customers);
}

function finishDemand(
  customerIds: ID[],
  requestCount: number,
  importantCount: number,
  customers: ReadonlyMap<ID, Pick<Customer, 'tierId' | 'revenue' | 'size'>>,
): Demand {
  if (!customerIds.length) return NO_DEMAND;
  const tierIds: ID[] = [];
  let revenue = 0;
  let size = 0;
  for (const id of customerIds) {
    const c = customers.get(id);
    if (!c) continue;
    if (c.tierId && !tierIds.includes(c.tierId)) tierIds.push(c.tierId);
    revenue += c.revenue ?? 0;
    size = Math.max(size, c.size ?? 0);
  }
  return { customerIds, customerCount: customerIds.length, requestCount, importantCount, tierIds, revenue, size };
}

/** Demand per issue and per project id (their ids never collide). Targets nobody asked for are absent. */
export function buildDemandIndex(
  requests: readonly CustomerRequest[],
  customers: ReadonlyMap<ID, Pick<Customer, 'tierId' | 'revenue' | 'size'>>,
): Map<ID, Demand> {
  const byTarget = new Map<ID, CustomerRequest[]>();
  for (const r of requests) {
    const target = r.issueId ?? r.projectId;
    if (!target) continue;
    const list = byTarget.get(target);
    if (list) list.push(r);
    else byTarget.set(target, [r]);
  }
  const out = new Map<ID, Demand>();
  for (const [target, list] of byTarget) {
    const demand = demandOf(list, customers);
    if (demand.requestCount) out.set(target, demand);
  }
  return out;
}

/** Several demands as one: a customer who asked for two of the parts counts once, requests add up. */
export function mergeDemand(
  parts: readonly Demand[],
  customers: ReadonlyMap<ID, Pick<Customer, 'tierId' | 'revenue' | 'size'>>,
): Demand {
  const customerIds: ID[] = [];
  let requestCount = 0;
  let importantCount = 0;
  for (const part of parts) {
    requestCount += part.requestCount;
    importantCount += part.importantCount;
    for (const id of part.customerIds) if (!customerIds.includes(id)) customerIds.push(id);
  }
  return finishDemand(customerIds, requestCount, importantCount, customers);
}

/** A request is delivered once the issue or project it sits on is. */
export function isRequestDelivered(
  request: Pick<CustomerRequest, 'issueId' | 'projectId'>,
  issues: ReadonlyMap<ID, Pick<Issue, 'status'>>,
  projects: ReadonlyMap<ID, Pick<Project, 'status'>>,
): boolean {
  if (request.issueId) {
    const issue = issues.get(request.issueId);
    return !!issue && isIssueDelivered(issue.status);
  }
  const project = request.projectId ? projects.get(request.projectId) : undefined;
  return !!project && isProjectDelivered(project.status);
}

/** The URL when it is a plain `http(s)` URL of at most 2000 characters, otherwise `null`. Never `javascript:` or `data:`. */
export function normalizeHttpUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 2000) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? raw : null;
  } catch {
    return null;
  }
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
  /** Set on a `document` artifact that points to a Trama document (`Document.id`); its title follows the document. */
  documentId?: ID;
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

// ───────────────────────────── Documents ─────────────────────────────

/** Hard limits of a document (also enforced by the API). */
export const DOCUMENT_LIMITS = {
  titleMax: 200,
  /** Markdown characters. Also bounded by the 2 MB JSON body limit. */
  bodyMax: 150_000,
  /** Revisions kept per document; the oldest are dropped. */
  revisionsKept: 50,
  /** Edits by the same person within this window update the newest revision instead of adding one. */
  revisionWindowMs: 5 * 60 * 1000,
} as const;

/**
 * A page of markdown that lives in Trama (specs, plans, notes that are not in a repository). It belongs to the
 * workspace; it is linked to projects, workstreams and issues by `document` artifacts (`links`), so it shows up
 * in their Artifacts and there is no second "parent" to keep in sync. Edits are optimistic: every change names the
 * `version` it was based on and a stale write is refused with 409.
 */
export interface Document {
  id: ID;
  workspaceId: ID;
  title: string;
  /** Markdown source. Only returned by the single-document endpoints. */
  body: string;
  /** One emoji or a Lucide icon name. */
  icon?: string;
  /** Starts at 1 and grows by one on every change to the title, body or icon. */
  version: number;
  author: ActorRef;
  lastEditor: ActorRef;
  /** Set while the document is archived (hidden from lists, still readable and restorable). */
  archivedAt?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** The projects / workstreams / issues the document is attached to. Set on single reads. */
  links?: DocumentLink[];
}

/** One attachment of a document: the `document` artifact and its owner. */
export interface DocumentLink {
  artifactId: ID;
  projectId?: ID;
  workstreamId?: ID;
  issueId?: ID;
}

/** A document as listed: no body, but the start of it (and, for a search, the matching passage). */
export type DocumentSummary = Omit<Document, 'body'> & {
  excerpt: string;
  /** Search only: passage around the match with `<mark>` around the terms (HTML-escaped otherwise). */
  snippet?: string;
};

/** An earlier state of a document. The newest revision is the current state. */
export interface DocumentRevision {
  id: ID;
  documentId: ID;
  /** The document version this revision holds (the last one it covers when saves were merged). */
  version: number;
  title: string;
  /** Left out of lists. */
  body?: string;
  editor: ActorRef;
  createdAt: ISODate;
}

/** Body of a 409 on a stale write: the version in the database, so the client can merge or reload. */
export interface DocumentConflict {
  statusCode: 409;
  code: 'document_conflict';
  message: string;
  current: Document;
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

// ───────────────────────────── Plans (a convention, not a gate) ─────────────────────────────

/**
 * A workstream's implementation plan is a `document` artifact attached to it whose title starts with "Plan":
 * a Trama document (preferred; its `version` is the revision) or a link to a file in the repository (the
 * artifact's `externalId` is the commit sha). Nothing is stored on the workstream and nothing blocks work.
 */
export function isPlanArtifact(a: Pick<Artifact, 'kind' | 'title'>): boolean {
  return a.kind === 'document' && /^\s*plan\b/i.test(a.title);
}

/**
 * The approval of a plan is an ordinary decision with the workstream as origin whose title starts with "Plan"
 * (or that is tagged `plan`) and that cites the revision: "Plan for AUTH-42 approved at v3" (Trama document) or
 * "... approved at 3f2a9c1" (commit sha). The agent proposes it, a person accepts it; while it is `proposed`
 * the workstream is already `needs_input`.
 */
export function isPlanDecision(d: Pick<Decision, 'title' | 'tags'>): boolean {
  return /^\s*plan\b/i.test(d.title) || d.tags.some((t) => t.toLowerCase() === 'plan');
}

/** One plan of a workstream, with the revision a person approved (if any) and whether it moved on since. */
export interface WorkstreamPlan {
  artifactId: ID;
  title: string;
  /** Repository file or page the plan lives at (absent for a Trama document). */
  url?: string;
  /** Set when the plan is a Trama document. */
  documentId?: ID;
  /** Current revision: "v3" (Trama document version) or a commit sha; null when it cannot be told. */
  revision: string | null;
  /** The accepted approval decision that cites a revision of this plan; the latest one wins. */
  approved: { decisionKey: string; revision: string | null } | null;
  /** The plan is on a newer revision than the approved one: a new decision must be proposed. */
  changedSinceApproval: boolean;
  /** A plan decision of this plan that a person has not accepted yet. */
  proposedDecisionKey?: string;
}

/** The fields the plan lookup reads; database rows (nullable columns, `Date` times) fit too. */
type PlanArtifact = Pick<Artifact, 'id' | 'kind' | 'title'> & {
  url?: string | null;
  documentId?: string | null;
  externalId?: string | null;
};
type PlanDecision = Pick<Decision, 'key' | 'title' | 'statement' | 'tags' | 'status'> & {
  originWorkstreamId?: string | null;
  createdAt: ISODate | Date;
  decidedAt?: ISODate | Date | null;
};

const timeOf = (d: PlanDecision): number => new Date(d.decidedAt ?? d.createdAt).getTime();

/** Versions cited as "v3", "rev 3", "revision 3" or "version 3". */
function citedVersions(text: string): number[] {
  return [...text.matchAll(/\b(?:v|rev\.?\s?|revision\s|version\s)(\d+)\b/gi)].map((m) => Number(m[1]));
}

/** Commit shas cited in the text: 7 to 40 hex characters with at least one digit. */
function citedShas(text: string): string[] {
  return [...text.matchAll(/\b[0-9a-f]{7,40}\b/gi)].map((m) => m[0].toLowerCase()).filter((s) => /\d/.test(s));
}

const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/**
 * Finds the plans among a workstream's artifacts and matches the approval decisions to them. Pure, so the
 * server (briefing, `get_context`) and the app show the same facts. `documentVersions` holds the current
 * `version` of each Trama document plan; `decisions` may hold any decisions, only those that originate in
 * `workstreamId` count.
 */
export function resolveWorkstreamPlans(input: {
  workstreamId: ID;
  artifacts: readonly PlanArtifact[];
  decisions: readonly PlanDecision[];
  documentVersions: ReadonlyMap<ID, number>;
}): WorkstreamPlan[] {
  const plans = input.artifacts.filter(isPlanArtifact);
  const decisions = input.decisions
    .filter((d) => d.originWorkstreamId === input.workstreamId && isPlanDecision(d))
    .sort((a, b) => timeOf(b) - timeOf(a));
  return plans.map((a): WorkstreamPlan => {
    const docVersion = a.documentId ? input.documentVersions.get(a.documentId) : undefined;
    const sha = !a.documentId && a.externalId && /^[0-9a-f]{7,40}$/i.test(a.externalId) ? a.externalId.toLowerCase() : null;
    const revision = docVersion !== undefined ? `v${docVersion}` : sha;
    const title = a.title.trim().toLowerCase();
    /** With one plan every plan decision is about it; with several, the decision must name it or cite its sha. */
    const concerns = (d: PlanDecision) =>
      plans.length === 1 ||
      `${d.title} ${d.statement}`.toLowerCase().includes(title) ||
      (sha !== null && citedShas(`${d.title} ${d.statement}`).some((c) => sameSha(c, sha)));
    const mine = decisions.filter(concerns);
    const cited = (d: PlanDecision): string | null => {
      const text = `${d.title} ${d.statement}`;
      if (a.documentId) {
        const v = citedVersions(text)[0];
        return v === undefined ? null : `v${v}`;
      }
      return citedShas(text)[0] ?? null;
    };
    // A plan with no known revision (a repository link without a sha) is approved by any accepted decision.
    const accepted = mine.find((d) => d.status === 'accepted' && (revision === null || cited(d) !== null));
    const approvedRevision = accepted ? cited(accepted) : null;
    const changed =
      !!accepted &&
      approvedRevision !== null &&
      revision !== null &&
      (docVersion !== undefined ? docVersion > Number(approvedRevision.slice(1)) : !sameSha(approvedRevision, revision));
    const proposed = mine.find((d) => d.status === 'proposed');
    return {
      artifactId: a.id,
      title: a.title,
      ...(a.url ? { url: a.url } : {}),
      ...(a.documentId ? { documentId: a.documentId } : {}),
      revision,
      approved: accepted ? { decisionKey: accepted.key, revision: approvedRevision } : null,
      changedSinceApproval: changed,
      ...(proposed ? { proposedDecisionKey: proposed.key } : {}),
    };
  });
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
  | 'milestone'
  | 'import'
  | 'document';

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

/** Page size of GET /comments/page: `limit` defaults to `default` and may not exceed `max`. */
export const COMMENT_PAGE_SIZE = { default: 50, max: 100 } as const;

/**
 * GET /api/w/:slug/comments/page — one page of the comments of a single subject, newest first.
 * `nextCursor` is opaque; pass it back as `cursor` to get the next (older) page, `null` on the last page.
 */
export interface CommentPage {
  items: Comment[];
  nextCursor: string | null;
}

/**
 * Compact comment summary the slim snapshot carries instead of the comments themselves: how many comments
 * each author left on each subject. Enough for counts and "who contributed" without loading any body.
 */
export interface CommentIndexEntry {
  subject: SubjectRef;
  author: ActorRef;
  count: number;
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
  | 'proof_missing'
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

// ───────────────────────────── Insights ─────────────────────────────

/** Time windows offered by GET /insights, in days. */
export const INSIGHT_RANGES = [7, 30, 90] as const;
export type InsightRange = (typeof INSIGHT_RANGES)[number];

/**
 * A health signal: something that is going wrong right now. Every signal lists the items that
 * cause it, so a lead (or an agent) can act on them. Definitions live in {@link INSIGHT_SIGNALS}.
 */
export type InsightSignalId =
  | 'blocked_workstreams'
  | 'needs_input'
  | 'stale_workstreams'
  | 'stale_issues'
  | 'delivered_outcome_open'
  | 'shipped_without_proof'
  | 'overdue_milestones'
  | 'overdue_workstreams'
  | 'scope_creep'
  | 'prs_stuck_in_review'
  | 'ci_failing'
  | 'undecided_decisions'
  | 'customer_demand_waiting';

export interface InsightSignalMeta {
  label: string;
  /** What exactly is counted. Shown in the UI and returned to agents. */
  definition: string;
  /** Singular noun of an item, for "3 workstreams". */
  unit: string;
}

export const INSIGHT_SIGNALS: Record<InsightSignalId, InsightSignalMeta> = {
  blocked_workstreams: {
    label: 'Blocked workstreams',
    definition: 'Open workstreams whose status is Blocked, with the time since they entered it.',
    unit: 'workstream',
  },
  needs_input: {
    label: 'Waiting for input',
    definition: 'Open input requests, by how long they have waited and who has to answer.',
    unit: 'question',
  },
  stale_workstreams: {
    label: 'Stale workstreams',
    definition: 'In-flight workstreams (working, in review, blocked, needs input, ready to land) with no activity by a person or an agent for the stale threshold.',
    unit: 'workstream',
  },
  stale_issues: {
    label: 'Stale issues',
    definition: 'Issues In Progress or In Review that were not updated for the stale threshold.',
    unit: 'issue',
  },
  delivered_outcome_open: {
    label: 'Delivered, outcome open',
    definition: 'Workstreams whose code is merged, released or deployed but whose outcome is not shipped yet: criteria, issues, blockers or people are still open.',
    unit: 'workstream',
  },
  shipped_without_proof: {
    label: 'Shipped without proof',
    definition: 'Shipped workstreams that would not ship under today\'s rules: a historic shipped with no acceptance criteria, a criterion that is met without evidence, or a status pinned to Shipped while the facts say otherwise. Read-only: nothing changes status.',
    unit: 'workstream',
  },
  overdue_milestones: {
    label: 'Overdue milestones',
    definition: 'Milestones past their target date that still have open issues, in projects that are not completed or canceled.',
    unit: 'milestone',
  },
  overdue_workstreams: {
    label: 'Overdue workstreams',
    definition: 'Open workstreams past their target date.',
    unit: 'workstream',
  },
  scope_creep: {
    label: 'Scope creep',
    definition: 'Open workstreams that gained at least two issues after they started (first move out of Draft or Planned) inside the selected range.',
    unit: 'workstream',
  },
  prs_stuck_in_review: {
    label: 'PRs stuck in review',
    definition: 'Open, non-draft pull requests without an approval and without an update for 3 days or more.',
    unit: 'pull request',
  },
  ci_failing: {
    label: 'CI failing',
    definition: 'Open pull requests whose latest CI result is failing.',
    unit: 'pull request',
  },
  undecided_decisions: {
    label: 'Undecided decisions',
    definition: 'Decisions that are Proposed and still wait for a person to accept or reject them.',
    unit: 'decision',
  },
  customer_demand_waiting: {
    label: 'Customer demand waiting',
    definition: 'Issues and projects that customers asked for and that are still open, longest-waiting first.',
    unit: 'request target',
  },
};

export const INSIGHT_SIGNAL_IDS = Object.keys(INSIGHT_SIGNALS) as InsightSignalId[];

export type InsightItemType = 'workstream' | 'issue' | 'decision' | 'milestone' | 'artifact' | 'project';

/** One thing that causes a signal (or sits in a flow list). Enough to render a row and link to it. */
export interface InsightItem {
  type: InsightItemType;
  id: ID;
  /** Human key (AUTH-42, BUG-7, ADR-3) when the type has one. */
  key?: string;
  title: string;
  /** Workstream the item belongs to, so the UI can link to the right page. */
  workstreamKey?: string;
  /** Project of a milestone or project item. */
  projectId?: ID;
  /** When the condition started. */
  since?: ISODate;
  /** Days since `since` (rounded to one decimal). */
  ageDays?: number;
  /** Who has to act, when that is known. */
  waitingOn?: InsightActor;
  /** Metric-specific number (customers asking, issues added, ...), see `detail`. */
  value?: number;
  /** One sentence that says why the item is in the list. */
  detail: string;
}

export interface InsightActor {
  type: 'user' | 'agent' | 'unassigned';
  id?: ID;
  name: string;
}

export type InsightSeverity = 'ok' | 'info' | 'warning' | 'critical';

export interface InsightSignal {
  id: InsightSignalId;
  label: string;
  definition: string;
  unit: string;
  /** `ok` when nothing is wrong. */
  severity: InsightSeverity;
  /** All matching items (before the item limit). */
  count: number;
  /** Age in days of the oldest item. */
  oldestDays?: number;
  /** The worst items first, at most the requested `limit`. */
  items: InsightItem[];
  truncated: boolean;
}

/** Who is the bottleneck: open questions, decisions and reviews waiting on one actor. */
export interface InsightBottleneck {
  actor: InsightActor;
  inputRequests: number;
  decisions: number;
  reviews: number;
  oldestDays: number;
  /** Sum of waiting days over everything waiting on this actor. */
  totalWaitDays: number;
}

export interface DurationStats {
  count: number;
  p50?: number;
  p85?: number;
  p95?: number;
  mean?: number;
  max?: number;
}

export interface HistogramBucket {
  label: string;
  /** Inclusive lower bound, days. */
  from: number;
  /** Exclusive upper bound, days. Omitted on the last bucket. */
  to?: number;
  count: number;
}

export interface FlowDuration {
  stats: DurationStats;
  /** Same measure over the period before, for comparison. */
  previous?: DurationStats;
  histogram: HistogramBucket[];
  /** Slowest finished items in the range: what stretches the tail. */
  slowest: InsightItem[];
}

export interface ThroughputBucket {
  start: ISODate;
  end: ISODate;
  issuesDone: number;
  workstreamsShipped: number;
}

export interface InsightWipRow {
  actor: InsightActor;
  /** Issues In Progress or In Review assigned to the person (people only). */
  issues: number;
  /** Open workstreams: accountable (people) or touched in the last 7 days (agents). */
  workstreams: number;
  overloaded: boolean;
  items: InsightItem[];
}

export interface AgingItem extends InsightItem {
  status: IssueStatus;
  /** Days in progress. */
  inProgressDays: number;
  /** Older than the p85 cycle time of recent work. */
  overBaseline: boolean;
}

export interface CumulativeFlow {
  /** One ISO day per column, oldest first. */
  days: ISODate[];
  series: { status: IssueStatus; values: number[] }[];
}

export interface InsightFlow {
  issueCycle: FlowDuration;
  issueLead: FlowDuration;
  workstreamLead: FlowDuration;
  throughput: ThroughputBucket[];
  previousThroughput: { issuesDone: number; workstreamsShipped: number };
  wip: { people: InsightWipRow[]; agents: InsightWipRow[]; limits: { issues: number; workstreams: number } };
  aging: { baselineDays?: number; baselineSamples: number; items: AgingItem[] };
  cumulativeFlow?: CumulativeFlow;
}

export interface InsightContributor {
  actor: InsightActor;
  /** Events recorded by this actor in the range (everything they changed). */
  events: number;
  issuesDone: number;
  comments: number;
  pullRequests: number;
  decisionsProposed: number;
  inputRequestsRaised: number;
  lastActiveAt?: ISODate;
}

export interface AgentFailureRow {
  agent: InsightActor;
  inputRequestsRaised: number;
  inputRequestsOpen: number;
  /** Median hours from raising a question to the answer. */
  medianAnswerHours?: number;
  pullRequests: number;
  /** Closed without being merged. */
  pullRequestsAbandoned: number;
  pullRequestsCiFailing: number;
  /** Issues this agent moved to Done that someone moved out of Done again. */
  issuesReopened: number;
}

export interface InsightActors {
  people: InsightContributor[];
  agents: InsightContributor[];
  /** Share of recorded events: people vs agents. */
  share: { people: number; agents: number };
  failures: AgentFailureRow[];
}

export interface InsightsReport {
  generatedAt: ISODate;
  range: { days: number; from: ISODate; to: ISODate };
  scope: { teamId?: ID; projectId?: ID };
  staleDays: number;
  signals: InsightSignal[];
  bottlenecks: InsightBottleneck[];
  flow: InsightFlow;
  actors: InsightActors;
}

// ───────────────────────────── Views & tokens ─────────────────────────────

export type ViewEntity = 'workstream' | 'issue' | 'decision' | 'project';
/** `timeline` (Gantt) is a layout of a saved view, offered for workstream and project views. */
export type ViewLayout = 'list' | 'board' | 'graph' | 'timeline';

export interface ViewFilter {
  field: string;
  /** `gte` / `lte` compare numeric fields (customer demand such as request count or revenue). */
  op: 'is' | 'is_not' | 'in' | 'not_in' | 'contains' | 'before' | 'after' | 'gte' | 'lte';
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
  /**
   * Visible beyond the owner (`sharing.visibility` is `workspace` or `link`). Kept for older clients;
   * `sharing` is the source of truth.
   */
  shared: boolean;
  /** Who can see and edit this view. */
  sharing: SharingSettings;
  /**
   * Secret token of the public link (`/shared/<token>`). Only sent to people who can manage the
   * view's sharing, and only while `sharing.visibility` is `link`.
   */
  publicToken?: string;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/** Who may open a shareable object: only the invited, every workspace member, or anyone holding the link. */
export type ShareVisibility = 'private' | 'workspace' | 'link';
/** What an invited person may do. The owner always has full control. */
export type ShareLevel = 'view' | 'edit';

export interface ShareGrant {
  /** A member of the workspace. */
  userId: ID;
  level: ShareLevel;
}

/**
 * Generic permission settings for a shareable object (saved views today). `private` = owner and
 * `grants` only; `workspace` = every workspace member can view, `grants` may add edit rights;
 * `link` = like `workspace`, and anyone with the public link can read it (read-only, no login).
 */
export interface SharingSettings {
  visibility: ShareVisibility;
  grants: ShareGrant[];
}

/**
 * One row of a publicly shared view. A deliberately small projection: only what a list row shows,
 * never descriptions, bodies, emails, ids of other objects or anything the view does not display.
 */
export interface PublicViewItem {
  id: ID;
  key?: string;
  title: string;
  kind?: string;
  status?: string;
  priority?: Priority;
  health?: string;
  team?: string;
  assignee?: string;
  project?: string;
  labels?: string[];
  startDate?: ISODate;
  targetDate?: ISODate;
  updatedAt: ISODate;
}

export interface PublicViewGroup {
  /** Raw group value (`''` = no value). */
  key: string;
  /** Display name (resolved server-side for teams, people and projects). */
  label: string;
  items: PublicViewItem[];
}

/** `GET /api/public/views/:token`: the fixed result of a view shared by link. Read-only. */
export interface PublicView {
  name: string;
  entity: ViewEntity;
  layout: ViewLayout;
  groupBy?: string;
  workspaceName: string;
  groups: PublicViewGroup[];
  total: number;
  /** True when more rows matched than are returned. */
  truncated: boolean;
  generatedAt: ISODate;
}

/** API token (for agents, MCP clients, scripts). The secret is only returned once on creation. */
export interface ApiToken {
  id: ID;
  workspaceId: ID;
  name: string;
  /** First chars of the token for display, e.g. "trm_3f9a…". */
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
  | 'workspace' | 'projects' | 'workstreams' | 'issues' | 'customers' | 'decisions' | 'milestones' | 'comments' | 'artifacts' | 'documents'
  | 'dependencies' | 'input-requests' | 'views' | 'attention' | 'search' | 'graph' | 'events' | 'snapshot' | 'insights'
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
  documents: { label: 'Documents', group: 'Work', actions: RWD },
  dependencies: { label: 'Dependencies', group: 'Work', actions: RWD },
  'input-requests': { label: 'Input requests', group: 'Work', actions: RWD },
  views: { label: 'Views', group: 'Work', actions: RWD },
  attention: { label: 'Attention', group: 'Work', actions: ['read', 'write'] },
  search: { label: 'Search', group: 'Insight', actions: ['read'] },
  graph: { label: 'Graph', group: 'Insight', actions: ['read'] },
  events: { label: 'Activity log', group: 'Insight', actions: ['read'] },
  snapshot: { label: 'Snapshot', group: 'Insight', actions: ['read'] },
  insights: { label: 'Insights', group: 'Insight', actions: ['read'] },
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
const WORK: ApiResource[] = ['projects', 'workstreams', 'issues', 'customers', 'decisions', 'milestones', 'comments', 'artifacts', 'documents', 'dependencies', 'input-requests', 'views', 'attention'];

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
  /** Templates are always present and cannot be renamed, removed, merged away or archived. */
  template: boolean;
  /**
   * Archived labels stay on what already carries them but are no longer offered when assigning.
   * Only ever `true`; an active label omits the field.
   */
  archived?: boolean;
}

/** Always available. Ids are stable so existing assignments survive a settings rewrite. */
export const LABEL_TEMPLATES: readonly WorkspaceLabel[] = [
  { id: 'lb_bug', name: 'Bug', color: '#e11d48', template: true },
  { id: 'lb_feature', name: 'Feature', color: '#2563eb', template: true },
  { id: 'lb_improvement', name: 'Improvement', color: '#16a34a', template: true },
  { id: 'lb_documentation', name: 'Documentation', color: '#7c3aed', template: true },
];

/** Swatches offered when creating or recoloring a label. */
export const LABEL_SWATCHES = [
  '#e11d48',
  '#f97316',
  '#eab308',
  '#84cc16',
  '#16a34a',
  '#14b8a6',
  '#0891b2',
  '#2563eb',
  '#6366f1',
  '#7c3aed',
  '#db2777',
  '#64748b',
] as const;

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
    custom.push(item.archived === true ? { id: item.id, name, color: item.color, template: false, archived: true } : { id: item.id, name, color: item.color, template: false });
  }
  return [...templates, ...custom];
}

/**
 * The ids of one record after `from` is merged into `into` (or removed when `into` is null).
 * Keeps the order, never lists an id twice.
 */
export function replaceLabelId(ids: readonly string[], from: string, into: string | null): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const next = id === from ? into : id;
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
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
  /** Customer tiers configured for this workspace, in display order. Empty until an admin adds some. */
  customerTiers: CustomerTier[];
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  permissions: DEFAULT_PERMISSIONS,
  estimateScale: 'fibonacci',
  weekStart: 'monday',
  timeZone: 'auto',
  deltaThreads: true,
  labels: LABEL_TEMPLATES.map((label) => ({ ...label })),
  customerTiers: [],
};

/** Fills the gaps of a stored (partial) settings object with the defaults. */
export function resolveWorkspaceSettings(raw?: Partial<Omit<WorkspaceSettings, 'permissions'>> & { permissions?: Partial<PermissionMap> } | null): WorkspaceSettings {
  const r = raw ?? {};
  return {
    ...DEFAULT_WORKSPACE_SETTINGS,
    ...r,
    permissions: { ...DEFAULT_PERMISSIONS, ...(r.permissions ?? {}) },
    labels: resolveLabelCatalog(r.labels),
    customerTiers: resolveCustomerTiers(r.customerTiers),
  } as WorkspaceSettings;
}

const ROLE_ORDER: Role[] = ['viewer', 'member', 'admin', 'owner'];
/** True when `role` is at least `min`. */
export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(min);
}

// ───────────────────────────── Outgoing webhooks ─────────────────────────────

/**
 * A custom integration: Trama POSTs a signed JSON body to `url` for every domain event that matches `events`.
 * Body: `{ id, event, workspace, at, actor, subject, workstreamId?, data }`.
 * Headers: `X-Trama-Event`, `X-Trama-Delivery`, `X-Trama-Signature: sha256=<hex hmac of the raw body with the secret>`.
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
  { entity: 'customer', label: 'Customers', events: ['customer.created', 'customer.updated', 'customer.archived', 'customer.restored', 'customer.deleted', 'customer_request.linked', 'customer_request.updated', 'customer_request.unlinked'] },
  { entity: 'decision', label: 'Decisions', events: ['decision.draft', 'decision.proposed', 'decision.accepted', 'decision.rejected', 'decision.superseded', 'decision.updated', 'decision.deleted'] },
  { entity: 'input', label: 'Input requests', events: ['input.requested', 'input.answered', 'input.dismissed', 'input.updated', 'input.deleted'] },
  { entity: 'artifact', label: 'Artifacts', events: ['artifact.attached', 'artifact.updated', 'artifact.deleted'] },
  { entity: 'document', label: 'Documents', events: ['document.created', 'document.updated', 'document.archived', 'document.restored', 'document.deleted'] },
  { entity: 'comment', label: 'Comments', events: ['comment.created'] },
  { entity: 'dependency', label: 'Dependencies', events: ['dependency.added', 'dependency.removed'] },
  { entity: 'team', label: 'Teams', events: ['team.created', 'team.updated', 'team.deleted'] },
  { entity: 'repository', label: 'Repositories', events: ['repository.created', 'repository.updated', 'repository.deleted'] },
  { entity: 'import', label: 'Imports', events: ['import.started', 'import.completed', 'import.failed', 'import.canceled'] },
];

/** Does a webhook subscription pattern (`*`, `issue.*`, `issue.created`) match an event type? */
export function webhookEventMatches(patterns: readonly string[], type: string): boolean {
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}

// ───────────────────────────── Snapshot ─────────────────────────────

/**
 * `?comments=` on GET /snapshot. `full` (default, kept for MCP/CLI consumers) inlines every comment;
 * `index` returns `comments: []` plus `commentIndex`, and the client loads threads via GET /comments/page.
 */
export type SnapshotCommentsMode = 'full' | 'index';
export const SNAPSHOT_COMMENTS_MODES: readonly SnapshotCommentsMode[] = ['full', 'index'];

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
  /** Customer requests on issues and projects. Deleting the customer, issue or project removes the row. */
  customerRequests: CustomerRequest[];
  artifacts: Artifact[];
  decisions: Decision[];
  dependencies: Dependency[];
  /** Every comment in `full` mode (default); empty in `index` mode (see SnapshotCommentsMode). */
  comments: Comment[];
  /** Present only in `index` mode. */
  commentIndex?: CommentIndexEntry[];
  /** Most recent events (e.g. last 500); older ones via GET /events?before=. */
  events: DomainEvent[];
  attention: AttentionItem[];
  views: SavedView[];
  integrations: IntegrationConnection[];
}

/** Server-sent event on GET /api/w/:slug/events/stream. Clients refetch / patch on receipt. */
export interface LiveEvent {
  type: 'created' | 'updated' | 'deleted' | 'attention';
  entity: SubjectType | 'comment' | 'view' | 'dependency' | 'membership' | 'invite' | 'favorite' | 'customer_subscription' | 'notification' | 'agent' | 'integration' | 'workspace' | 'webhook';
  id: ID;
  /** X-Client-Id of the originating request, so a tab can ignore its own echoes. */
  clientId?: string;
  at: ISODate;
}

// ───────────────────────────── External trackers: import and link ─────────────────────────────

/** Trackers Trama can import from or link to. Trama stays usable next to them: nothing is written back. */
export type ExternalProvider = 'github' | 'linear';
export const EXTERNAL_PROVIDERS: ExternalProvider[] = ['github', 'linear'];
export const EXTERNAL_PROVIDER_META: Record<ExternalProvider, { label: string }> = {
  github: { label: 'GitHub Issues' },
  linear: { label: 'Linear' },
};

/** The external status, normalized so a badge can colour it without knowing the tracker. */
export type ExternalStateType = 'open' | 'in_progress' | 'done' | 'canceled';

/**
 * Pointer from a Trama issue to an issue in another tracker. Unique per workspace: one external issue
 * is one Trama issue, which is what makes an import idempotent. `state` and `syncedAt` are a read-only
 * mirror refreshed on demand; they never change the Trama status.
 */
export interface ExternalRef {
  provider: ExternalProvider;
  /** Stable id in the tracker: `owner/repo#12` (lower-case) for GitHub, the issue uuid for Linear. */
  id: string;
  url: string;
  /** What people call it: `#12` or `ENG-123`. */
  key?: string;
  /** The tracker's own state name (`open`, `In Progress`). */
  state?: string;
  stateType?: ExternalStateType;
  /** Last time `state` was read from the tracker. */
  syncedAt?: ISODate;
  /** `import` when Trama created the issue from it, `link` when a person attached it. */
  origin: 'import' | 'link';
}

export type ImportStatus = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export const IMPORT_STATUSES: ImportStatus[] = ['queued', 'running', 'completed', 'failed', 'canceled'];
export const IMPORT_ACTIVE_STATUSES: ImportStatus[] = ['queued', 'running'];
export type ImportPhase = 'setup' | 'issues' | 'comments' | 'done';

/** A tracker credential kept (encrypted) on the server so an import can resume and a link can refresh. Never returns the token. */
export interface ImportCredential {
  /** `tcr_…` */
  id: ID;
  workspaceId: ID;
  provider: ExternalProvider;
  /** The account the token belongs to (GitHub login, Linear user). */
  account: string;
  /** Self-hosted GitHub Enterprise only. */
  baseUrl?: string;
  createdAt: ISODate;
  lastUsedAt?: ISODate;
}

/** What to read. GitHub: one repository. Linear: one or more teams (empty = every team). */
export interface ImportSource {
  /** `owner/name` (GitHub). */
  repository?: string;
  /** Linear team ids. */
  teamIds?: string[];
}

export interface ImportCredentialRef {
  /** A saved tracker credential. */
  credentialId?: ID;
  /** A GitHub integration connection of the workspace (its token is reused). GitHub only. */
  connectionId?: ID;
}

export type ImportTarget = { action: 'map'; id: ID } | { action: 'create' } | { action: 'skip' };

/** The editable mapping from the tracker's entities to Trama's. Keys are the preview's ids. */
export interface ImportMapping {
  teams: Record<string, ImportTarget>;
  projects: Record<string, ImportTarget>;
  labels: Record<string, ImportTarget>;
  /** Tracker user id → Trama user id; `null` leaves the issue unassigned. */
  users: Record<string, ID | null>;
  /** Tracker state id → Trama status. */
  statuses: Record<string, IssueStatus>;
}

export interface ImportOptions {
  includeComments: boolean;
  /** Import closed / completed / canceled issues too. */
  includeClosed: boolean;
  /** Kind for issues no label points at (bug, security…). */
  defaultKind: IssueKind;
}
export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { includeComments: false, includeClosed: true, defaultKind: 'feature' };

export interface ImportPreviewEntity {
  id: string;
  name: string;
  key?: string;
  color?: string;
  /** Issues using it, when the tracker tells cheaply. */
  count?: number;
  suggested: ImportTarget;
}

export interface ImportPreviewUser {
  id: string;
  name?: string;
  login?: string;
  email?: string;
  /** Trama member matched by email, then by login or name. */
  suggestedUserId: ID | null;
}

export interface ImportPreviewStatus {
  id: string;
  name: string;
  /** The tracker's own category (`started`, `closed`, `not_planned`…). */
  type: string;
  count?: number;
  suggested: IssueStatus;
}

export interface ImportPreview {
  provider: ExternalProvider;
  account: string;
  /** `owner/name` or the Linear workspace. */
  sourceLabel: string;
  sourceUrl?: string;
  counts: {
    /** `null` when the tracker cannot count without reading everything. */
    issues: number | null;
    open: number | null;
    closed: number | null;
    projects: number;
    milestones: number;
    labels: number;
    users: number;
  };
  teams: ImportPreviewEntity[];
  projects: ImportPreviewEntity[];
  labels: ImportPreviewEntity[];
  milestones: { id: string; name: string; projectId?: string; dueOn?: string }[];
  users: ImportPreviewUser[];
  statuses: ImportPreviewStatus[];
  sample: { key: string; title: string; state: string }[];
  warnings: string[];
}

export interface ImportProgress {
  phase: ImportPhase;
  /** Issues the tracker says there are, when known. */
  total?: number;
  processed: number;
  created: number;
  /** Already imported earlier (their mirrored status is refreshed). */
  skipped: number;
  failed: number;
  comments: number;
}

export interface ImportErrorEntry {
  /** External key or id the failure belongs to. */
  ref: string;
  message: string;
}

export interface ImportJob {
  /** `imp_…` */
  id: ID;
  workspaceId: ID;
  provider: ExternalProvider;
  status: ImportStatus;
  /** Human label of what is imported (`acme/api`, `Linear: ENG, WEB`). */
  sourceLabel: string;
  source: ImportSource;
  options: ImportOptions;
  mapping: ImportMapping;
  progress: ImportProgress;
  /** First errors only (capped); `progress.failed` has the real count. */
  errors: ImportErrorEntry[];
  /** Set while the tracker's rate limit is being waited out. */
  waitingUntil?: ISODate;
  cancelRequested: boolean;
  lastError?: string;
  createdBy: ActorRef;
  createdAt: ISODate;
  startedAt?: ISODate;
  finishedAt?: ISODate;
}
