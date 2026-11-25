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

/**
 * Id of one workspace role: `owner`, a migrated `admin` / `member` / `viewer`, or a created `role_…`.
 * What it can do is that role's own set. There is no rank, and a higher role does not inherit a lower one.
 */
export type Role = string;

/** The four ranks a workspace had before roles were defined in settings. Migration only. */
export type LegacyRole = 'owner' | 'admin' | 'member' | 'viewer';
export const LEGACY_ROLES: readonly LegacyRole[] = ['owner', 'admin', 'member', 'viewer'];

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
  /**
   * The person's own workspace, created on sign-up. One per user. It can be renamed, but it cannot be left,
   * deleted or handed over. Absent (or false) on every other workspace.
   */
  personal?: boolean;
  createdAt: ISODate;
}

export interface Membership {
  id: ID;
  workspaceId: ID;
  userId: ID;
  role: Role;
  createdAt: ISODate;
  /**
   * Added on top of the role: extra actions, and an optional project limit.
   * Absent means the role as configured, on every project. Ignored for owners.
   */
  access?: MemberAccess | null;
}

/** What a person can be allowed to do, independently, inside the workspace role. */
export type MemberAction = 'view' | 'create' | 'update' | 'delete';

/** Work a person's access can see and change. Workspace administration stays with the role. */
/**
 * Work a membership grant names. Stays `issues` (not `tasks`): these strings are stored on roles.
 * Public HTTP and API-token permissions use `tasks` instead. See {@link ApiResource}.
 */
export type MemberResource =
  | 'projects'
  | 'milestones'
  | 'issues'
  | 'artifacts'
  | 'views'
  | 'comments';

export type MemberGrant = `${MemberResource}:${MemberAction}`;

export interface MemberProjectScope {
  /** Every project, including ones created later. */
  all: boolean;
  /** Used when `all` is false. */
  projectIds: ID[];
}

/**
 * What one person has beyond their role. `grants` are added to the role;
 * they never remove a permission the role already gives. Create, edit and delete imply view.
 * `projects` can still hide projects the role would otherwise see.
 */
export interface MemberAccess {
  projects: MemberProjectScope;
  /** When `projects.all` is false, work with no project stays visible only if this is true. */
  includeUnassigned: boolean;
  /** Actions added on top of the role. Permissions the role already has are not repeated. */
  grants: MemberGrant[];
}

/**
 * Granular work permissions of the four old ranks. `resolveWorkspaceSettings` copies these onto
 * workspace roles when a stored settings object has no `roles` yet.
 */
export type RoleGrantMap = Record<LegacyRole, MemberGrant[]>;

export interface MemberResourceMeta {
  label: string;
  description: string;
  group: 'Planning' | 'Work' | 'Collaboration';
  actions: readonly MemberAction[];
}

const MEMBER_ACTIONS = ['view', 'create', 'update', 'delete'] as const;

export const MEMBER_RESOURCES: Record<MemberResource, MemberResourceMeta> = {
  projects: {
    group: 'Planning',
    label: 'Projects',
    description: 'The planning container: name, status, dates, lead.',
    actions: MEMBER_ACTIONS,
  },
  milestones: {
    group: 'Planning',
    label: 'Milestones',
    description: 'Targets inside a project.',
    actions: MEMBER_ACTIONS,
  },
  issues: {
    group: 'Work',
    label: 'Issues',
    description: 'File an issue without being able to edit or delete it, or the other way around.',
    actions: MEMBER_ACTIONS,
  },
  artifacts: {
    group: 'Work',
    label: 'Artifacts',
    description: 'Pull requests, builds and other proof attached to work.',
    actions: MEMBER_ACTIONS,
  },
  views: {
    group: 'Work',
    label: 'Views',
    description:
      'Saved filters. Sharing a view with the workspace still follows Roles & permissions.',
    actions: MEMBER_ACTIONS,
  },
  comments: {
    group: 'Collaboration',
    label: 'Comments',
    description: 'Read a thread, write in it, or edit and delete comments.',
    actions: MEMBER_ACTIONS,
  },
};

export const MEMBER_RESOURCE_ORDER: readonly MemberResource[] = [
  'projects',
  'milestones',
  'issues',
  'artifacts',
  'views',
  'comments',
];

export const MEMBER_ACTION_META: readonly { id: MemberAction; label: string }[] = [
  { id: 'view', label: 'View' },
  { id: 'create', label: 'Create' },
  { id: 'update', label: 'Edit' },
  { id: 'delete', label: 'Delete' },
];

export const MEMBER_GRANTS: readonly MemberGrant[] = MEMBER_RESOURCE_ORDER.flatMap((resource) =>
  MEMBER_RESOURCES[resource].actions.map((action) => `${resource}:${action}` as MemberGrant),
);

const MEMBER_GRANT_SET = new Set<string>(MEMBER_GRANTS);
const MEMBER_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Default work permissions of an old rank. Viewer is view-only; the others can do all four actions. */
export function roleGrants(role: LegacyRole): MemberGrant[] {
  if (role === 'viewer') return MEMBER_GRANTS.filter((grant) => grant.endsWith(':view'));
  return [...MEMBER_GRANTS];
}

export function defaultRoleGrantMap(): RoleGrantMap {
  return {
    owner: roleGrants('owner'),
    admin: roleGrants('admin'),
    member: roleGrants('member'),
    viewer: roleGrants('viewer'),
  };
}

/** Keeps known grants, in catalog order, and makes every other action imply view. */
export function normalizeGrantList(input: readonly unknown[]): MemberGrant[] {
  const chosen = new Set<MemberGrant>();
  for (const grant of input) {
    if (typeof grant === 'string' && MEMBER_GRANT_SET.has(grant)) chosen.add(grant as MemberGrant);
  }
  for (const grant of [...chosen]) chosen.add(`${grant.split(':')[0]}:view` as MemberGrant);
  return MEMBER_GRANTS.filter((grant) => chosen.has(grant));
}

/** Fills missing ranks with the defaults. Stored lists replace a rank entirely. */
export function resolveRoleGrants(raw?: Partial<Record<LegacyRole, readonly unknown[]>> | null): RoleGrantMap {
  const defaults = defaultRoleGrantMap();
  const out: RoleGrantMap = { ...defaults };
  if (!raw) return out;
  for (const role of LEGACY_ROLES) {
    const listed = raw[role];
    if (Array.isArray(listed)) out[role] = normalizeGrantList(listed);
  }
  return out;
}

/** No extras and every project: the person is exactly their role. */
export function emptyMemberAccess(): MemberAccess {
  return { projects: { all: true, projectIds: [] }, includeUnassigned: true, grants: [] };
}

/**
 * `grants` on `input` are extras on top of `baseline` (the role). Grants the role already has are dropped.
 * Returns null when nothing is added and every project stays visible.
 */
export function normalizeMemberAccess(
  input: unknown,
  baseline: readonly MemberGrant[] = [],
): MemberAccess | null {
  if (input == null || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const scope = raw['projects'];
  let all = true;
  let projectIds: ID[] = [];
  if (scope && typeof scope === 'object') {
    const projects = scope as Record<string, unknown>;
    all = projects['all'] !== false;
    const listedIds = projects['projectIds'];
    if (!all && Array.isArray(listedIds)) {
      projectIds = [
        ...new Set(
          listedIds.filter((id): id is string => typeof id === 'string' && MEMBER_ID.test(id)),
        ),
      ];
    }
  }
  const includeUnassigned = all || raw['includeUnassigned'] !== false;
  const base = new Set(baseline);
  const rawGrants = raw['grants'];
  const chosen = new Set<MemberGrant>();
  if (Array.isArray(rawGrants)) {
    for (const grant of rawGrants) {
      if (
        typeof grant === 'string' &&
        MEMBER_GRANT_SET.has(grant) &&
        !base.has(grant as MemberGrant)
      )
        chosen.add(grant as MemberGrant);
    }
  }
  for (const grant of [...chosen]) {
    const view = `${grant.split(':')[0]}:view` as MemberGrant;
    if (!base.has(view)) chosen.add(view);
  }
  const grants = MEMBER_GRANTS.filter((grant) => chosen.has(grant));
  if (all && includeUnassigned && grants.length === 0) return null;
  return { projects: { all, projectIds: all ? [] : projectIds }, includeUnassigned, grants };
}

/**
 * Role grants plus this person's extras. Null for the owner role (always full), and when the result
 * is every action on every project. Unknown role: nothing.
 */
export function effectiveMemberAccess(
  role: { owner: boolean; grants: readonly MemberGrant[] } | null | undefined,
  stored: MemberAccess | null | undefined,
): MemberAccess | null {
  if (!role) return { projects: { all: false, projectIds: [] }, includeUnassigned: false, grants: [] };
  if (role.owner) return null;
  const base = new Set(role.grants);
  for (const grant of stored?.grants ?? []) base.add(grant);
  const grants = MEMBER_GRANTS.filter((grant) => base.has(grant));
  const projects = stored?.projects ?? { all: true, projectIds: [] };
  const includeUnassigned = projects.all || (stored?.includeUnassigned ?? true);
  if (projects.all && includeUnassigned && grants.length === MEMBER_GRANTS.length) return null;
  return {
    projects: projects.all
      ? { all: true, projectIds: [] }
      : { all: false, projectIds: projects.projectIds },
    includeUnassigned,
    grants,
  };
}

/**
 * `requested` null means the role itself, on every project. `caller` null means the caller is not limited.
 * A limited caller can only invite someone whose role, extras and projects are inside what they already have.
 */
export function accessWithin(
  requested: MemberAccess | null,
  caller: MemberAccess | null,
  baseline: readonly MemberGrant[] = [],
): boolean {
  if (!caller) return true;
  const grants = new Set<MemberGrant>([...baseline, ...(requested?.grants ?? [])]);
  if (![...grants].every((grant) => caller.grants.includes(grant))) return false;
  const projects = requested?.projects ?? { all: true, projectIds: [] };
  if (projects.all) return caller.projects.all;
  if (!caller.projects.all) {
    const includeUnassigned = requested?.includeUnassigned ?? true;
    if (includeUnassigned && !caller.includeUnassigned) return false;
    if (projects.projectIds.some((id) => !caller.projects.projectIds.includes(id))) return false;
  }
  return true;
}

// ───────────────────────────── Notifications ─────────────────────────────

/** Why a notification was sent. Each kind can be switched on or off per person and channel. */
export const NOTIFICATION_KINDS = [
  'assigned',
  'review_requested',
  'ci_failed',
  'comment',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
/** Stored notifications from the retired Workstream updater remain readable as legacy inbox rows. */
export type NotificationRecordKind = NotificationKind | 'workstream_update';

export const NOTIFICATION_KIND_META: Record<
  NotificationKind,
  { label: string; description: string }
> = {
  assigned: { label: 'Assigned to me', description: 'An issue is assigned to you.' },
  review_requested: {
    label: 'Review requested',
    description: 'A pull request attached to your issue needs a review.',
  },
  ci_failed: {
    label: 'Failing checks',
    description: 'CI fails on an artifact attached to your issue.',
  },
  comment: {
    label: 'Comments',
    description:
      'New comments on issues you are assigned or reported.',
  },
};

export type NotificationChannel = 'inApp' | 'email' | 'push';
export type NotificationChannels = Record<NotificationChannel, boolean>;
/**
 * Per kind and channel. Missing entries use the defaults (in-app on, email off, push on: a push only
 * reaches the devices where the person turned notifications on).
 */
export type NotificationSettings = Record<NotificationKind, NotificationChannels>;

export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannels = {
  inApp: true,
  email: false,
  push: true,
};

/** Fills the gaps of a stored (partial) settings object with the defaults. */
export function resolveNotificationSettings(
  raw?: Partial<Record<string, Partial<NotificationChannels>>> | null,
): NotificationSettings {
  const out = {} as NotificationSettings;
  for (const kind of NOTIFICATION_KINDS)
    out[kind] = { ...DEFAULT_NOTIFICATION_CHANNELS, ...(raw?.[kind] ?? {}) };
  return out;
}

/** A message for one person, created from something that happened in a workspace. */
export interface Notification {
  /** `ntf_…` */
  id: ID;
  workspaceId: ID;
  kind: NotificationRecordKind;
  title: string;
  /** A short excerpt (a comment, a question), when there is one. */
  body?: string;
  /** Who caused it. */
  actor: ActorRef;
  /** The record it is about. */
  subject: LegacySubjectRef;
  /** Where it leads, relative to the workspace, e.g. `issues/AUTH-142`. */
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
export const FAVORITE_TYPES = ['issue', 'project', 'view'] as const;
export type FavoriteType = (typeof FAVORITE_TYPES)[number];
/** Most favorites one person can keep in a workspace. */
export const MAX_FAVORITES = 100;

/** A pinned entity. Private to its owner: other people never see it. */
export interface Favorite {
  /** `fav_…` */
  id: ID;
  workspaceId: ID;
  type: FavoriteType;
  /** Id (not key) of the issue, project, or view. */
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
  /** Same shape as a membership. Absent means the role applies in full once they join. */
  access?: MemberAccess | null;
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
  /** Display name of `role`. */
  roleName: string;
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

export type ActorType = 'user' | 'agent' | 'system';
export interface ActorRef {
  type: ActorType;
  /** omitted for `system` */
  id?: ID;
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
export const GIT_PROVIDER_META: Record<
  GitProvider,
  { label: string; host: string; selfHosted: boolean }
> = {
  github: { label: 'GitHub', host: 'github.com', selfHosted: true },
  gitlab: { label: 'GitLab', host: 'gitlab.com', selfHosted: true },
  bitbucket: { label: 'Bitbucket', host: 'bitbucket.org', selfHosted: false },
};

/** Longest `Project.repository` / artifact repository string, in characters. */
export const PROJECT_REPOSITORY_MAX = 2048;

// ───────────────────────────── External identities ─────────────────────────────

/** Tools where a person has a login that is not their Trama account. */
export type ExternalIdentityProvider = GitProvider | 'linear' | 'jira';
export const EXTERNAL_IDENTITY_PROVIDERS: ExternalIdentityProvider[] = [
  'github',
  'gitlab',
  'bitbucket',
  'linear',
  'jira',
];
/** `host` is used when none is given; Jira sites differ per company, so it has no default. */
export const EXTERNAL_IDENTITY_PROVIDER_META: Record<
  ExternalIdentityProvider,
  { label: string; defaultHost?: string }
> = {
  github: { label: 'GitHub', defaultHost: 'github.com' },
  gitlab: { label: 'GitLab', defaultHost: 'gitlab.com' },
  bitbucket: { label: 'Bitbucket', defaultHost: 'bitbucket.org' },
  linear: { label: 'Linear', defaultHost: 'linear.app' },
  jira: { label: 'Jira' },
};

/** `connection`: filled in from a personal connection. `manual`: typed in by the person. */
export type ExternalIdentitySource = 'connection' | 'manual';
export const EXTERNAL_IDENTITY_SOURCES: ExternalIdentitySource[] = ['connection', 'manual'];

/** How many external identities one account can hold. */
export const EXTERNAL_IDENTITIES_MAX = 20;
export const EXTERNAL_IDENTITY_LOGIN_MAX = 100;

/**
 * A login a person has in another tool (`github.com` / `alessandro-b`). With several accounts per
 * provider, every one of them counts as the same person for assignees, review requests and mentions.
 * A (provider, host, login) triple belongs to at most one account (compared case-insensitively).
 */
export interface ExternalIdentity {
  id: ID;
  userId: ID;
  provider: ExternalIdentityProvider;
  /** Lower-case host without scheme or path, e.g. `github.com` or `git.acme.dev`. */
  host: string;
  /** The login as the tool spells it. Compared case-insensitively. */
  login: string;
  source: ExternalIdentitySource;
  createdAt: ISODate;
}

export interface ExternalIdentityInput {
  provider: ExternalIdentityProvider;
  /** Defaults to the provider's public host. Required for Jira. */
  host?: string;
  login: string;
}

/** `https://GitHub.com/` → `github.com`; `null` when it is not a plain host (optionally with a port). */
export function normalizeIdentityHost(raw: string): string | null {
  let host = raw.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split(/[/?#]/)[0]?.replace(/\.$/, '') ?? '';
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/.test(host) ? host : null;
}

/** Drops a leading `@` and surrounding spaces; `null` when nothing usable is left. */
export function normalizeIdentityLogin(raw: string): string | null {
  const login = raw.trim().replace(/^@/, '');
  return login.length > 0 &&
    login.length <= EXTERNAL_IDENTITY_LOGIN_MAX &&
    /^[^\s/\\]+$/.test(login)
    ? login
    : null;
}

// ───────────────────────────── Projects ─────────────────────────────

/** Linear-style project lifecycle. Planning-level and independent of Issue status. */
export type ProjectStatus =
  'backlog' | 'planned' | 'in_progress' | 'paused' | 'completed' | 'canceled';
export const PROJECT_STATUSES: ProjectStatus[] = [
  'backlog',
  'planned',
  'in_progress',
  'paused',
  'completed',
  'canceled',
];

/**
 * A planned outcome (Linear-style): what we want to achieve and by when.
 * Issues and milestones belong directly to the project. At most one git repository, as a string.
 */
export interface Project {
  /** `pj_…` */
  id: ID;
  workspaceId: ID;
  name: string;
  /** Uppercase project tag used as the prefix for issue keys, e.g. `CORA-12`. */
  key: string;
  /** One-line summary shown in lists. */
  summary?: string;
  /** Longer description (markdown). */
  description?: string;
  color: string;
  /** Lucide icon name (kebab-case, e.g. `rocket`) or a single emoji. Absent = the default project glyph. */
  icon?: string;
  status: ProjectStatus;
  /**
   * Health, set by hand (project create / PATCH; `null` in PATCH clears it). Absent until set.
   * Stored as a project health catalog id (the seeded ids equal the {@link ProjectHealth} types).
   */
  health?: ProjectHealth;
  priority: Priority;
  leadId?: ID;
  /**
   * One git repository: a URL or `owner/name`. Omitted when unset.
   * `null` only in PATCH, where it clears the field. At most {@link PROJECT_REPOSITORY_MAX} characters.
   * Not a repository row id — there is no repository registry.
   */
  repository?: string | null;
  /** Workspace label ids (`WorkspaceSettings.labels`). */
  labels: ID[];
  startDate?: ISODate;
  targetDate?: ISODate;
  createdAt: ISODate;
  updatedAt: ISODate;
  /** Set when the status becomes completed or canceled; cleared on reopen. */
  completedAt?: ISODate;
}

/** Linear-style project health: set by hand on a project, and also what the AI risk assessment reports. */
export type ProjectHealth = 'on_track' | 'at_risk' | 'off_track';
export const PROJECT_HEALTHS: ProjectHealth[] = ['on_track', 'at_risk', 'off_track'];

// ───────────────────────────── Shared projects, placements and transfer ─────────────────────────────

/**
 * Where one person chose to show a project that was shared with them. Per user, nothing is stored on the
 * project, and it gives nobody any access: opening the project still goes through its own workspace.
 * `workspaceId` null means "hidden from Shared with me".
 */
export interface ProjectPlacement {
  projectId: ID;
  workspaceId: ID | null;
  position: number;
}

/** A project the caller reaches through a limited (guest) membership in a workspace that is not theirs. */
export interface SharedProject {
  id: ID;
  name: string;
  key: string;
  color: string;
  icon?: string;
  /** The workspace that owns the project. Open it at `/<workspace.slug>/projects/<id>`. */
  workspace: { id: ID; slug: string; name: string };
  /** The caller's role in that workspace. */
  role: Role;
  /** Absent: shown under Shared with me. */
  placement?: ProjectPlacement;
}

/** What a project transfer will do to one status or label. */
export interface ProjectTransferMapping {
  /** `issue`, `project` or `project_health` for statuses; `label` for labels. */
  kind: StatusSubject | 'label';
  from: string;
  /** Name in the target workspace. */
  to: string;
  /** `create` only for labels the target does not have yet. */
  action: 'map' | 'create';
  /** Records that carry it. */
  count: number;
}

export interface ProjectTransferGuest {
  userId: ID;
  name: string;
  email: string;
  /** `add`: new guest in the target. `extend`: already a limited member there. `keep`: already has full access. */
  action: 'add' | 'extend' | 'keep';
  /** Role they get in the target. */
  role: Role;
}

export interface ProjectTransferPreview {
  project: { id: ID; name: string; key: string };
  source: { id: ID; slug: string; name: string };
  target: { id: ID; slug: string; name: string };
  counts: { issues: number; milestones: number; timeEntries: number };
  mappings: ProjectTransferMapping[];
  guests: ProjectTransferGuest[];
  /** Records whose assignee, lead or reporter is not a member of the target: they lose that person. */
  unassigned: number;
  /** Anything in here blocks the transfer (for example a project tag that is already used). */
  blockers: string[];
}

export interface ProjectTransferResult {
  project: Project;
  target: { id: ID; slug: string; name: string };
  counts: { issues: number; milestones: number; timeEntries: number };
  unassigned: number;
}

// ── AI suggestions for a project (POST /w/:slug/projects/:id/ai/:kind) ──

export type ProjectAiKind = 'summary' | 'issues' | 'risks';
export const PROJECT_AI_KINDS: ProjectAiKind[] = ['summary', 'issues', 'risks'];

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
}
export interface ProjectAiRisks {
  kind: 'risks';
  health: ProjectHealth;
  risks: ProjectAiRisk[];
}
export type ProjectAiResult = ProjectAiSummary | ProjectAiIssues | ProjectAiRisks;

export type Priority = 'none' | 'urgent' | 'high' | 'medium' | 'low';

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

// ───────────────────────────── Issues ─────────────────────────────

export type IssueKind =
  'bug' | 'feature' | 'incident' | 'tech_debt' | 'feedback' | 'idea' | 'security';
/** Reserved prefix used by issues that are not assigned to a project. */
export const UNASSIGNED_ISSUE_KEY_PREFIX = 'UNPR';
/** Prefixes already used by non-project keys. */
export const RESERVED_PROJECT_KEYS = [UNASSIGNED_ISSUE_KEY_PREFIX, 'ADR'] as const;
export const PROJECT_KEY_MAX = 4;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{0,3}$/;

export function normalizeProjectKey(value: string): string {
  return value.trim().toUpperCase();
}

export function isProjectKey(value: string): boolean {
  return PROJECT_KEY_PATTERN.test(value);
}

export function isReservedProjectKey(value: string): boolean {
  return (RESERVED_PROJECT_KEYS as readonly string[]).includes(
    normalizeProjectKey(value),
  );
}

/** Suggests a short uppercase project tag from its name; callers can let people edit the suggestion. */
export function suggestProjectKey(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
  const words = cleaned.split(/[^A-Z0-9]+/).filter(Boolean);
  const word = words[0] ?? '';
  const raw =
    words.length > 1
      ? words.map((part) => part[0] ?? '').join('')
      : word.length > PROJECT_KEY_MAX && /[AEIOU]$/.test(word)
        ? `${word
            .slice(0, -1)
            .replace(/[AEIOU]/g, '')
            .slice(0, PROJECT_KEY_MAX - 1)}${word.charAt(word.length - 1)}`
        : word.slice(0, PROJECT_KEY_MAX);
  const candidate = (raw ?? '').replace(/[^A-Z0-9]/g, '').slice(0, PROJECT_KEY_MAX);
  if (!candidate) return 'PROJ';
  return /^[A-Z]/.test(candidate) ? candidate : `P${candidate}`.slice(0, PROJECT_KEY_MAX);
}

/** Generates a valid unused project tag, adding a short suffix when the name's suggestion is taken. */
export function uniqueProjectKey(name: string, usedKeys: Iterable<string>): string {
  const taken = new Set([...usedKeys].map((key) => key.toUpperCase()));
  const base = suggestProjectKey(name);
  if (!isReservedProjectKey(base) && !taken.has(base)) return base;

  for (let n = 1; n < 36 ** (PROJECT_KEY_MAX - 1); n++) {
    const suffix = n.toString(36).toUpperCase();
    const candidate = `${base.slice(0, PROJECT_KEY_MAX - suffix.length)}${suffix}`;
    if (
      PROJECT_KEY_PATTERN.test(candidate) &&
      !isReservedProjectKey(candidate) &&
      !taken.has(candidate)
    )
      return candidate;
  }
  throw new Error('No available project tags remain');
}

/**
 * Tracker status. `backlog` is unscheduled demand.
 */
export type IssueStatus =
  'draft' | 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';
export type IssueSource = 'manual' | 'github' | 'gitlab' | 'linear' | 'email' | 'api' | 'agent';

/**
 * A unit of demand: one bug, request, incident, or task.
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
  /** When a user moves an unassigned issue to `in_progress`, the server sets this to that user. */
  assigneeId?: ID;
  priority: Priority;
  status: IssueStatus;
  /** Project this issue is planned under; deleting the project clears it. */
  projectId?: ID;
  /**
   * Milestones this issue is in: at most one per project, and only milestones of `projectId`.
   */
  milestoneIds: ID[];
  /** Story-point estimate (non-negative). Scales live in src/app/core/estimates.ts. */
  estimate?: number;
  /** When the task should be done (a calendar day, stored as midnight UTC). Drives "Up next" and due chips. */
  dueDate?: ISODate;
  /** First time the status entered in_progress / in_review. Kept when moved back. */
  startedAt?: ISODate;
  /** Set when the status becomes done or canceled; cleared on reopen. */
  completedAt?: ISODate;
  /** Workspace label ids (`WorkspaceSettings.labels`). */
  labels: ID[];
  /** Previous keys (project changes re-key the issue); lookups by key also match these. */
  aliases: string[];
  /** Parent issue id; sub-issues are independent and may be nested to any depth. */
  parentId?: ID;
  /** Set when this issue duplicates another. Status is `canceled`. */
  duplicateOfId?: ID;
  externalUrl?: string;
  /**
   * Link to the Delta thread (delta.dev) the user is working on for this task. Optional, http/https only,
   * at most {@link ISSUE_THREAD_URL_MAX} characters. `null` in PATCH clears it.
   */
  threadUrl?: string;
  /** The issue this one was imported from or is linked to in an external tracker (read-only mirror of its status). */
  externalRef?: ExternalRef;
  /**
   * Visible artifacts attached to this issue. Set on issue get only when the caller can read artifacts;
   * `0` means there is no need to list artifacts. Not stored on the issue row.
   */
  artifactCount?: number;
  createdAt: ISODate;
  updatedAt: ISODate;
}

/**
 * Public name of an {@link Issue}. The wire type, JSON field names (`issueId`), and discriminators
 * (`issue`) stay `issue`. HTTP routes and API-token resources use `tasks`.
 */
export type Task = Issue;

/** Issue-owned context, with a plan summary only when the issue has plan artifacts. */
export interface IssueContext {
  issue: Issue;
  planSummary?: {
    artifactCount: number;
    latestArtifact?: Artifact;
  };
  artifacts: Artifact[];
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

/** Longest `Issue.threadUrl`, in characters. */
export const ISSUE_THREAD_URL_MAX = 2048;

/** True when the value is a plain `http(s)` URL with a host of at most {@link ISSUE_THREAD_URL_MAX} characters. */
export function isThreadUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw || raw !== value || raw.length > ISSUE_THREAD_URL_MAX) return false;
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
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

export type ArtifactProvider =
  'github' | 'gitlab' | 'bitbucket' | 'delta' | 'figma' | 'docs' | 'ci' | 'other';

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

/** Something a task produced or points to: a PR, a build, a link, a file. */
export interface Artifact {
  id: ID;
  /** The task that owns it. Absent only on artifacts retained from a retired Workstream owner. */
  issueId?: ID;
  /** Provenance for artifacts retained from a retired Workstream owner. */
  legacyWorkstreamKey?: string;
  /**
   * Git full name (`owner/name`) or URL of the artifact's repository. Not a row id.
   * Omitted when unknown. `null` only in PATCH, where it clears the field.
   * At most {@link PROJECT_REPOSITORY_MAX} characters.
   */
  repository?: string | null;
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

// ───────────────────────────── Plans (a convention, not a gate) ─────────────────────────────

/**
 * An Issue's optional implementation plan is a `document` artifact attached to it whose title starts with
 * "Plan", for example a repository file (the artifact's `externalId` is the commit sha). Nothing is stored
 * separately or blocks work.
 */
export function isPlanArtifact(a: Pick<Artifact, 'kind' | 'title'>): boolean {
  return a.kind === 'document' && /^\s*plan\b/i.test(a.title);
}

// ───────────────────────────── Comments & events ─────────────────────────────

/** Comment, event, and search subject. `issue` is the task discriminator; it is not renamed to `task`. */
export type SubjectType =
  | 'issue'
  | 'artifact'
  | 'project'
  | 'milestone'
  | 'import';

export interface SubjectRef {
  type: SubjectType;
  id: ID;
}

/** Historical comments and events may still point at the retired Workstream entity. */
export type LegacySubjectRef = SubjectRef | { type: 'workstream'; id: ID };

export interface Comment {
  id: ID;
  workspaceId: ID;
  subject: LegacySubjectRef;
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
  subject: LegacySubjectRef;
  author: ActorRef;
  count: number;
}

/**
 * Append-only activity log (event-based activity model). Written by the server
 * on every mutation and by integrations/agents. `type` examples:
 * artifact.attached, artifact.updated, issue.created, issue.status_changed,
 * issue.rekeyed, milestone.created, milestone.updated, milestone.deleted,
 * comment.created, review.requested.
 */
export interface DomainEvent {
  id: ID;
  workspaceId: ID;
  at: ISODate;
  actor: ActorRef;
  type: string;
  subject: LegacySubjectRef;
  /** Provenance for events retained from a retired Workstream association. */
  legacyWorkstreamKey?: string;
  data: Record<string, unknown>;
}

// ───────────────────────────── Attention ─────────────────────────────

export type AttentionKind =
  | 'review_requested'
  | 'ci_failed'
  | 'conflict'
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
  artifactId?: ID;
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
  | 'stale_issues'
  | 'overdue_milestones'
  | 'prs_stuck_in_review'
  | 'ci_failing';

export interface InsightSignalMeta {
  label: string;
  /** What exactly is counted. Shown in the UI and returned to agents. */
  definition: string;
  /** Singular noun used to describe the counted items. */
  unit: string;
}

export const INSIGHT_SIGNALS: Record<InsightSignalId, InsightSignalMeta> = {
  stale_issues: {
    label: 'Stale issues',
    definition: 'Issues In Progress or In Review that were not updated for the stale threshold.',
    unit: 'issue',
  },
  overdue_milestones: {
    label: 'Overdue milestones',
    definition:
      'Milestones past their target date that still have open issues, in projects that are not completed or canceled.',
    unit: 'milestone',
  },
  prs_stuck_in_review: {
    label: 'PRs stuck in review',
    definition:
      'Open, non-draft pull requests without an approval and without an update for 3 days or more.',
    unit: 'pull request',
  },
  ci_failing: {
    label: 'CI failing',
    definition: 'Open pull requests whose latest CI result is failing.',
    unit: 'pull request',
  },
};

export const INSIGHT_SIGNAL_IDS = Object.keys(INSIGHT_SIGNALS) as InsightSignalId[];

export type InsightItemType = 'issue' | 'milestone' | 'artifact' | 'project';

/** One thing that causes a signal (or sits in a flow list). Enough to render a row and link to it. */
export interface InsightItem {
  type: InsightItemType;
  id: ID;
  /** Human key (e.g. `CORA-7`, `ADR-3`) when the type has one. */
  key?: string;
  title: string;
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

/** Who is the bottleneck: reviews waiting on one actor. */
export interface InsightBottleneck {
  actor: InsightActor;
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
}

export interface InsightWipRow {
  actor: InsightActor;
  /** Issues In Progress or In Review assigned to the person (people only). */
  issues: number;
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
  throughput: ThroughputBucket[];
  previousThroughput: { issuesDone: number };
  wip: {
    people: InsightWipRow[];
    agents: InsightWipRow[];
    limits: { issues: number };
  };
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
  lastActiveAt?: ISODate;
}

export interface AgentFailureRow {
  agent: InsightActor;
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
  scope: { projectId?: ID };
  staleDays: number;
  signals: InsightSignal[];
  bottlenecks: InsightBottleneck[];
  flow: InsightFlow;
  actors: InsightActors;
}

// ───────────────────────────── Views & tokens ─────────────────────────────

/** Saved-view discriminator. `issue` is the task list; it is not renamed to `task`. */
export type ViewEntity = 'issue' | 'project';
/** `timeline` (Gantt) is a layout of a saved view, offered for project views. */
export type ViewLayout = 'list' | 'board' | 'timeline';

export interface ViewFilter {
  field: string;
  /**
   * `gte` / `lte` compare numeric fields (estimates and similar). `all` (every listed value is present),
   * `between` (`[from, to]`), `last` / `next` (a number of days) and `overdue` are only used by the task
   * list filters; saved views and the public view evaluator do not accept them yet. Date values are
   * `YYYY-MM-DD` or a relative token (`today`, `-7d`, `week_start`…).
   */
  op:
    | 'is'
    | 'is_not'
    | 'in'
    | 'not_in'
    | 'contains'
    | 'before'
    | 'after'
    | 'gte'
    | 'lte'
    | 'all'
    | 'between'
    | 'last'
    | 'next'
    | 'overdue';
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
  /** Projects only. */
  health?: string;
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

/** Who owns a connection: a whole workspace (admins manage it) or one person. */
export type ConnectionOwnerType = 'workspace' | 'user';

/**
 * `connected` (ok): usable. `error`: the provider rejected it; `lastError` says why. `revoked`: the
 * credential was withdrawn on purpose (the token is wiped); rules that read through it show an error
 * until someone reconnects or switches to another connection.
 */
export type ConnectionStatus = 'connected' | 'error' | 'revoked';

/** Host a connection talks to: the host of its base URL, else the provider's public host. */
export function connectionHost(provider: GitProvider | 'delta', baseUrl?: string | null): string {
  if (baseUrl) {
    try {
      return new URL(baseUrl).host.toLowerCase();
    } catch {
      return baseUrl.toLowerCase();
    }
  }
  return provider === 'delta' ? 'delta' : GIT_PROVIDER_META[provider].host;
}

export interface IntegrationConnection {
  id: ID;
  ownerType: ConnectionOwnerType;
  /** Set for workspace connections, absent for personal ones. */
  workspaceId?: ID;
  /** Set for personal connections: the only person who sees and manages it. */
  ownerUserId?: ID;
  /** Display name of the owner of a personal connection. */
  ownerName?: string;
  /** Display name, e.g. "GitHub · personal". Several connections per provider are allowed. */
  label: string;
  provider: GitProvider | 'delta';
  /** Display account, e.g. GitHub org/user. */
  account: string;
  /** Base URL for self-hosted GitLab / GitHub Enterprise (not used by Bitbucket Cloud). */
  baseUrl?: string;
  /** Host this connection talks to (`github.com`, `gitlab.example.com`). */
  host: string;
  /** Whether a webhook secret is configured (secret itself never returned). */
  webhookConfigured: boolean;
  status: ConnectionStatus;
  lastSyncAt?: ISODate;
  lastError?: string;
  createdAt: ISODate;
}

/** A connection a person may pick for a project rule. `suggested` marks the one the UI preselects. */
export type UsableConnection = IntegrationConnection & { suggested: boolean };

// ───────────────────────────── Permissions & workspace settings ─────────────────────────────

export type TokenScope = 'read' | 'write' | 'admin' | 'custom';
export const TOKEN_SCOPES: Record<TokenScope, { label: string; description: string }> = {
  read: {
    label: 'Read',
    description: 'Read-only: GET requests. Good for dashboards and reporting.',
  },
  write: {
    label: 'Write',
    description:
      'Create and update Issues, comments and other work records with at most the member role. Cannot change workspace settings.',
  },
  admin: {
    label: 'Admin',
    description:
      "Everything the acting user's role allows, including members, integrations and settings. Only admins can create one.",
  },
  custom: {
    label: 'Custom',
    description:
      "Only the listed permissions (resource × action), always within the acting user's role.",
  },
};

/**
 * Fine-grained API permissions (`<resource>:<action>`), used by `custom` tokens. The required
 * permission of a request is derived from its route: `/w/:slug/<resource>/…` plus the HTTP method
 * (GET → read, POST/PUT/PATCH → write, DELETE → delete). Tasks are served at `/tasks`, so the
 * resource is `tasks` (`tasks:read`, `tasks:write`, `tasks:delete`), not `issues`.
 * Membership grants stay `issues:*` — those strings are stored on roles. See {@link MemberResource}.
 * A route whose resource is not listed here is denied to custom tokens.
 */
export type ApiAction = 'read' | 'write' | 'delete';
export type ApiResource =
  | 'workspace'
  | 'projects'
  | 'tasks'
  | 'milestones'
  | 'comments'
  | 'artifacts'
  | 'views'
  | 'attention'
  | 'search'
  | 'events'
  | 'snapshot'
  | 'insights'
  | 'members'
  | 'agents'
  | 'tokens'
  | 'integrations'
  | 'outgoing-webhooks';
export type ApiPermission = `${ApiResource}:${ApiAction}`;

export interface ApiResourceMeta {
  label: string;
  group: 'Work' | 'Insight' | 'Organization' | 'Access & automation';
  actions: readonly ApiAction[];
}

const RWD = ['read', 'write', 'delete'] as const;
export const API_RESOURCES: Record<ApiResource, ApiResourceMeta> = {
  projects: { label: 'Projects', group: 'Work', actions: RWD },
  tasks: { label: 'Tasks', group: 'Work', actions: RWD },
  milestones: { label: 'Milestones', group: 'Work', actions: RWD },
  comments: { label: 'Comments', group: 'Work', actions: RWD },
  artifacts: { label: 'Artifacts', group: 'Work', actions: RWD },
  views: { label: 'Views', group: 'Work', actions: RWD },
  attention: { label: 'Attention', group: 'Work', actions: ['read', 'write'] },
  search: { label: 'Search', group: 'Insight', actions: ['read'] },
  events: { label: 'Activity log', group: 'Insight', actions: ['read'] },
  snapshot: { label: 'Snapshot', group: 'Insight', actions: ['read'] },
  insights: { label: 'Insights', group: 'Insight', actions: ['read'] },
  workspace: { label: 'Workspace & settings', group: 'Organization', actions: RWD },
  members: { label: 'Members', group: 'Access & automation', actions: RWD },
  agents: { label: 'Agents', group: 'Access & automation', actions: RWD },
  tokens: { label: 'API tokens', group: 'Access & automation', actions: RWD },
  integrations: { label: 'Integrations', group: 'Access & automation', actions: RWD },
  'outgoing-webhooks': { label: 'Outgoing webhooks', group: 'Access & automation', actions: RWD },
};

export const API_PERMISSIONS: readonly ApiPermission[] = (
  Object.keys(API_RESOURCES) as ApiResource[]
).flatMap((r) => API_RESOURCES[r].actions.map((a) => `${r}:${a}` as ApiPermission));

/** Every `*:read` permission. */
const READ_ALL = API_PERMISSIONS.filter((p) => p.endsWith(':read'));
const WORK: ApiResource[] = [
  'projects',
  'tasks',
  'milestones',
  'comments',
  'artifacts',
  'views',
  'attention',
];

/** Starting points offered in Settings; the final selection is always an explicit permission list. */
export const PERMISSION_PRESETS: Record<
  'read-only' | 'contributor' | 'everything',
  { label: string; description: string; permissions: readonly ApiPermission[] }
> = {
  'read-only': {
    label: 'Read-only',
    description: 'Read every resource. Nothing can be changed.',
    permissions: READ_ALL,
  },
  contributor: {
    label: 'Contributor',
    description:
      'Read everything and create/update work items. No deletes, no members, tokens or integrations.',
    permissions: [
      ...READ_ALL,
      ...WORK.filter((r) => r !== 'attention').map((r) => `${r}:write` as ApiPermission),
      'attention:write',
    ],
  },
  everything: {
    label: 'Everything',
    description: "All permissions. The acting user's role still applies.",
    permissions: API_PERMISSIONS,
  },
};

/** Request budget of an API token (enforced server-side; sessions are not limited). */
export interface TokenLimits {
  requestsPerMinute: number;
  writesPerMinute: number;
  writesPerDay: number;
}
export const DEFAULT_TOKEN_LIMITS: TokenLimits = {
  requestsPerMinute: 600,
  writesPerMinute: 60,
  writesPerDay: 2000,
};
/** Upper bounds a token can be configured with. */
export const MAX_TOKEN_LIMITS: TokenLimits = {
  requestsPerMinute: 6000,
  writesPerMinute: 600,
  writesPerDay: 20000,
};

/** Capabilities a workspace role can include (Settings → Roles & permissions). Each role has its own set. */
export type Capability =
  | 'manageProjects'
  | 'createIssues'
  | 'deleteIssues'
  | 'manageSharedViews'
  | 'inviteMembers'
  | 'manageAgents'
  | 'manageTokens'
  | 'manageIntegrations';

/** What each old rank was allowed, before workspace roles. Migration reads this; it is not the live policy. */
export type PermissionMap = Record<Capability, LegacyRole>;

export interface CapabilityMeta {
  label: string;
  description: string;
  group: 'Work' | 'Access & automation';
}

export const CAPABILITIES: Capability[] = [
  'manageProjects',
  'createIssues',
  'deleteIssues',
  'manageSharedViews',
  'inviteMembers',
  'manageAgents',
  'manageTokens',
  'manageIntegrations',
];

export const CAPABILITY_META: Record<Capability, CapabilityMeta> = {
  manageProjects: { group: 'Work', label: 'Manage projects', description: 'Create, edit and delete projects and their milestones.' },
  createIssues: { group: 'Work', label: 'Create issues', description: 'File bugs, features, incidents and other issues.' },
  deleteIssues: { group: 'Work', label: 'Delete issues', description: 'Permanently delete an issue (prefer canceling it).' },
  manageSharedViews: { group: 'Work', label: 'Share views', description: 'Create or publish saved views for the whole workspace.' },
  inviteMembers: { group: 'Access & automation', label: 'Invite members', description: 'Add people to the workspace. You can only invite someone into a role whose permissions you already have.' },
  manageAgents: { group: 'Access & automation', label: 'Manage agents', description: 'Register agents, edit them, and mint tokens that act as an agent.' },
  manageTokens: { group: 'Access & automation', label: 'Create API tokens', description: 'Create personal API tokens (read / write scope). A write-scoped token cannot create an admin-scoped one.' },
  manageIntegrations: { group: 'Access & automation', label: 'Manage integrations', description: 'Connect GitHub, GitLab and Delta, and manage outgoing webhooks.' },
};

/** Today's behaviour: everyday work for members, structure and access for admins. */
export const DEFAULT_PERMISSIONS: PermissionMap = {
  manageProjects: 'member',
  createIssues: 'member',
  deleteIssues: 'member',
  manageSharedViews: 'member',
  inviteMembers: 'admin',
  manageAgents: 'admin',
  manageTokens: 'member',
  manageIntegrations: 'admin',
};

/** Which records a label can be added to. */
export type LabelScope = 'issue' | 'project';
/** Former Workstream-scoped labels are preserved, but are not assignable to active records. */
export type StoredLabelScope = LabelScope | 'workstream';
export const LABEL_SCOPES: readonly LabelScope[] = ['issue', 'project'];

const LABEL_SCOPE_VALUES = new Set<string>(LABEL_SCOPES);

/** Missing or unknown scope is `issue`. */
function asLabelScope(value: unknown): StoredLabelScope {
  return typeof value === 'string' && LABEL_SCOPE_VALUES.has(value)
    ? (value as LabelScope)
    : value === 'workstream'
      ? 'workstream'
    : 'issue';
}

/** A label defined once for the workspace and assigned by id. */
export interface WorkspaceLabel {
  id: ID;
  name: string;
  /** `#rrggbb`. */
  color: string;
  /** Built-in labels are managed by the application rather than the workspace. */
  template: boolean;
  /**
   * Exactly one record type. An assignment that does not match stays on the record and still renders,
   * but that id cannot be added again.
   */
  scope: StoredLabelScope;
  /**
   * Archived labels stay on what already carries them but are no longer offered when assigning.
   * Only ever `true`; an active label omits the field.
   */
  archived?: boolean;
}

/** A stored label may predate scopes. `resolveLabelCatalog` fills the gap. */
type StoredLabel = Omit<WorkspaceLabel, 'scope'> & { scope?: StoredLabelScope };

/** No type labels are pre-created; workspace labels are user-defined. */
export const LABEL_TEMPLATES: readonly WorkspaceLabel[] = [];

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

/** Configured built-in labels first, then stored workspace labels. */
export function resolveLabelCatalog(stored?: readonly StoredLabel[] | null): WorkspaceLabel[] {
  const incoming = Array.isArray(stored) ? stored : [];
  const byId = new Map(
    incoming.filter((item) => item && typeof item.id === 'string').map((item) => [item.id, item]),
  );
  const templates = LABEL_TEMPLATES.map((template) => {
    const saved = byId.get(template.id);
    const color = saved && LABEL_COLOR.test(saved.color) ? saved.color : template.color;
    return { id: template.id, name: template.name, color, template: true, scope: 'issue' as const };
  });
  const templateIds = new Set(templates.map((label) => label.id));
  const custom: WorkspaceLabel[] = [];
  for (const item of incoming) {
    if (
      !item ||
      item.template ||
      templateIds.has(item.id) ||
      custom.some((label) => label.id === item.id)
    )
      continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > LABEL_NAME_MAX || !LABEL_COLOR.test(item.color ?? '')) continue;
    const label = {
      id: item.id,
      name,
      color: item.color,
      template: false as const,
      scope: asLabelScope(item.scope),
    };
    custom.push(item.archived === true ? { ...label, archived: true } : label);
  }
  return [...templates, ...custom];
}

/**
 * The ids of one record after `from` is merged into `into` (or removed when `into` is null).
 * Keeps the order, never lists an id twice.
 */
export function replaceLabelId(
  ids: readonly string[],
  from: string,
  into: string | null,
): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const next = id === from ? into : id;
    if (next && !out.includes(next)) out.push(next);
  }
  return out;
}

/**
 * Unique catalog ids, in order.
 * Throws when an id is unknown, the list is longer than `LABEL_ASSIGN_MAX`, or the label's scope is not
 * `scope` and the id is not already in `current`. Ids already stored stay, even when they no longer match.
 * `scope` null means the record is not a scoped type: only ids already in `current` are kept.
 */
export function assignLabelIds(
  catalog: readonly WorkspaceLabel[],
  ids: readonly string[] | null | undefined,
  scope: LabelScope | null,
  current?: readonly string[] | null,
): string[] {
  const known = new Map(catalog.map((label) => [label.id, label]));
  const kept = new Set(current ?? []);
  const out: string[] = [];
  for (const id of ids ?? []) {
    const label = known.get(id);
    if (!label) throw new Error(`Unknown label "${id}"`);
    const matches = scope !== null && label.scope === scope;
    if (!matches && !kept.has(id)) {
      const where = scope === null ? 'this record' : `${scope}s`;
      throw new Error(`Label "${id}" does not apply to ${where}`);
    }
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > LABEL_ASSIGN_MAX)
    throw new Error(`A record can have at most ${LABEL_ASSIGN_MAX} labels`);
  return out;
}

/**
 * Turn free-text label lists into catalog ids.
 * A string that is already a catalog id is kept. A name that matches a label (case-insensitive) reuses it.
 * Anything else becomes a custom label with that group's scope. `groups` is rewritten in the same order.
 */
export function adoptFreeTextLabels(
  stored: readonly StoredLabel[] | null | undefined,
  groups: readonly { scope: StoredLabelScope; labels: readonly string[] }[],
): { catalog: WorkspaceLabel[]; groups: string[][]; lookup: Map<string, string> } {
  let catalog = resolveLabelCatalog(stored);
  const byName = new Map(catalog.map((label) => [label.name.toLowerCase(), label.id]));
  const taken = new Set(catalog.map((label) => label.id));
  const lookup = new Map<string, string>();
  let colorAt = catalog.filter((label) => !label.template).length;
  const mapOne = (raw: string, scope: StoredLabelScope): string => {
    const name = raw.trim();
    if (!name) return '';
    const known = lookup.get(name) ?? (taken.has(name) ? name : byName.get(name.toLowerCase()));
    if (known) {
      lookup.set(name, known);
      return known;
    }
    const slug =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '')
        .slice(0, 20) || 'label';
    let id = `lb_${slug}`;
    for (let n = 2; taken.has(id); n++) id = `lb_${slug}${n}`;
    const color = LABEL_SWATCHES[colorAt % LABEL_SWATCHES.length];
    colorAt += 1;
    catalog = [
      ...catalog,
      { id, name: name.slice(0, LABEL_NAME_MAX), color, template: false, scope },
    ];
    taken.add(id);
    byName.set(name.toLowerCase(), id);
    lookup.set(name, id);
    return id;
  };
  const rewritten = groups.map((group) => {
    const scope = asLabelScope(group.scope);
    return [...new Set(group.labels.map((raw) => mapOne(raw, scope)).filter(Boolean))];
  });
  return { catalog, lookup, groups: rewritten };
}

export type EstimateScale = 'fibonacci' | 'linear' | 'exponential' | 'tshirt' | 'none';
export const ESTIMATE_SCALES: EstimateScale[] = [
  'fibonacci',
  'linear',
  'exponential',
  'tshirt',
  'none',
];
export type WeekStart = 'monday' | 'sunday' | 'saturday';
export const WEEK_STARTS: WeekStart[] = ['monday', 'sunday', 'saturday'];

export const OWNER_ROLE_ID = 'owner';
export const ROLE_NAME_MAX = 40;
const ROLE_ID = /^[a-z][a-z0-9_]{0,48}$/;

/** A role defined by the workspace. `owner` is permanent; every other role can be renamed or deleted. */
export interface WorkspaceRole {
  id: string;
  name: string;
  /** True only for the permanent owner role. It can manage roles and cannot be deleted. */
  owner: boolean;
  /** Capabilities this role has. Nothing is inherited from another role. */
  capabilities: Capability[];
  /** Base work permissions. Extras on a person are added on top. The owner role always has every grant. */
  grants: MemberGrant[];
}

/** The owner role always keeps these, so someone can still manage members. Managing roles is the owner role itself. */
export const OWNER_REQUIRED_CAPABILITIES: readonly Capability[] = ['inviteMembers'];

/** Capabilities that used to require an admin. A write-scoped token cannot use them. Holding any of them administers the workspace. */
export const ADMIN_CAPABILITIES: readonly Capability[] = CAPABILITIES.filter((cap) => DEFAULT_PERMISSIONS[cap] === 'admin');

const LEGACY_RANK: Record<LegacyRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** True when both ids are old ranks and `role` is at least `min`. Custom role ids are never ranked. */
export function legacyRoleAtLeast(role: string, min: string): boolean {
  const a = LEGACY_RANK[role as LegacyRole];
  const b = LEGACY_RANK[min as LegacyRole];
  return a !== undefined && b !== undefined && a >= b;
}

/** @deprecated Use the role's own capabilities. Still true for the four migrated rank ids. */
export function roleAtLeast(role: string, min: string): boolean {
  return legacyRoleAtLeast(role, min);
}

export function capabilitiesForLegacyRole(role: LegacyRole, permissions: PermissionMap = DEFAULT_PERMISSIONS): Capability[] {
  return CAPABILITIES.filter((cap) => legacyRoleAtLeast(role, permissions[cap] ?? DEFAULT_PERMISSIONS[cap]));
}

export function normalizeCapabilities(input: readonly unknown[], owner: boolean): Capability[] {
  const chosen = new Set<Capability>();
  for (const cap of input) {
    if (typeof cap === 'string' && (CAPABILITIES as readonly string[]).includes(cap)) chosen.add(cap as Capability);
  }
  if (owner) for (const cap of OWNER_REQUIRED_CAPABILITIES) chosen.add(cap);
  return CAPABILITIES.filter((cap) => chosen.has(cap));
}

export function ownerWorkspaceRole(capabilities: readonly Capability[] = [...CAPABILITIES]): WorkspaceRole {
  return { id: OWNER_ROLE_ID, name: 'Owner', owner: true, capabilities: normalizeCapabilities(capabilities, true), grants: [...MEMBER_GRANTS] };
}

/** A brand-new workspace starts with the four old ranks, as editable roles. Admin, Member and Viewer can be deleted. */
export function freshWorkspaceRoles(): WorkspaceRole[] {
  return migrateLegacyRoles();
}

/**
 * Turn the old owner / admin / member / viewer matrix into editable roles with the same capabilities
 * those ranks have under `permissions` (an admin keeps what a member could do).
 */
export function migrateLegacyRoles(
  permissions?: Partial<PermissionMap> | null,
  grants?: Partial<Record<LegacyRole, readonly unknown[]>> | null,
): WorkspaceRole[] {
  const perms: PermissionMap = { ...DEFAULT_PERMISSIONS };
  for (const cap of CAPABILITIES) {
    const value = permissions?.[cap];
    if (value && (LEGACY_ROLES as readonly string[]).includes(value)) perms[cap] = value;
  }
  const byRole = resolveRoleGrants(grants);
  const names: Record<LegacyRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
  return LEGACY_ROLES.map((id) => ({
    id,
    name: names[id],
    owner: id === OWNER_ROLE_ID,
    capabilities: capabilitiesForLegacyRole(id, perms),
    grants: id === OWNER_ROLE_ID ? [...MEMBER_GRANTS] : byRole[id],
  }));
}

/** Drops unknown ids, keeps a single owner role, and puts the required capabilities back on it. */
export function normalizeWorkspaceRoles(input: readonly unknown[]): WorkspaceRole[] {
  const roles: WorkspaceRole[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw['id'] === 'string' ? raw['id'].trim() : '';
    if (!ROLE_ID.test(id) || seen.has(id) || id === 'agent') continue;
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
    if (!name || name.length > ROLE_NAME_MAX) continue;
    const owner = id === OWNER_ROLE_ID;
    seen.add(id);
    roles.push({
      id,
      name,
      owner,
      capabilities: normalizeCapabilities(Array.isArray(raw['capabilities']) ? raw['capabilities'] : [], owner),
      grants: owner ? [...MEMBER_GRANTS] : normalizeGrantList(Array.isArray(raw['grants']) ? raw['grants'] : []),
    });
  }
  if (!roles.some((role) => role.owner)) roles.unshift(ownerWorkspaceRole());
  return roles;
}

export function findWorkspaceRole(roles: readonly WorkspaceRole[], roleId: string | null | undefined): WorkspaceRole | undefined {
  if (!roleId) return undefined;
  return roles.find((role) => role.id === roleId);
}

export function workspaceRoleName(roles: readonly WorkspaceRole[] | null | undefined, roleId: string | null | undefined): string {
  if (!roleId) return '';
  const found = roles ? findWorkspaceRole(roles, roleId) : undefined;
  if (found) return found.name;
  const legacy: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
  return legacy[roleId] ?? roleId;
}

export function roleHasCapability(roles: readonly WorkspaceRole[], roleId: string, capability: Capability): boolean {
  return !!findWorkspaceRole(roles, roleId)?.capabilities.includes(capability);
}

/** Owner, or a role that holds a capability which used to require an admin. */
export function roleHasAdminPower(role: Pick<WorkspaceRole, 'owner' | 'capabilities'> | null | undefined): boolean {
  return !!role && (role.owner || ADMIN_CAPABILITIES.some((cap) => role.capabilities.includes(cap)));
}

/**
 * Can change everyday work: the owner role, a grant that is not view-only, or a capability that is not
 * workspace administration. An admin-only capability does not imply write access to issues and the like.
 */
export function roleCanWrite(role: Pick<WorkspaceRole, 'owner' | 'capabilities' | 'grants'> | null | undefined): boolean {
  if (!role) return false;
  if (role.owner) return true;
  if (role.grants.some((grant) => !grant.endsWith(':view'))) return true;
  return role.capabilities.some((cap) => !ADMIN_CAPABILITIES.includes(cap));
}

/** Agents are not a workspace role. They receive the historical member permissions and never own the workspace. */
export function agentWorkspaceRole(): WorkspaceRole {
  return { id: 'agent', name: 'Agent', owner: false, capabilities: capabilitiesForLegacyRole('member'), grants: roleGrants('member') };
}

/** An owner can grant any role. Anyone else can only grant a role whose capabilities and grants they already have. */
export function canGrantRole(caller: WorkspaceRole | null | undefined, target: WorkspaceRole | null | undefined): boolean {
  if (!caller || !target) return false;
  if (target.owner && !caller.owner) return false;
  if (caller.owner) return true;
  return target.capabilities.every((cap) => caller.capabilities.includes(cap)) && target.grants.every((grant) => caller.grants.includes(grant));
}

/** `read` drops every capability and keeps view grants. `write` drops admin capabilities and the owner flag. */
export function applyTokenScope(role: WorkspaceRole, scope: TokenScope | undefined): WorkspaceRole {
  if (scope !== 'read' && scope !== 'write') return role;
  return {
    ...role,
    owner: false,
    capabilities: scope === 'read' ? [] : role.capabilities.filter((cap) => !ADMIN_CAPABILITIES.includes(cap)),
    grants: scope === 'read' ? role.grants.filter((grant) => grant.endsWith(':view')) : role.grants,
  };
}

export interface RoleGate {
  /** Set by `@Can`. A missing capability is rejected, with no grant fallback. */
  capability?: Capability;
  /** `@Roles`, or the default: `member` for writes and `viewer` for reads. */
  min: 'viewer' | 'member' | 'admin' | 'owner';
  neededGrant: MemberGrant | null;
}

/** Whether this role may pass the gate. Personal extras can cover a write that the role itself cannot. */
export function roleAllows(role: WorkspaceRole | null | undefined, gate: RoleGate, access: MemberAccess | null): boolean {
  if (!role) return false;
  if (gate.capability) return role.capabilities.includes(gate.capability);
  if (gate.min === 'owner') return role.owner;
  if (gate.min === 'admin') {
    if (roleHasAdminPower(role)) return true;
  } else if (gate.min === 'viewer') return true;
  else if (roleCanWrite(role)) return true;
  return !!gate.neededGrant && !!access?.grants.includes(gate.neededGrant);
}

/** One catalog per subject. The type is the semantic value boards and done/canceled already understand. */
export type StatusSubject = 'issue' | 'project' | 'project_health';

export const STATUS_SUBJECTS: readonly StatusSubject[] = ['issue', 'project', 'project_health'];

export const STATUS_SUBJECT_LABEL: Record<StatusSubject, string> = {
  issue: 'Issues',
  project: 'Projects',
  project_health: 'Project health',
};

export const STATUS_NAME_MAX = 40;

/** Lucide icon name (kebab-case) or one emoji. Same constraint as a project icon. */
const STATUS_ICON_NAME = '[a-z][a-z0-9]*(?:-[a-z0-9]+)*';
const STATUS_ICON_EMOJI =
  '\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?(?:\\u200D\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)*|\\p{Regional_Indicator}{2}';
export const STATUS_ICON_MAX = 48;
export const STATUS_ICON_PATTERN = new RegExp(`^(?:${STATUS_ICON_NAME}|${STATUS_ICON_EMOJI})$`, 'u');
export const STATUS_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isStatusIcon(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= STATUS_ICON_MAX &&
    STATUS_ICON_PATTERN.test(value)
  );
}

export interface StatusEntry<T extends string = string> {
  /** Stable id. Seeds use the semantic type string, so rows that already store that enum keep working. */
  id: string;
  name: string;
  /** Lucide icon name (kebab-case) or a single emoji. */
  icon: string;
  /** `#rrggbb`. */
  color: string;
  /** Semantic type. Several entries may share one. Derivation, open/done and workflow read this, not the id. */
  type: T;
}

export interface StatusCatalog {
  issue: StatusEntry<IssueStatus>[];
  project: StatusEntry<ProjectStatus>[];
  projectHealth: StatusEntry<ProjectHealth>[];
}

export const STATUS_CATALOG_KEY: Record<StatusSubject, keyof StatusCatalog> = {
  issue: 'issue',
  project: 'project',
  project_health: 'projectHealth',
};

interface StatusSeed<T extends string> {
  type: T;
  name: string;
  icon: string;
  color: string;
}

// v3 palette (docs/designs, "UI Kit · Foundations"): todo gray · in progress yellow · in review blue · done green.
const NEUTRAL = '#8c9096';
const SLATE = '#8c9096';
const FAINT = '#5e6269';
const DIM = '#3a3e45';
const BLUE = '#5274e0';
const AMBER = '#e2a93b';
const RED = '#cc4b30';
const GREEN = '#6fae73';

/**
 * Default workflow of a new workspace: Backlog → Planning → In Progress → In Review / Waiting Input → Merged.
 * Ids stay the semantic type so rows that store the enum keep resolving. Canceled stays because duplicates and
 * "not planned" imports need a canceled type; `draft` is still a valid type (see STATUS_TYPES) but is not seeded.
 */
const ISSUE_STATUS_SEEDS: readonly StatusSeed<IssueStatus>[] = [
  { type: 'backlog', name: 'Backlog', icon: 'circle-dashed', color: FAINT },
  { type: 'todo', name: 'Planning', icon: 'circle', color: SLATE },
  { type: 'in_progress', name: 'In Progress', icon: 'circle-dot', color: AMBER },
  { type: 'in_review', name: 'In Review / Waiting Input', icon: 'circle-ellipsis', color: BLUE },
  { type: 'done', name: 'Merged', icon: 'circle-check', color: GREEN },
  { type: 'canceled', name: 'Canceled', icon: 'circle-x', color: DIM },
];

const PROJECT_STATUS_SEEDS: readonly StatusSeed<ProjectStatus>[] = [
  { type: 'backlog', name: 'Backlog', icon: 'circle-dashed', color: NEUTRAL },
  { type: 'planned', name: 'Planned', icon: 'circle', color: SLATE },
  { type: 'in_progress', name: 'In progress', icon: 'circle-dot', color: BLUE },
  { type: 'paused', name: 'Paused', icon: 'circle-pause', color: AMBER },
  { type: 'completed', name: 'Completed', icon: 'circle-check', color: GREEN },
  { type: 'canceled', name: 'Canceled', icon: 'circle-x', color: NEUTRAL },
];

const PROJECT_HEALTH_SEEDS: readonly StatusSeed<ProjectHealth>[] = [
  { type: 'on_track', name: 'On track', icon: 'circle-check', color: GREEN },
  { type: 'at_risk', name: 'At risk', icon: 'triangle-alert', color: AMBER },
  { type: 'off_track', name: 'Off track', icon: 'circle-alert', color: RED },
];

const STATUS_TYPES: Record<StatusSubject, readonly string[]> = {
  issue: ['draft', ...ISSUE_STATUS_SEEDS.map((s) => s.type)],
  project: PROJECT_STATUS_SEEDS.map((s) => s.type),
  project_health: PROJECT_HEALTH_SEEDS.map((s) => s.type),
};

function seedEntries<T extends string>(rows: readonly StatusSeed<T>[]): StatusEntry<T>[] {
  return rows.map((row) => ({ id: row.type, name: row.name, icon: row.icon, color: row.color, type: row.type }));
}

/** Today's statuses: one entry per semantic type, id equal to that type. */
export function defaultStatusCatalog(): StatusCatalog {
  return {
    issue: seedEntries(ISSUE_STATUS_SEEDS),
    project: seedEntries(PROJECT_STATUS_SEEDS),
    projectHealth: seedEntries(PROJECT_HEALTH_SEEDS),
  };
}

export function isStatusSubject(value: unknown): value is StatusSubject {
  return typeof value === 'string' && (STATUS_SUBJECTS as readonly string[]).includes(value);
}

export function statusTypes(subject: StatusSubject): readonly string[] {
  return STATUS_TYPES[subject];
}

/** Display name of a semantic type, from the seed (not a workspace's renamed copy). */
export function statusTypeLabel(subject: StatusSubject, type: string): string {
  const entries = defaultStatusCatalog()[STATUS_CATALOG_KEY[subject]];
  const name = entries.find((entry) => entry.type === type)?.name;
  if (name) return name;
  return type === 'draft' ? 'Draft' : type;
}

function normalizeStatusEntries<T extends string>(
  subject: StatusSubject,
  incoming: readonly StatusEntry<T>[] | undefined,
  defaults: readonly StatusEntry<T>[],
): StatusEntry<T>[] {
  if (!incoming?.length) return defaults.map((entry) => ({ ...entry }));
  const allowed = new Set(statusTypes(subject));
  const seen = new Set<string>();
  const entries: StatusEntry<T>[] = [];
  for (const item of incoming) {
    if (!item || typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name || name.length > STATUS_NAME_MAX) continue;
    if (!isStatusIcon(item.icon)) continue;
    if (typeof item.color !== 'string' || !STATUS_COLOR.test(item.color)) continue;
    if (typeof item.type !== 'string' || !allowed.has(item.type)) continue;
    seen.add(item.id);
    entries.push({ id: item.id, name, icon: item.icon, color: item.color.toLowerCase(), type: item.type as T });
  }
  for (const seed of defaults) {
    if (!entries.some((entry) => entry.type === seed.type)) entries.push({ ...seed });
  }
  return entries;
}

/** Stored catalog, or today's seeds when a workspace has none yet. Every semantic type keeps at least one entry. */
export function resolveStatusCatalog(stored?: Partial<StatusCatalog> | null): StatusCatalog {
  const defaults = defaultStatusCatalog();
  return {
    issue: normalizeStatusEntries('issue', stored?.issue, defaults.issue),
    project: normalizeStatusEntries('project', stored?.project, defaults.project),
    projectHealth: normalizeStatusEntries('project_health', stored?.projectHealth, defaults.projectHealth),
  };
}

/**
 * The catalog entry a stored value names. An id matches first. A legacy enum string (today's type, before ids
 * are rewritten) is the seeded entry of that type: the one whose id is still the type, else the first of the type.
 */
export function resolveStatusEntry<T extends string>(
  entries: readonly StatusEntry<T>[] | null | undefined,
  stored: string | null | undefined,
): StatusEntry<T> | undefined {
  if (!stored) return undefined;
  const list = entries ?? [];
  const byId = list.find((entry) => entry.id === stored);
  if (byId) return byId;
  const ofType = list.filter((entry) => entry.type === stored);
  return ofType.find((entry) => entry.id === entry.type) ?? ofType[0];
}

/** Semantic type of a stored id or legacy enum. Undefined when the value is not in the catalog. */
export function statusTypeOf<T extends string>(
  entries: readonly StatusEntry<T>[] | null | undefined,
  stored: string | null | undefined,
): T | undefined {
  return resolveStatusEntry(entries, stored)?.type;
}

/** Every id of these types, plus the type strings themselves so rows that still store the enum match. */
export function statusIdsForTypes<T extends string>(entries: readonly StatusEntry<T>[], types: readonly T[]): string[] {
  const want = new Set<string>(types);
  const ids = new Set<string>();
  for (const entry of entries) if (want.has(entry.type)) ids.add(entry.id);
  for (const type of types) ids.add(type);
  return [...ids];
}

/**
 * Values a record may store for this entry: its id, and the legacy enum when this entry is the seed of its type.
 * A custom status of the same type does not claim rows that still say `todo`.
 */
export function statusStoredValues<T extends string>(entry: StatusEntry<T>, entries: readonly StatusEntry<T>[]): string[] {
  const values = new Set<string>([entry.id]);
  const seed = entries.find((item) => item.type === entry.type && item.id === item.type) ?? entries.find((item) => item.type === entry.type);
  if (seed?.id === entry.id) values.add(entry.type);
  return [...values];
}

export interface WorkspaceSettings {
  /** Roles people and invitations can hold. A new workspace stores the four old ranks; older settings without `roles` are migrated on read. */
  roles: WorkspaceRole[];
  /** Scale offered for issue estimates. Estimates are stored as numbers either way. */
  estimateScale: EstimateScale;
  weekStart: WeekStart;
  /** IANA time zone used to display dates, or `auto` to follow each person's browser. */
  timeZone: string;
  /** Workspace icon background, `#rrggbb`. */
  iconColor?: string;
  /** 1-2 characters shown in the workspace icon (defaults to the name's initial). */
  iconInitial?: string;
  /** Workspace-defined labels. Assign these ids; do not invent names. */
  labels: WorkspaceLabel[];
  /** Status catalogs. A new workspace gets today's statuses; admins can rename them and add more of the same type. */
  statuses: StatusCatalog;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  roles: freshWorkspaceRoles(),
  estimateScale: 'fibonacci',
  weekStart: 'monday',
  timeZone: 'auto',
  labels: LABEL_TEMPLATES.map((label) => ({ ...label })),
  statuses: defaultStatusCatalog(),
};

/** Stored settings may still carry the old matrix. Those fields are migrated when `roles` is absent. */
export type StoredWorkspaceSettings = Partial<Omit<WorkspaceSettings, 'roles'>> & {
  roles?: readonly unknown[] | null;
  permissions?: Partial<PermissionMap> | null;
  roleGrants?: Partial<Record<LegacyRole, readonly unknown[]>> | null;
};

/** Fills the gaps of a stored (partial) settings object. Missing `roles` becomes the four old ranks. */
export function resolveWorkspaceSettings(raw?: StoredWorkspaceSettings | null): WorkspaceSettings {
  const r = raw ?? {};
  const roles = Array.isArray(r.roles) ? normalizeWorkspaceRoles(r.roles) : migrateLegacyRoles(r.permissions, r.roleGrants);
  const {
    permissions: _permissions,
    roleGrants: _roleGrants,
    roles: _roles,
    deltaThreads: _deltaThreads,
    defaultTeamId: _defaultTeamId,
    customerTiers: _customerTiers,
    ...rest
  } = r as StoredWorkspaceSettings & {
    deltaThreads?: unknown;
    defaultTeamId?: unknown;
    customerTiers?: unknown;
  };
  return {
    ...DEFAULT_WORKSPACE_SETTINGS,
    ...rest,
    roles,
    labels: resolveLabelCatalog(r.labels),
    statuses: resolveStatusCatalog(r.statuses),
  };
}

// ───────────────────────────── Outgoing webhooks ─────────────────────────────

/**
 * A custom integration: Trama POSTs a signed JSON body to `url` for every domain event that matches `events`.
 * Body: `{ id, event, workspace, at, actor, subject, data }`.
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
  {
    entity: 'project',
    label: 'Projects',
    events: [
      'project.created',
      'project.updated',
      'project.status_changed',
      'project.health_changed',
      'project.deleted',
    ],
  },
  {
    entity: 'issue',
    label: 'Tasks',
    events: [
      'issue.created',
      'issue.updated',
      'issue.status_changed',
      'issue.deleted',
    ],
  },
  {
    entity: 'artifact',
    label: 'Artifacts',
    events: ['artifact.attached', 'artifact.updated', 'artifact.deleted'],
  },
  { entity: 'comment', label: 'Comments', events: ['comment.created'] },
  {
    entity: 'import',
    label: 'Imports',
    events: ['import.started', 'import.completed', 'import.failed', 'import.canceled'],
  },
];

/** Does a webhook subscription pattern (`*`, `issue.*`, `issue.created`) match an event type? */
export function webhookEventMatches(patterns: readonly string[], type: string): boolean {
  return patterns.some(
    (p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))),
  );
}

// ───────────────────────────── Snapshot ─────────────────────────────

/**
 * `?comments=` on GET /snapshot. `index` (default) returns `comments: []` plus `commentIndex`;
 * `full` explicitly inlines every comment for MCP/CLI consumers that require complete history.
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
  projects: Project[];
  milestones: Milestone[];
  /** Tasks. The field name stays `issues`; public routes are `/tasks`. */
  issues: Issue[];
  artifacts: Artifact[];
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
  entity:
    | SubjectType
    | 'comment'
    | 'view'
    | 'membership'
    | 'invite'
    | 'favorite'
    | 'notification'
    | 'agent'
    | 'integration'
    | 'workspace'
    | 'webhook';
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
export const IMPORT_STATUSES: ImportStatus[] = [
  'queued',
  'running',
  'completed',
  'failed',
  'canceled',
];
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

/**
   * The editable mapping from the tracker's entities to Trama's. Keys are the preview's ids.
   * `teams` is Linear team ids only. Trama has no teams.
   */
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
export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  includeComments: false,
  includeClosed: true,
  defaultKind: 'feature',
};

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

// ───────────────────────────── Routing rules ─────────────────────────────

/**
 * A routing rule belongs to one project and says that work from one external source arrives there,
 * read through one connection. Per project, not a workspace-wide catalogue of repositories (NON-GOALS #15).
 * A source is provider + host + path, and a workspace routes it to one project: a second rule for the
 * same source with overlapping filters is rejected, otherwise tasks would arrive twice.
 */
export type RoutingDirection = 'inbound' | 'two_way';
export const ROUTING_DIRECTIONS: RoutingDirection[] = ['inbound', 'two_way'];

/** What a source can do today. Providers missing here are not offered. */
export const ROUTING_PROVIDER_SUPPORT: Record<
  GitProvider,
  { issues: boolean; pullRequests: boolean; twoWay: boolean }
> = {
  github: { issues: true, pullRequests: true, twoWay: true },
  gitlab: { issues: true, pullRequests: true, twoWay: true },
  bitbucket: { issues: false, pullRequests: true, twoWay: false },
};

/** Narrows which items of the source a rule takes. Every set filter must match. */
export interface RoutingFilters {
  /** The item must carry all of these labels (case-insensitive). */
  labels?: string[];
  /** The item's milestone title (case-insensitive). */
  milestone?: string;
}

export const ROUTING_SOURCE_PATH_MAX = 300;
export const ROUTING_FILTER_LABELS_MAX = 10;
export const ROUTING_FILTER_VALUE_MAX = 100;

/** `repo` is one repository; `group` ends with `/*` and means everything under that owner or group. */
export type RoutingSourceKind = 'repo' | 'group';
export function routingSourceKind(sourcePath: string): RoutingSourceKind {
  return sourcePath.endsWith('/*') ? 'group' : 'repo';
}

/** Chips for a rule's filters: `label = bug`, `milestone = v1.2`. */
export function routingFilterChips(filters: RoutingFilters | undefined | null): string[] {
  const out: string[] = [];
  for (const label of filters?.labels ?? []) out.push(`label = ${label}`);
  if (filters?.milestone) out.push(`milestone = ${filters.milestone}`);
  return out;
}

/** The connection a rule reads through, as people see it. Never carries credentials. */
export interface RoutingRuleConnection {
  id: ID;
  provider: GitProvider;
  /** Display name, e.g. "GitHub · Acme". */
  label: string;
  ownerType: 'workspace' | 'user';
  /** Name of the person for a personal connection. */
  ownerName?: string;
  /** True when the caller owns it. */
  mine?: boolean;
}

export type RoutingRuleHealth = 'ok' | 'error';

export interface RoutingRule {
  /** `rr_…` */
  id: ID;
  workspaceId: ID;
  projectId: ID;
  /** Absent when the connection was removed. */
  connectionId?: ID;
  provider: GitProvider;
  /** Lower-case host, e.g. `github.com`. */
  host: string;
  /** `owner/name`, or a group path ending with `/*`. */
  sourcePath: string;
  filters: RoutingFilters;
  direction: RoutingDirection;
  connection?: RoutingRuleConnection;
  health: RoutingRuleHealth;
  /** Why the rule is failing (revoked or removed connection, last sync error). */
  healthReason?: string;
  lastSyncAt?: ISODate;
  lastError?: string;
  /** Tasks and placed pull requests this rule created. */
  taskCount: number;
  /** The `Project.repository` value this rule was created from. */
  migratedFrom?: string;
  createdBy: ActorRef;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface RoutingRuleStats {
  /** Tasks created by this project's rules in the last 7 days. */
  tasksArrived: number;
  /** Pull requests without a task key that a rule placed here in the last 7 days. */
  unmatchedPlaced: number;
  rulesFailing: number;
}

export interface RoutingRulesOverview {
  rules: RoutingRule[];
  stats: RoutingRuleStats;
  /** Whether the caller may add, change and remove rules here. */
  canManage: boolean;
}

/** A connection the caller may read through for a rule. */
export interface RoutingConnectionOption extends RoutingRuleConnection {
  account: string;
  /** The workspace connection is suggested: it keeps working when people leave. */
  suggested: boolean;
  healthy: boolean;
}

export type RoutingSuggestionStatus = 'available' | 'this_project' | 'other_project';

export interface RoutingSourceSuggestion {
  sourcePath: string;
  url?: string;
  private?: boolean;
  status: RoutingSuggestionStatus;
  /** The project that already receives it. */
  projectId?: ID;
  projectName?: string;
}

export interface RoutingSuggestions {
  items: RoutingSourceSuggestion[];
  /** Set when the provider could not be read (revoked token, unreachable). */
  error?: string;
}
