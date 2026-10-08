// NablaStore — the client-side copy of the current workspace (WorkspaceSnapshot) in signals,
// with lookup selectors and optimistic mutations. See ../CONTRACT.md for the full API.
//
// Write model
//  - updates/deletes/dismissals are OPTIMISTIC (applied locally at once, rolled back on error);
//  - creates wait for the server (ids, keys and derived fields are server-assigned) and then
//    insert the returned entity;
//  - all writes go through one serial queue, so edits apply on the server in call order;
//  - after writes settle the snapshot is re-fetched (debounced) because the server derives
//    status + attention; unchanged entities keep their object identity;
//  - mutation methods NEVER reject: they toast on failure and resolve `undefined` / `false`.
import { Injectable, computed, inject, signal, type WritableSignal } from '@angular/core';
import { ApiClient } from '../api/api-client';
import { ApiError } from '../api/api-error';
import type {
  AddMemberInput,
  CreateAgentInput,
  CreateArtifactInput,
  CreateDecisionInput,
  CreateDependencyInput,
  CreateInputRequestInput,
  CreateIssueInput,
  CreateMilestoneInput,
  UpdateMilestoneInput,
  CreateIntegrationInput,
  IntegrationDetail,
  IntegrationWithWebhook,
  LinkRepositoryInput,
  RemoteRepositoryPage,
  UpdateIntegrationInput,
  CreateProjectInput,
  CreateRepositoryInput,
  CreateTeamInput,
  CreateTokenInput,
  CreatedToken,
  CreateWebhookInput,
  UpdateWebhookInput,
  UpdateWorkspaceSettingsInput,
  WebhookWithSecret,
  CreateViewInput,
  CreateWorkstreamInput,
  CriterionInput,
  CriterionPatch,
  EventsQuery,
  LinkIssueInput,
  UpdateAgentInput,
  UpdateArtifactInput,
  UpdateDecisionInput,
  UpdateInputRequestInput,
  UpdateIssueInput,
  UpdateProjectInput,
  UpdateRepositoryInput,
  UpdateTeamInput,
  UpdateViewInput,
  UpdateWorkstreamInput,
} from '../api/api.types';
import type {
  AcceptanceCriterion,
  ActorRef,
  ActorType,
  Agent,
  ApiToken,
  Artifact,
  AttentionItem,
  AttentionKind,
  Comment,
  Decision,
  Dependency,
  DomainEvent,
  ExecutionProvider,
  ID,
  InputRequest,
  Issue,
  IssueKind,
  IntegrationConnection,
  Membership,
  Milestone,
  OutgoingWebhook,
  Project,
  Repository,
  Role,
  SavedView,
  SubjectRef,
  Team,
  User,
  WebhookDeliveryLog,
  Workspace,
  WorkspaceSettings,
  WorkspaceSnapshot,
  Workstream,
} from '../contracts/domain';
import type { Capability } from '../contracts/domain';
import { resolveWorkspaceSettings, roleAtLeast } from '../contracts/domain';
import { setDisplayTimeZone } from '../format';
import { ATTENTION_KINDS, SEVERITY_ORDER } from '../meta';
import { Notifier } from '../notify/notifier';
import { reconcileList, reconcileOne } from '../sync/reconcile';
import { SyncStatus } from '../sync/sync-status';

type Row = { id: string };
type Rec = Record<string, unknown>;

export type LoadResult = 'ok' | 'not-found' | 'error';
export type StoreStatus = 'idle' | 'loading' | 'ready' | 'error';

/** An actor (user / agent / team / system) resolved to display data. */
export interface ResolvedActor {
  type: ActorType;
  id?: ID;
  name: string;
  /** Users: avatar hue. */
  hue?: number;
  /** Teams: team colour. */
  color?: string;
  /** Teams: key (AUTH). Agents: provider. */
  key?: string;
  provider?: Exclude<ExecutionProvider, 'human'>;
  known: boolean;
}

export interface MemberRow {
  membership: Membership;
  user: User;
}

const REFETCH_DEBOUNCE_MS = 400;

function newest<T extends { at: string }>(a: T, b: T): number {
  return b.at < a.at ? -1 : b.at > a.at ? 1 : 0;
}

function bySortOrder(a: { sortOrder: number }, b: { sortOrder: number }): number {
  return a.sortOrder - b.sortOrder;
}

function groupBy<T, K>(list: readonly T[], keyOf: (item: T) => K | K[] | undefined): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of list) {
    const key = keyOf(item);
    if (key === undefined) continue;
    for (const k of Array.isArray(key) ? key : [key]) {
      const bucket = map.get(k);
      if (bucket) bucket.push(item);
      else map.set(k, [item]);
    }
  }
  return map;
}

function indexById<T extends Row>(list: readonly T[]): Map<string, T> {
  return new Map(list.map((x) => [x.id, x]));
}

/** Apply a PATCH-style body locally: `null` clears the field, `undefined` is ignored. */
function applyPatch<T>(entity: T, patch: object): T {
  const out = { ...(entity as Rec) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

const subjectKey = (type: string, id: string) => `${type}:${id}`;

@Injectable({ providedIn: 'root' })
export class NablaStore {
  private readonly api = inject(ApiClient);
  private readonly notifier = inject(Notifier);
  private readonly sync = inject(SyncStatus);

  // ─────────────────────────── meta ───────────────────────────

  /** Slug of the workspace currently loaded (or loading). */
  readonly slug = signal<string | null>(null);
  readonly status = signal<StoreStatus>('idle');
  readonly ready = computed(() => this.status() === 'ready');
  readonly loadError = signal<ApiError | null>(null);

  private readonly _workspace = signal<Workspace | null>(null);
  private readonly _me = signal<User | null>(null);
  private readonly _myRole = signal<Role | null>(null);
  readonly workspace = this._workspace.asReadonly();
  readonly me = this._me.asReadonly();
  readonly myRole = this._myRole.asReadonly();

  // ─────────────────────────── collections (one signal each) ───────────────────────────

  private readonly _users = signal<readonly User[]>([]);
  private readonly _memberships = signal<readonly Membership[]>([]);
  private readonly _agents = signal<readonly Agent[]>([]);
  private readonly _teams = signal<readonly Team[]>([]);
  private readonly _repositories = signal<readonly Repository[]>([]);
  private readonly _projects = signal<readonly Project[]>([]);
  private readonly _workstreams = signal<readonly Workstream[]>([]);
  private readonly _milestones = signal<readonly Milestone[]>([]);
  private readonly _inputRequests = signal<readonly InputRequest[]>([]);
  private readonly _issues = signal<readonly Issue[]>([]);
  private readonly _artifacts = signal<readonly Artifact[]>([]);
  private readonly _decisions = signal<readonly Decision[]>([]);
  private readonly _dependencies = signal<readonly Dependency[]>([]);
  private readonly _comments = signal<readonly Comment[]>([]);
  private readonly _events = signal<readonly DomainEvent[]>([]);
  private readonly _attention = signal<readonly AttentionItem[]>([]);
  private readonly _views = signal<readonly SavedView[]>([]);
  private readonly _integrations = signal<readonly IntegrationConnection[]>([]);
  private readonly _tokens = signal<readonly ApiToken[]>([]);

  readonly users = this._users.asReadonly();
  readonly memberships = this._memberships.asReadonly();
  readonly agents = this._agents.asReadonly();
  readonly teams = this._teams.asReadonly();
  readonly repositories = this._repositories.asReadonly();
  readonly projects = this._projects.asReadonly();
  readonly workstreams = this._workstreams.asReadonly();
  /** All milestones, ordered by workstream then `sortOrder`. */
  readonly milestones = this._milestones.asReadonly();
  readonly inputRequests = this._inputRequests.asReadonly();
  readonly issues = this._issues.asReadonly();
  readonly artifacts = this._artifacts.asReadonly();
  readonly decisions = this._decisions.asReadonly();
  readonly dependencies = this._dependencies.asReadonly();
  readonly comments = this._comments.asReadonly();
  /** Newest first. */
  readonly events = this._events.asReadonly();
  /** All attention items for me (open, snoozed and dismissed). */
  readonly attention = this._attention.asReadonly();
  readonly views = this._views.asReadonly();
  readonly integrations = this._integrations.asReadonly();
  /** Loaded on demand by `loadTokens()` (not part of the snapshot). */
  readonly tokens = this._tokens.asReadonly();

  // ─────────────────────────── lookups ───────────────────────────

  readonly userById = computed(() => indexById(this._users()));
  readonly agentById = computed(() => indexById(this._agents()));
  readonly teamById = computed(() => indexById(this._teams()));
  readonly teamByKey = computed(() => new Map(this._teams().map((t) => [t.key.toUpperCase(), t])));
  readonly repositoryById = computed(() => indexById(this._repositories()));
  readonly projectById = computed(() => indexById(this._projects()));
  readonly workstreamById = computed(() => indexById(this._workstreams()));
  /** Keyed by upper-case key (`AUTH-42`). */
  readonly workstreamByKey = computed(
    () => new Map(this._workstreams().map((w) => [w.key.toUpperCase(), w])),
  );
  readonly inputRequestById = computed(() => indexById(this._inputRequests()));
  readonly issueById = computed(() => indexById(this._issues()));
  /** Upper-case current key (`BUG-142`) or alias (an old key from before a kind change) → issue. */
  readonly issueByKey = computed(() => {
    const map = new Map<string, Issue>();
    for (const i of this._issues()) for (const a of i.aliases ?? []) map.set(a.toUpperCase(), i);
    for (const i of this._issues()) map.set(i.key.toUpperCase(), i);
    return map;
  });
  readonly milestoneById = computed(() => indexById(this._milestones()));
  readonly artifactById = computed(() => indexById(this._artifacts()));
  readonly decisionById = computed(() => indexById(this._decisions()));
  readonly decisionByKey = computed(
    () => new Map(this._decisions().map((d) => [d.key.toUpperCase(), d])),
  );
  readonly viewById = computed(() => indexById(this._views()));
  readonly integrationById = computed(() => indexById(this._integrations()));
  readonly membershipByUserId = computed(
    () => new Map(this._memberships().map((m) => [m.userId, m])),
  );

  /** Memberships joined with their users (settings → members). */
  readonly members = computed<MemberRow[]>(() => {
    const users = this.userById();
    const rows: MemberRow[] = [];
    for (const membership of this._memberships()) {
      const user = users.get(membership.userId);
      if (user) rows.push({ membership, user });
    }
    return rows.sort((a, b) => a.user.name.localeCompare(b.user.name));
  });

  readonly inputRequestsByWorkstream = computed(() =>
    groupBy(this._inputRequests(), (r) => r.workstreamId),
  );
  /** Open input requests, newest first. */
  readonly openInputRequests = computed(() =>
    this._inputRequests()
      .filter((r) => r.state === 'open')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
  );
  readonly artifactsByWorkstream = computed(() =>
    groupBy(this._artifacts(), (a) => a.workstreamId),
  );
  readonly artifactsByRepository = computed(() =>
    groupBy(this._artifacts(), (a) => a.repositoryId),
  );
  /** Decisions that originate from, or are related to, a workstream. */
  readonly decisionsByWorkstream = computed(() =>
    groupBy(this._decisions(), (d) => {
      const ids = new Set(d.relatedWorkstreamIds);
      if (d.originWorkstreamId) ids.add(d.originWorkstreamId);
      return [...ids];
    }),
  );
  readonly issuesByWorkstream = computed(() =>
    groupBy(this._issues(), (i) => (i.workstreamIds.length ? i.workstreamIds : undefined)),
  );
  /** Milestones of a project (by project id), ordered by `sortOrder`. */
  readonly milestonesByProject = computed(() => {
    const map = groupBy(this._milestones(), (m) => m.projectId);
    for (const list of map.values()) list.sort(bySortOrder);
    return map;
  });
  /** The milestones a workstream shares through its project (by workstream id). Workstreams without a project have none. */
  readonly milestonesByWorkstream = computed(() => {
    const byProject = this.milestonesByProject();
    const map = new Map<string, Milestone[]>();
    for (const w of this._workstreams()) {
      const list = w.projectId ? byProject.get(w.projectId) : undefined;
      if (list?.length) map.set(w.id, list);
    }
    return map;
  });
  /** Issues linked to any workstream of a project (by project id). */
  readonly issuesByProject = computed(() => {
    const projectOf = new Map(this._workstreams().map((w) => [w.id, w.projectId]));
    return groupBy(this._issues(), (i) => {
      const ids = new Set<string>();
      for (const w of i.workstreamIds) {
        const p = projectOf.get(w);
        if (p) ids.add(p);
      }
      return ids.size ? [...ids] : undefined;
    });
  });
  /** Issues in a milestone (by milestone id). */
  readonly issuesByMilestone = computed(() =>
    groupBy(this._issues(), (i) => (i.milestoneIds?.length ? i.milestoneIds : undefined)),
  );
  readonly issuesByTeam = computed(() => groupBy(this._issues(), (i) => i.teamId));
  /** Workstreams owned by a team (by team id). */
  readonly workstreamsByOwnerTeam = computed(() =>
    groupBy(this._workstreams(), (w) => w.ownerTeamId),
  );
  /** Workstreams a team participates in, excluding ones it owns (by team id). */
  readonly workstreamsByParticipatingTeam = computed(() =>
    groupBy(this._workstreams(), (w) => w.participatingTeamIds),
  );
  readonly workstreamsByProject = computed(() =>
    groupBy(this._workstreams(), (w) => w.projectId),
  );
  readonly workstreamsByRepository = computed(() =>
    groupBy(this._workstreams(), (w) => w.repositoryIds),
  );
  /** Dependencies pointing AT a node (what blocks it), keyed by node id (workstream or execution). */
  readonly incomingDependencies = computed(() => groupBy(this._dependencies(), (d) => d.toId));
  /** Dependencies leaving a node (what it blocks), keyed by node id. */
  readonly outgoingDependencies = computed(() => groupBy(this._dependencies(), (d) => d.fromId));
  /** Comments by `type:id` (e.g. `workstream:ws_1`), oldest first. */
  readonly commentsBySubject = computed(() => {
    const map = groupBy(this._comments(), (c) => subjectKey(c.subject.type, c.subject.id));
    for (const list of map.values()) list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return map;
  });
  /** Events by workstream id, newest first. */
  readonly eventsByWorkstream = computed(() => {
    const map = groupBy(this._events(), (e) => e.workstreamId);
    for (const list of map.values()) list.sort(newest);
    return map;
  });
  /** Events by `type:id` of their subject, newest first. */
  readonly eventsBySubject = computed(() => {
    const map = groupBy(this._events(), (e) => subjectKey(e.subject.type, e.subject.id));
    for (const list of map.values()) list.sort(newest);
    return map;
  });

  // ─────────────────────────── me / attention ───────────────────────────

  /** Teams I'm a member of. */
  readonly myTeams = computed(() => {
    const id = this._me()?.id;
    return id ? this._teams().filter((t) => t.memberIds.includes(id)) : [];
  });
  readonly myTeamIds = computed(() => new Set(this.myTeams().map((t) => t.id)));
  /** Workstreams I'm accountable for. */
  readonly myWorkstreams = computed(() => {
    const id = this._me()?.id;
    return id ? this._workstreams().filter((w) => w.accountableUserId === id) : [];
  });

  /** Open attention items, severity then newest first. */
  readonly openAttention = computed(() =>
    this._attention()
      .filter((a) => a.state === 'open')
      .sort(
        (a, b) =>
          SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
          (a.since < b.since ? 1 : a.since > b.since ? -1 : 0),
      ),
  );
  readonly snoozedAttention = computed(() => this._attention().filter((a) => a.state === 'snoozed'));
  /** Open attention items grouped by kind (only kinds that have items). */
  readonly attentionByKind = computed(() => groupBy(this.openAttention(), (a) => a.kind));
  /** Open attention count per kind (0 for kinds without items). */
  readonly attentionCounts = computed(() => {
    const counts = Object.fromEntries(ATTENTION_KINDS.map((k) => [k, 0])) as Record<
      AttentionKind,
      number
    >;
    for (const item of this.openAttention()) counts[item.kind]++;
    return counts;
  });
  /** Total open attention items (sidebar badge). */
  readonly attentionCount = computed(() => this.openAttention().length);
  readonly highAttentionCount = computed(
    () => this.openAttention().filter((a) => a.severity === 'high').length,
  );
  /** Issues still in the backlog (unscheduled demand). */
  readonly backlogIssues = computed(() => this._issues().filter((i) => i.status === 'backlog'));
  readonly backlogIssueCount = computed(() => this.backlogIssues().length);

  // ─────────────────────────── actor resolution ───────────────────────────

  /** Everything that can perform work or be assigned: users, agents, teams. */
  readonly actors = computed<ResolvedActor[]>(() => [
    ...this._users().map((u) => this.resolveActor({ type: 'user', id: u.id })),
    ...this._agents().map((a) => this.resolveActor({ type: 'agent', id: a.id })),
    ...this._teams().map((t) => this.resolveActor({ type: 'team', id: t.id })),
  ]);

  resolveActor(ref: ActorRef | null | undefined): ResolvedActor {
    if (!ref) return { type: 'system', name: 'Trama', known: false };
    switch (ref.type) {
      case 'user': {
        const u = ref.id ? this.userById().get(ref.id) : undefined;
        return { type: 'user', id: ref.id, name: u?.name ?? 'Unknown user', hue: u?.avatarHue, known: !!u };
      }
      case 'agent': {
        const a = ref.id ? this.agentById().get(ref.id) : undefined;
        return { type: 'agent', id: ref.id, name: a?.name ?? 'Unknown agent', provider: a?.provider, known: !!a };
      }
      case 'team': {
        const t = ref.id ? this.teamById().get(ref.id) : undefined;
        return { type: 'team', id: ref.id, name: t?.name ?? 'Unknown team', color: t?.color, key: t?.key, known: !!t };
      }
      default:
        return { type: 'system', name: 'Trama', known: true };
    }
  }

  actorName(ref: ActorRef | null | undefined): string {
    return this.resolveActor(ref).name;
  }

  /** Build an ActorRef for a user id (e.g. the current user). */
  userRef(id: ID): ActorRef {
    return { type: 'user', id };
  }

  // ─────────────────────────── point lookups (id or key) ───────────────────────────

  /** By id or key (`AUTH-42`, case-insensitive). */
  getWorkstream(ref: string | null | undefined): Workstream | undefined {
    if (!ref) return undefined;
    return this.workstreamById().get(ref) ?? this.workstreamByKey().get(ref.toUpperCase());
  }
  /** By id, key (`BUG-142`) or alias (an old key from before a kind change). */
  getIssue(ref: string | null | undefined): Issue | undefined {
    if (!ref) return undefined;
    return this.issueById().get(ref) ?? this.issueByKey().get(ref.toUpperCase());
  }
  getMilestone(id: string | null | undefined): Milestone | undefined {
    return id ? this.milestoneById().get(id) : undefined;
  }
  /** By id or key (`ADR-7`). */
  getDecision(ref: string | null | undefined): Decision | undefined {
    if (!ref) return undefined;
    return this.decisionById().get(ref) ?? this.decisionByKey().get(ref.toUpperCase());
  }
  /** By id or key (`AUTH`). */
  getTeam(ref: string | null | undefined): Team | undefined {
    if (!ref) return undefined;
    return this.teamById().get(ref) ?? this.teamByKey().get(ref.toUpperCase());
  }
  getProject(id: string | null | undefined): Project | undefined {
    return id ? this.projectById().get(id) : undefined;
  }

  getRepository(id: string | null | undefined): Repository | undefined {
    return id ? this.repositoryById().get(id) : undefined;
  }
  getUser(id: string | null | undefined): User | undefined {
    return id ? this.userById().get(id) : undefined;
  }
  getArtifact(id: string | null | undefined): Artifact | undefined {
    return id ? this.artifactById().get(id) : undefined;
  }
  getView(id: string | null | undefined): SavedView | undefined {
    return id ? this.viewById().get(id) : undefined;
  }
  /** Comments on a subject, oldest first. */
  commentsFor(subject: SubjectRef): readonly Comment[] {
    return this.commentsBySubject().get(subjectKey(subject.type, subject.id)) ?? [];
  }
  /** Whether the current user may act at `minRole` or above. */
  can(minRole: Role): boolean {
    const order: Role[] = ['viewer', 'member', 'admin', 'owner'];
    const mine = this._myRole();
    return !!mine && order.indexOf(mine) >= order.indexOf(minRole);
  }

  /** Workspace settings with the defaults applied (permission policy, estimate scale, week start, time zone…). */
  readonly settings = computed<WorkspaceSettings>(() => resolveWorkspaceSettings(this._workspace()?.settings));
  /** Scale used by the estimate pickers (`estimateOptions(scale)` in core/estimates.ts). */
  readonly estimateScale = computed(() => this.settings().estimateScale);
  /** Whether workstreams are linked to a Delta thread (workspace setting, on by default). */
  readonly deltaThreads = computed(() => this.settings().deltaThreads !== false);
  /** IANA zone to display dates in, or `undefined` to follow the browser. */
  readonly timeZone = computed(() => {
    const tz = this.settings().timeZone;
    return tz && tz !== 'auto' ? tz : undefined;
  });

  /** First day of the week for calendars (0 = Sunday, 1 = Monday, 6 = Saturday). */
  readonly weekStartsOn = computed<0 | 1 | 6>(() => ({ monday: 1, sunday: 0, saturday: 6 }) [this.settings().weekStart] as 0 | 1 | 6);

  /** Whether my role satisfies a capability of the workspace permission policy (Settings → Roles & permissions). */
  allowed(capability: Capability): boolean {
    const mine = this._myRole();
    return !!mine && roleAtLeast(mine, this.settings().permissions[capability]);
  }

  /** Am I a lead of this team? */
  isTeamLead(teamId: ID | null | undefined): boolean {
    const me = this._me()?.id;
    const team = teamId ? this.teamById().get(teamId) : undefined;
    return !!me && !!team && team.leadIds.includes(me);
  }

  /**
   * May I edit workstreams / issues owned by this team? Workspace role first (member+), then the team's
   * edit policy: with `members`, only team members, leads and admins. No team = no restriction.
   */
  canEditTeamWork(teamId: ID | null | undefined): boolean {
    if (!this.can('member')) return false;
    const team = teamId ? this.teamById().get(teamId) : undefined;
    if (!team || team.editPolicy !== 'members' || this.can('admin')) return true;
    const me = this._me()?.id;
    return !!me && (team.memberIds.includes(me) || team.leadIds.includes(me));
  }

  // ─────────────────────────── loading ───────────────────────────

  private loading: { slug: string; promise: Promise<LoadResult> } | null = null;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped when a write starts and when it settles; a refetch started before is stale. */
  private epoch = 0;
  private pending = 0;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * Load the snapshot for `slug` (no-op refresh if already loaded). Resolves:
   * `ok`, `not-found` (404/403: no such workspace / not a member) or `error`.
   */
  load(slug: string): Promise<LoadResult> {
    if (this.loading?.slug === slug) return this.loading.promise;
    if (this.slug() === slug && this.status() === 'ready') {
      this.scheduleRefetch(0);
      return Promise.resolve('ok');
    }
    this.reset();
    this.slug.set(slug);
    this.status.set('loading');
    const promise = this.doLoad(slug).finally(() => {
      if (this.loading?.promise === promise) this.loading = null;
    });
    this.loading = { slug, promise };
    return promise;
  }

  private async doLoad(slug: string): Promise<LoadResult> {
    try {
      const snapshot = await this.api.workspaces.snapshot(slug);
      if (this.slug() !== slug) return 'error';
      this.applySnapshot(snapshot, false);
      this.status.set('ready');
      this.loadError.set(null);
      return 'ok';
    } catch (e) {
      if (this.slug() !== slug) return 'error';
      const err = ApiError.from(e);
      this.loadError.set(err);
      this.status.set('error');
      this.sync.lastError.set(err.message);
      return err.status === 404 || err.status === 403 ? 'not-found' : 'error';
    }
  }

  /** Forget the loaded workspace (logout / workspace switch). */
  reset(): void {
    if (this.refetchTimer) clearTimeout(this.refetchTimer);
    this.refetchTimer = null;
    this.slug.set(null);
    this.status.set('idle');
    this.loadError.set(null);
    this._workspace.set(null);
    this._me.set(null);
    this._myRole.set(null);
    for (const c of [
      this._users, this._memberships, this._agents, this._teams, this._repositories, this._projects,
      this._workstreams, this._milestones, this._inputRequests, this._issues, this._artifacts,
      this._decisions, this._dependencies, this._comments, this._events, this._attention,
      this._views, this._integrations, this._tokens,
    ] as WritableSignal<readonly Row[]>[]) {
      c.set([]);
    }
    this._integrationDetails.set([]);
    this._outgoingWebhooks.set([]);
  }

  /** Re-fetch the snapshot now and merge it, preserving identity of unchanged entities. */
  async refetch(): Promise<void> {
    const slug = this.slug();
    if (!slug || this.status() === 'loading') return;
    if (this.pending > 0) return this.scheduleRefetch(REFETCH_DEBOUNCE_MS);
    const startEpoch = this.epoch;
    try {
      const snapshot = await this.api.workspaces.snapshot(slug);
      if (this.slug() !== slug) return;
      // A write started/finished meanwhile: this snapshot may predate it. Try again.
      if (this.epoch !== startEpoch || this.pending > 0) return this.scheduleRefetch(REFETCH_DEBOUNCE_MS);
      this.applySnapshot(snapshot, true);
      if (this.status() === 'error') this.status.set('ready');
    } catch (e) {
      this.sync.lastError.set(ApiError.from(e).message);
    }
  }

  /** Debounced `refetch()`; used by writes and by LiveSync. */
  scheduleRefetch(ms = REFETCH_DEBOUNCE_MS): void {
    if (this.refetchTimer) clearTimeout(this.refetchTimer);
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      void this.refetch();
    }, ms);
  }

  private applySnapshot(s: WorkspaceSnapshot, merge: boolean): void {
    const list = <T extends Row>(sig: WritableSignal<readonly T[]>, next: readonly T[]) =>
      sig.set(merge ? reconcileList(sig(), next) : next);
    this._workspace.update((p) => (merge ? reconcileOne(p, s.workspace) : s.workspace));
    setDisplayTimeZone(this.timeZone());
    this._me.update((p) => (merge ? reconcileOne(p, s.me) : s.me));
    this._myRole.set(s.myRole);
    list(this._users, s.users);
    list(this._memberships, s.memberships);
    list(this._agents, s.agents);
    list(this._teams, s.teams);
    list(this._repositories, s.repositories);
    list(this._projects, s.projects ?? []);
    list(this._workstreams, s.workstreams);
    list(this._milestones, s.milestones ?? []);
    list(this._inputRequests, s.inputRequests);
    list(this._issues, s.issues);
    list(this._artifacts, s.artifacts);
    list(this._decisions, s.decisions);
    list(this._dependencies, s.dependencies);
    list(this._comments, s.comments);
    // Events beyond the snapshot window (loaded via loadOlderEvents) are kept.
    const older = merge ? this._events().filter((e) => !s.events.some((n) => n.id === e.id)) : [];
    const oldest = s.events.reduce((m, e) => (e.at < m ? e.at : m), '9999');
    list(this._events, [...s.events, ...older.filter((e) => e.at < oldest)].sort(newest));
    list(this._attention, s.attention);
    list(this._views, s.views);
    list(this._integrations, s.integrations);
    this.sync.lastSyncedAt.set(new Date().toISOString());
    this.sync.lastError.set(null);
  }

  /** Load events older than the oldest one in memory (activity "load more"). Returns how many arrived. */
  async loadOlderEvents(query: Omit<EventsQuery, 'before'> = {}): Promise<number> {
    const slug = this.slug();
    if (!slug) return 0;
    const events = this._events();
    const before = events.length ? events[events.length - 1].at : undefined;
    try {
      const older = await this.api.events.list(slug, { limit: 100, ...query, before });
      const known = new Set(events.map((e) => e.id));
      const fresh = older.filter((e) => !known.has(e.id));
      if (fresh.length) this._events.set([...events, ...fresh].sort(newest));
      return fresh.length;
    } catch {
      return 0;
    }
  }

  // ─────────────────────────── write machinery ───────────────────────────

  private requireSlug(): string {
    const slug = this.slug();
    if (!slug) throw new ApiError(0, 'No workspace loaded');
    return slug;
  }

  private tx() {
    const undo: (() => void)[] = [];
    return {
      /** Patch an entity (PATCH semantics: null clears, undefined ignored). */
      patch: <T extends Row>(sig: WritableSignal<readonly T[]>, id: string, change: object) => {
        const prev = sig().find((x) => x.id === id);
        if (!prev) return;
        const next = applyPatch(prev, change);
        sig.update((list) => list.map((x) => (x.id === id ? next : x)));
        undo.push(() =>
          sig.update((list) =>
            list.some((x) => x.id === id) ? list.map((x) => (x.id === id ? prev : x)) : [...list, prev],
          ),
        );
      },
      remove: <T extends Row>(sig: WritableSignal<readonly T[]>, id: string) => {
        const prev = sig().find((x) => x.id === id);
        if (!prev) return;
        sig.update((list) => list.filter((x) => x.id !== id));
        undo.push(() => sig.update((list) => (list.some((x) => x.id === id) ? list : [...list, prev])));
      },
      rollback: () => {
        for (const fn of undo.reverse()) fn();
        undo.length = 0;
      },
    };
  }

  /** Insert or replace an entity (used for server responses). */
  private upsert<T extends Row>(sig: WritableSignal<readonly T[]>, entity: T): void {
    sig.update((list) => {
      const i = list.findIndex((x) => x.id === entity.id);
      if (i < 0) return [...list, entity];
      if (JSON.stringify(list[i]) === JSON.stringify(entity)) return list;
      return list.map((x, idx) => (idx === i ? entity : x));
    });
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Run a server write through the serial queue. On error: roll back the optimistic tx,
   * toast, resolve `{ ok: false }`. On settle: schedule a snapshot refetch.
   */
  private async attempt<T>(
    label: string,
    run: (slug: string) => Promise<T>,
    options: { tx?: { rollback: () => void }; onResult?: (result: T) => void } = {},
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    this.pending++;
    this.epoch++;
    this.sync.pendingWrites.set(this.pending);
    try {
      const slug = this.requireSlug();
      const value = await this.enqueue(() => run(slug));
      options.onResult?.(value);
      this.sync.lastError.set(null);
      return { ok: true, value };
    } catch (e) {
      options.tx?.rollback();
      const err = ApiError.from(e);
      this.sync.lastError.set(err.message);
      // 401 → session handling; 403 → ApiClient already toasted.
      if (err.status !== 401 && err.status !== 403) {
        this.notifier.error(`Could not ${label}`, { description: err.message });
      }
      return { ok: false };
    } finally {
      this.pending--;
      this.epoch++;
      this.sync.pendingWrites.set(this.pending);
      this.scheduleRefetch();
    }
  }

  /** Resolves the response body, or `undefined` on failure. */
  private async write<T>(
    label: string,
    run: (slug: string) => Promise<T>,
    options: { tx?: { rollback: () => void }; onResult?: (result: T) => void } = {},
  ): Promise<T | undefined> {
    const r = await this.attempt(label, run, options);
    return r.ok ? r.value : undefined;
  }

  /** Resolves `true` on success regardless of the response body. */
  private async writeOk<T>(
    label: string,
    run: (slug: string) => Promise<T>,
    options: { tx?: { rollback: () => void }; onResult?: (result: T) => void } = {},
  ): Promise<boolean> {
    return (await this.attempt(label, run, options)).ok;
  }

  /** `write` for void results: resolves `true` on success, `false` on failure. */
  private async ok(
    label: string,
    run: (slug: string) => Promise<unknown>,
    options: { tx?: { rollback: () => void } } = {},
  ): Promise<boolean> {
    return this.writeOk(label, run, options);
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  // ─────────────────────────── workstreams ───────────────────────────

  async createWorkstream(input: CreateWorkstreamInput): Promise<Workstream | undefined> {
    return this.write('create workstream', (s) => this.api.workstreams.create(s, input), {
      onResult: (w) => this.upsert(this._workstreams, w),
    });
  }

  /** `ref` = id or key. Optimistic; the server then re-derives status. */
  async updateWorkstream(ref: string, patch: UpdateWorkstreamInput): Promise<boolean> {
    const ws = this.getWorkstream(ref);
    if (!ws) return false;
    const tx = this.tx();
    tx.patch(this._workstreams, ws.id, { ...patch, updatedAt: this.nowIso() });
    return this.write('update workstream', (s) => this.api.workstreams.update(s, ws.id, patch), {
      tx,
      onResult: (w) => this.upsert(this._workstreams, w),
    }).then((r) => !!r);
  }

  async deleteWorkstream(ref: string): Promise<boolean> {
    const ws = this.getWorkstream(ref);
    if (!ws) return false;
    const tx = this.tx();
    tx.remove(this._workstreams, ws.id);
    for (const a of this._artifacts().filter((x) => x.workstreamId === ws.id)) tx.remove(this._artifacts, a.id);
    for (const r of this._inputRequests().filter((x) => x.workstreamId === ws.id)) tx.remove(this._inputRequests, r.id);
    return this.ok('delete workstream', (s) => this.api.workstreams.remove(s, ws.id), { tx });
  }

  // criteria ----------------------------------------------------------------

  /** Waits for the server (the criterion id is server-assigned). Resolves the new criterion. */
  async addCriterion(ref: string, input: CriterionInput): Promise<AcceptanceCriterion | undefined> {
    const ws = this.getWorkstream(ref);
    if (!ws) return undefined;
    const before = new Set(ws.acceptanceCriteria.map((c) => c.id));
    let created: AcceptanceCriterion | undefined;
    await this.write('add criterion', (s) => this.api.workstreams.addCriterion(s, ws.id, input), {
      onResult: (res) => {
        const r = res as Rec | null;
        if (r && Array.isArray(r['acceptanceCriteria'])) {
          this.upsert(this._workstreams, r as unknown as Workstream);
          created = (r['acceptanceCriteria'] as AcceptanceCriterion[]).find((c) => !before.has(c.id));
        } else if (r && typeof r['id'] === 'string' && typeof r['text'] === 'string') {
          created = r as unknown as AcceptanceCriterion;
          const c = created;
          this._workstreams.update((list) =>
            list.map((w) =>
              w.id === ws.id && !w.acceptanceCriteria.some((x) => x.id === c.id)
                ? { ...w, acceptanceCriteria: [...w.acceptanceCriteria, c] }
                : w,
            ),
          );
        }
      },
    });
    return created;
  }

  async updateCriterion(ref: string, criterionId: ID, patch: CriterionPatch): Promise<boolean> {
    const ws = this.getWorkstream(ref);
    if (!ws) return false;
    const tx = this.tx();
    tx.patch(this._workstreams, ws.id, {
      acceptanceCriteria: ws.acceptanceCriteria.map((c) => (c.id === criterionId ? { ...c, ...patch } : c)),
    });
    return this.ok('update criterion', (s) => this.api.workstreams.updateCriterion(s, ws.id, criterionId, patch), { tx });
  }

  async removeCriterion(ref: string, criterionId: ID): Promise<boolean> {
    const ws = this.getWorkstream(ref);
    if (!ws) return false;
    const tx = this.tx();
    tx.patch(this._workstreams, ws.id, {
      acceptanceCriteria: ws.acceptanceCriteria.filter((c) => c.id !== criterionId),
    });
    return this.ok('remove criterion', (s) => this.api.workstreams.removeCriterion(s, ws.id, criterionId), { tx });
  }

  // ─────────────────────────── input requests ───────────────────────────

  async createInputRequest(input: CreateInputRequestInput): Promise<InputRequest | undefined> {
    return this.write('request input', (s) => this.api.inputRequests.create(s, input), {
      onResult: (r) => this.upsert(this._inputRequests, r),
    });
  }

  /** Answer an open input request (also clears its attention item). */
  async answerInput(id: ID, answer: string): Promise<boolean> {
    if (!this.inputRequestById().has(id)) return false;
    const tx = this.tx();
    const now = this.nowIso();
    tx.patch(this._inputRequests, id, {
      state: 'answered',
      answer,
      answeredById: this._me()?.id,
      answeredAt: now,
    });
    this.hideAttentionWhere(tx, (a) => a.inputRequestId === id);
    return this.writeOk('answer', (s) => this.api.inputRequests.answer(s, id, answer), {
      tx,
      onResult: (r) => r && this.upsert(this._inputRequests, r),
    });
  }

  async dismissInput(id: ID): Promise<boolean> {
    if (!this.inputRequestById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._inputRequests, id, { state: 'dismissed' });
    this.hideAttentionWhere(tx, (a) => a.inputRequestId === id);
    return this.writeOk('dismiss request', (s) => this.api.inputRequests.dismiss(s, id), {
      tx,
      onResult: (r) => r && this.upsert(this._inputRequests, r),
    });
  }

  /** Edit an open input request (question / options / assignee). Optimistic. */
  async updateInputRequest(id: ID, patch: UpdateInputRequestInput): Promise<boolean> {
    if (!this.inputRequestById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._inputRequests, id, patch);
    return this.writeOk('update request', (s) => this.api.inputRequests.update(s, id, patch), {
      tx,
      onResult: (r) => r && this.upsert(this._inputRequests, r),
    });
  }

  async deleteInputRequest(id: ID): Promise<boolean> {
    if (!this.inputRequestById().has(id)) return false;
    const tx = this.tx();
    tx.remove(this._inputRequests, id);
    this.hideAttentionWhere(tx, (a) => a.inputRequestId === id);
    return this.ok('delete request', (s) => this.api.inputRequests.remove(s, id), { tx });
  }

  private hideAttentionWhere(tx: ReturnType<NablaStore['tx']>, test: (a: AttentionItem) => boolean): void {
    for (const a of this._attention().filter(test)) tx.patch(this._attention, a.id, { state: 'dismissed' });
  }

  // ─────────────────────────── issues ───────────────────────────

  async createIssue(input: CreateIssueInput): Promise<Issue | undefined> {
    return this.write('create issue', (s) => this.api.issues.create(s, input), {
      onResult: (i) => this.upsert(this._issues, i),
    });
  }

  /**
   * Optimistic, except `kind`: changing it re-keys the issue, so the server's answer (new `key`,
   * old key in `aliases`) is applied when it arrives. Unlinking a workstream also drops that
   * workstream's milestone locally.
   */
  async updateIssue(id: ID, patch: UpdateIssueInput): Promise<boolean> {
    return !!(await this.patchIssue(id, patch));
  }

  /** Change the kind (re-keys the issue). Resolves the updated issue (new key) or `undefined`. */
  async changeIssueKind(id: ID, kind: IssueKind): Promise<Issue | undefined> {
    const current = this.issueById().get(id);
    if (!current || current.kind === kind) return current;
    return this.patchIssue(id, { kind });
  }

  private async patchIssue(id: ID, patch: UpdateIssueInput): Promise<Issue | undefined> {
    const current = this.issueById().get(id);
    if (!current) return undefined;
    const { kind: _kind, ...local } = patch;
    const optimistic: Record<string, unknown> = { ...local, updatedAt: this.nowIso() };
    if (patch.workstreamIds && patch.milestoneIds === undefined) {
      const projects = new Set(
        patch.workstreamIds.map((w) => this.workstreamById().get(w)?.projectId).filter((p): p is string => !!p),
      );
      optimistic['milestoneIds'] = (current.milestoneIds ?? []).filter((m) => {
        const ms = this._milestones().find((x) => x.id === m);
        return !!ms && projects.has(ms.projectId);
      });
    }
    const tx = this.tx();
    tx.patch(this._issues, id, optimistic);
    return this.write('update issue', (s) => this.api.issues.update(s, id, patch), {
      tx,
      onResult: (i) => this.upsert(this._issues, i),
    });
  }

  async deleteIssue(id: ID): Promise<boolean> {
    if (!this.issueById().has(id)) return false;
    const tx = this.tx();
    tx.remove(this._issues, id);
    return this.ok('delete issue', (s) => this.api.issues.remove(s, id), { tx });
  }

  /**
   * Attach the issue to existing workstreams and/or a new one (`createWorkstream`).
   * Backlog and todo issues move to `in_progress` unless `status` is set. The created
   * workstream arrives with the next refetch (`issue.workstreamIds`).
   */
  async linkIssue(id: ID, input: LinkIssueInput): Promise<Issue | undefined> {
    const current = this.issueById().get(id);
    if (!current) return undefined;
    const tx = this.tx();
    const status = input.status ?? (current.status === 'backlog' || current.status === 'todo' ? 'in_progress' : current.status);
    tx.patch(this._issues, id, {
      status,
      ...(input.workstreamIds ? { workstreamIds: [...new Set([...current.workstreamIds, ...input.workstreamIds])] } : {}),
    });
    this.hideAttentionWhere(tx, (a) => a.issueId === id);
    return this.write('link issue', (s) => this.api.issues.link(s, id, input), {
      tx,
      onResult: (item) => {
        if (item) this.upsert(this._issues, item);
      },
    }).then((res) => {
      if (res === undefined) return undefined;
      return this.issueById().get(id);
    });
  }

  // ─────────────────────────── milestones ───────────────────────────

  /** Waits for the server (`ms_…` id). `sortOrder` defaults to last in the workstream. */
  async createMilestone(input: CreateMilestoneInput): Promise<Milestone | undefined> {
    return this.write('create milestone', (s) => this.api.milestones.create(s, input), {
      onResult: (m) => this.upsert(this._milestones, m),
    });
  }

  async updateMilestone(id: ID, patch: UpdateMilestoneInput): Promise<boolean> {
    if (!this.milestoneById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._milestones, id, { ...patch, updatedAt: this.nowIso() });
    return this.write('update milestone', (s) => this.api.milestones.update(s, id, patch), {
      tx,
      onResult: (m) => this.upsert(this._milestones, m),
    }).then((r) => !!r);
  }

  /** Also removes the milestone from the issues that were in it. */
  async deleteMilestone(id: ID): Promise<boolean> {
    if (!this.milestoneById().has(id)) return false;
    const tx = this.tx();
    this.dropMilestones(tx, [id]);
    return this.ok('delete milestone', (s) => this.api.milestones.remove(s, id), { tx });
  }

  /**
   * Put the milestones of a project in this order (`ids`; unlisted ones follow). Optimistic;
   * the server re-numbers `sortOrder` to 0..n-1.
   */
  async reorderMilestones(projectId: ID, ids: readonly ID[]): Promise<boolean> {
    const current = this.milestonesByProject().get(projectId) ?? [];
    const known = new Set(current.map((m) => m.id));
    const order = [...new Set(ids)].filter((id) => known.has(id));
    for (const m of current) if (!order.includes(m.id)) order.push(m.id);
    const tx = this.tx();
    order.forEach((id, i) => {
      if (this.milestoneById().get(id)?.sortOrder !== i) tx.patch(this._milestones, id, { sortOrder: i });
    });
    return this.write('reorder milestones', (s) => this.api.milestones.reorder(s, projectId, order), {
      tx,
      onResult: (list) => {
        for (const m of list) this.upsert(this._milestones, m);
      },
    }).then((r) => !!r);
  }

  private dropMilestones(tx: ReturnType<NablaStore['tx']>, ids: readonly ID[]): void {
    if (!ids.length) return;
    const gone = new Set(ids);
    for (const i of this._issues().filter((x) => x.milestoneIds?.some((m) => gone.has(m))))
      tx.patch(this._issues, i.id, { milestoneIds: i.milestoneIds.filter((m) => !gone.has(m)) });
    for (const id of ids) tx.remove(this._milestones, id);
  }

  // ─────────────────────────── artifacts ───────────────────────────

  async attachArtifact(input: CreateArtifactInput): Promise<Artifact | undefined> {
    return this.write('attach artifact', (s) => this.api.artifacts.create(s, input), {
      onResult: (a) => this.upsert(this._artifacts, a),
    });
  }

  async updateArtifact(id: ID, patch: UpdateArtifactInput): Promise<boolean> {
    if (!this.artifactById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._artifacts, id, { ...patch, updatedAt: this.nowIso() });
    return this.write('update artifact', (s) => this.api.artifacts.update(s, id, patch), {
      tx,
      onResult: (a) => this.upsert(this._artifacts, a),
    }).then((r) => !!r);
  }

  async removeArtifact(id: ID): Promise<boolean> {
    if (!this.artifactById().has(id)) return false;
    const tx = this.tx();
    tx.remove(this._artifacts, id);
    return this.ok('remove artifact', (s) => this.api.artifacts.remove(s, id), { tx });
  }

  // ─────────────────────────── decisions ───────────────────────────

  /** Propose (default) or directly record (`status: 'accepted'`) a decision. */
  async proposeDecision(input: CreateDecisionInput): Promise<Decision | undefined> {
    return this.write('propose decision', (s) => this.api.decisions.create(s, input), {
      onResult: (d) => this.upsert(this._decisions, d),
    });
  }

  async updateDecision(id: ID, patch: UpdateDecisionInput): Promise<boolean> {
    if (!this.decisionById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._decisions, id, { ...patch, updatedAt: this.nowIso() });
    return this.write('update decision', (s) => this.api.decisions.update(s, id, patch), {
      tx,
      onResult: (d) => this.upsert(this._decisions, d),
    }).then((r) => !!r);
  }

  async acceptDecision(id: ID): Promise<boolean> {
    if (!this.decisionById().has(id)) return false;
    const now = this.nowIso();
    const tx = this.tx();
    tx.patch(this._decisions, id, { status: 'accepted', decidedById: this._me()?.id, decidedAt: now, updatedAt: now });
    this.hideAttentionWhere(tx, (a) => a.decisionId === id);
    return this.writeOk('accept decision', (s) => this.api.decisions.accept(s, id), {
      tx,
      onResult: (d) => d && this.upsert(this._decisions, d),
    });
  }

  async rejectDecision(id: ID): Promise<boolean> {
    if (!this.decisionById().has(id)) return false;
    const now = this.nowIso();
    const tx = this.tx();
    tx.patch(this._decisions, id, { status: 'rejected', decidedById: this._me()?.id, decidedAt: now, updatedAt: now });
    this.hideAttentionWhere(tx, (a) => a.decisionId === id);
    return this.writeOk('reject decision', (s) => this.api.decisions.reject(s, id), {
      tx,
      onResult: (d) => d && this.upsert(this._decisions, d),
    });
  }

  /** Mark `id` superseded by decision `byId`. */
  async supersedeDecision(id: ID, byId: ID): Promise<boolean> {
    if (!this.decisionById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._decisions, id, { status: 'superseded', supersededById: byId, updatedAt: this.nowIso() });
    return this.writeOk('supersede decision', (s) => this.api.decisions.supersede(s, id, byId), {
      tx,
      onResult: (d) => d && this.upsert(this._decisions, d),
    });
  }

  async deleteDecision(id: ID): Promise<boolean> {
    if (!this.decisionById().has(id)) return false;
    const tx = this.tx();
    tx.remove(this._decisions, id);
    return this.ok('delete decision', (s) => this.api.decisions.remove(s, id), { tx });
  }

  // ─────────────────────────── dependencies ───────────────────────────

  async addDependency(input: CreateDependencyInput): Promise<Dependency | undefined> {
    return this.write('add dependency', (s) => this.api.dependencies.create(s, input), {
      onResult: (d) => this.upsert(this._dependencies, d),
    });
  }

  async removeDependency(id: ID): Promise<boolean> {
    if (!this._dependencies().some((d) => d.id === id)) return false;
    const tx = this.tx();
    tx.remove(this._dependencies, id);
    return this.ok('remove dependency', (s) => this.api.dependencies.remove(s, id), { tx });
  }

  // ─────────────────────────── comments ───────────────────────────

  async addComment(subject: SubjectRef, body: string): Promise<Comment | undefined> {
    return this.write('post comment', (s) => this.api.comments.create(s, { subject, body }), {
      onResult: (c) => this.upsert(this._comments, c),
    });
  }

  async editComment(id: ID, body: string): Promise<boolean> {
    const tx = this.tx();
    tx.patch(this._comments, id, { body, updatedAt: this.nowIso() });
    return this.writeOk('edit comment', (s) => this.api.comments.update(s, id, body), {
      tx,
      onResult: (c) => c && this.upsert(this._comments, c),
    });
  }

  async deleteComment(id: ID): Promise<boolean> {
    const tx = this.tx();
    tx.remove(this._comments, id);
    return this.ok('delete comment', (s) => this.api.comments.remove(s, id), { tx });
  }

  // ─────────────────────────── attention ───────────────────────────

  /** `id` is `AttentionItem.id` (e.g. `input_requested:ir_1`). */
  async dismissAttention(id: string): Promise<boolean> {
    const tx = this.tx();
    tx.patch(this._attention, id, { state: 'dismissed' });
    return this.ok('dismiss', (s) => this.api.attention.dismiss(s, id), { tx });
  }

  /** Hide an item until `until` (ISO date-time). */
  async snoozeAttention(id: string, until: string): Promise<boolean> {
    const tx = this.tx();
    tx.patch(this._attention, id, { state: 'snoozed', snoozedUntil: until });
    return this.ok('snooze', (s) => this.api.attention.snooze(s, id, until), { tx });
  }

  /** Bring a dismissed / snoozed item back (additive, used by the My Attention "Snoozed & dismissed" tab). */
  async restoreAttention(id: string): Promise<boolean> {
    const tx = this.tx();
    tx.patch(this._attention, id, { state: 'open', snoozedUntil: undefined });
    return this.ok('restore', (s) => this.api.attention.restore(s, id), { tx });
  }

  // ─────────────────────────── views ───────────────────────────

  async createView(input: CreateViewInput): Promise<SavedView | undefined> {
    return this.write('save view', (s) => this.api.views.create(s, input), {
      onResult: (v) => this.upsert(this._views, v),
    });
  }

  async updateView(id: ID, patch: UpdateViewInput): Promise<boolean> {
    if (!this.viewById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._views, id, { ...patch, updatedAt: this.nowIso() });
    return this.write('update view', (s) => this.api.views.update(s, id, patch), {
      tx,
      onResult: (v) => this.upsert(this._views, v),
    }).then((r) => !!r);
  }

  async deleteView(id: ID): Promise<boolean> {
    if (!this.viewById().has(id)) return false;
    const tx = this.tx();
    tx.remove(this._views, id);
    return this.ok('delete view', (s) => this.api.views.remove(s, id), { tx });
  }

  // ─────────────────────────── admin: teams, repositories ───────────────────────────

  async createTeam(input: CreateTeamInput): Promise<Team | undefined> {
    return this.write('create team', (s) => this.api.teams.create(s, input), {
      onResult: (t) => this.upsert(this._teams, t),
    });
  }

  async updateTeam(id: ID, patch: UpdateTeamInput): Promise<boolean> {
    if (!this.teamById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._teams, id, patch);
    return this.write('update team', (s) => this.api.teams.update(s, id, patch), {
      tx,
      onResult: (t) => this.upsert(this._teams, t),
    }).then((r) => !!r);
  }

  async deleteTeam(id: ID): Promise<boolean> {
    if (!this.teamById().has(id)) return false;
    const tx = this.tx();
    tx.remove(this._teams, id);
    return this.ok('delete team', (s) => this.api.teams.remove(s, id), { tx });
  }

  async createRepository(input: CreateRepositoryInput): Promise<Repository | undefined> {
    return this.write('add repository', (s) => this.api.repositories.create(s, input), {
      onResult: (r) => this.upsert(this._repositories, r),
    });
  }

  async updateRepository(id: ID, patch: UpdateRepositoryInput): Promise<boolean> {
    if (!this.repositoryById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._repositories, id, patch);
    return this.write('update repository', (s) => this.api.repositories.update(s, id, patch), {
      tx,
      onResult: (r) => this.upsert(this._repositories, r),
    }).then((r) => !!r);
  }

  async deleteRepository(id: ID): Promise<boolean> {
    if (!this.repositoryById().has(id)) return false;
    const tx = this.tx();
    tx.remove(this._repositories, id);
    return this.ok('remove repository', (s) => this.api.repositories.remove(s, id), { tx });
  }

  // ─────────────────────────── projects ───────────────────────────

  async createProject(input: CreateProjectInput): Promise<Project | undefined> {
    return this.write('create project', (s) => this.api.projects.create(s, input), {
      onResult: (p) => this.upsert(this._projects, p),
    });
  }

  async updateProject(id: ID, patch: UpdateProjectInput): Promise<boolean> {
    if (!this.projectById().has(id)) return false;
    const tx = this.tx();
    tx.patch(this._projects, id, patch);
    return this.write('update project', (s) => this.api.projects.update(s, id, patch), {
      tx,
      onResult: (p) => this.upsert(this._projects, p),
    }).then((p) => !!p);
  }

  async deleteProject(id: ID): Promise<boolean> {
    if (!this.projectById().has(id)) return false;
    const tx = this.tx();
    tx.remove(this._projects, id);
    // its milestones go with it, and its workstreams are detached
    this.dropMilestones(tx, this._milestones().filter((m) => m.projectId === id).map((m) => m.id));
    for (const w of this._workstreams().filter((x) => x.projectId === id)) tx.patch(this._workstreams, w.id, { projectId: undefined });
    return this.ok('delete project', (s) => this.api.projects.remove(s, id), { tx });
  }

  // ─────────────────────────── admin: members, agents, tokens, integrations ───────────────────────────

  /** Add a member by email (admin). The user appears after the next refetch. */
  async addMember(input: AddMemberInput): Promise<Membership | undefined> {
    return this.write('add member', (s) => this.api.members.add(s, input), {
      onResult: (m) => this.upsert(this._memberships, m),
    });
  }

  async updateMemberRole(membershipId: ID, role: Role): Promise<boolean> {
    const tx = this.tx();
    tx.patch(this._memberships, membershipId, { role });
    return this.ok('change role', (s) => this.api.members.update(s, membershipId, { role }), { tx });
  }

  async removeMember(membershipId: ID): Promise<boolean> {
    const tx = this.tx();
    tx.remove(this._memberships, membershipId);
    return this.ok('remove member', (s) => this.api.members.remove(s, membershipId), { tx });
  }

  /** Workspace customization (admin) and the permission policy (`permissions`, owner only). */
  async updateSettings(input: UpdateWorkspaceSettingsInput): Promise<boolean> {
    return this.write('save settings', (s) => this.api.workspaces.updateSettings(s, input), {
      onResult: (ws) => {
        this._workspace.update((cur) => (cur ? { ...cur, settings: ws.settings } : cur));
        setDisplayTimeZone(this.timeZone());
      },
    }).then((r) => !!r);
  }

  // ───── outgoing webhooks (custom integrations); loaded on demand, admin only ─────

  private readonly _outgoingWebhooks = signal<readonly OutgoingWebhook[]>([]);
  readonly outgoingWebhooks = this._outgoingWebhooks.asReadonly();

  async loadOutgoingWebhooks(): Promise<void> {
    const slug = this.slug();
    if (!slug) return;
    try {
      const list = await this.api.outgoingWebhooks.list(slug, { quiet: true });
      if (this.slug() === slug) this._outgoingWebhooks.set(list);
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status !== 401 && err.status !== 403) this.notifier.error('Could not load webhooks', { description: err.message });
    }
  }

  /** The returned `secret` is shown once. */
  async createWebhook(input: CreateWebhookInput): Promise<WebhookWithSecret | undefined> {
    return this.write('create webhook', (s) => this.api.outgoingWebhooks.create(s, input), {
      onResult: (r) => this.upsert(this._outgoingWebhooks, r.webhook),
    });
  }

  async updateWebhook(id: ID, patch: UpdateWebhookInput): Promise<boolean> {
    const tx = this.tx();
    tx.patch(this._outgoingWebhooks, id, patch);
    return this.write('update webhook', (s) => this.api.outgoingWebhooks.update(s, id, patch), {
      tx,
      onResult: (w) => this.upsert(this._outgoingWebhooks, w),
    }).then((r) => !!r);
  }

  async deleteWebhook(id: ID): Promise<boolean> {
    const tx = this.tx();
    tx.remove(this._outgoingWebhooks, id);
    return this.ok('delete webhook', (s) => this.api.outgoingWebhooks.remove(s, id), { tx });
  }

  async rotateWebhookSecretFor(id: ID): Promise<WebhookWithSecret | undefined> {
    return this.write('rotate webhook secret', (s) => this.api.outgoingWebhooks.rotateSecret(s, id));
  }

  /** Sends a ping; resolves the delivery (also refreshes the webhook's last status). */
  async testWebhook(id: ID): Promise<WebhookDeliveryLog | undefined> {
    const log = await this.write('test webhook', (s) => this.api.outgoingWebhooks.test(s, id));
    if (log) this._outgoingWebhooks.update((list) => list.map((w) => (w.id === id ? { ...w, lastStatus: log.status, lastDeliveryAt: log.at } : w)));
    return log;
  }

  async webhookDeliveries(id: ID): Promise<WebhookDeliveryLog[]> {
    const slug = this.slug();
    if (!slug) return [];
    try {
      return await this.api.outgoingWebhooks.deliveries(slug, id);
    } catch {
      return [];
    }
  }

  async createAgent(input: CreateAgentInput): Promise<Agent | undefined> {
    return this.write('create agent', (s) => this.api.agents.create(s, input), {
      onResult: (a) => this.upsert(this._agents, a),
    });
  }

  async updateAgent(id: ID, patch: UpdateAgentInput): Promise<boolean> {
    const tx = this.tx();
    tx.patch(this._agents, id, patch);
    return this.write('update agent', (s) => this.api.agents.update(s, id, patch), {
      tx,
      onResult: (a) => this.upsert(this._agents, a),
    }).then((r) => !!r);
  }

  async deleteAgent(id: ID): Promise<boolean> {
    const tx = this.tx();
    tx.remove(this._agents, id);
    return this.ok('delete agent', (s) => this.api.agents.remove(s, id), { tx });
  }

  /** Fetch API tokens into `tokens()`. */
  async loadTokens(): Promise<void> {
    const slug = this.slug();
    if (!slug) return;
    try {
      this._tokens.set(await this.api.tokens.list(slug));
    } catch (e) {
      const err = ApiError.from(e);
      if (err.status !== 401 && err.status !== 403) {
        this.notifier.error('Could not load tokens', { description: err.message });
      }
    }
  }

  /** Create a token. The returned `secret` is shown once - surface it to the user immediately. */
  async createToken(input: CreateTokenInput): Promise<CreatedToken | undefined> {
    return this.write('create token', (s) => this.api.tokens.create(s, input), {
      onResult: (r) => this.upsert(this._tokens, r.token),
    });
  }

  async deleteToken(id: ID): Promise<boolean> {
    const tx = this.tx();
    tx.remove(this._tokens, id);
    return this.ok('revoke token', (s) => this.api.tokens.remove(s, id), { tx });
  }

  /**
   * Connect GitHub / GitLab / Delta. Resolves `{ connection, webhook? }`: the webhook secret is only
   * returned here (and by `rotateWebhookSecret`) — show it to the user once.
   */
  async createIntegration(input: CreateIntegrationInput): Promise<IntegrationWithWebhook | undefined> {
    return this.write('connect integration', (s) => this.api.integrations.create(s, input), {
      onResult: (r) => this.upsertIntegration(r.connection),
    });
  }

  async deleteIntegration(id: ID): Promise<boolean> {
    const tx = this.tx();
    tx.remove(this._integrations, id);
    this._integrationDetails.update((list) => list.filter((x) => x.id !== id));
    return this.ok('disconnect integration', (s) => this.api.integrations.remove(s, id), { tx });
  }

  // integration details (admin; not part of the snapshot) ---------------------

  private readonly _integrationDetails = signal<readonly IntegrationDetail[]>([]);
  /** `GET /integrations` (webhookUrl, linked repository ids, lastWebhookAt). Loaded by `loadIntegrationDetails()`. */
  readonly integrationDetails = this._integrationDetails.asReadonly();

  /** Fetch integration details (admin only; silently empty otherwise). */
  async loadIntegrationDetails(): Promise<void> {
    const slug = this.slug();
    if (!slug || !this.can('admin')) return;
    try {
      const list = await this.api.integrations.list(slug, { quiet: true });
      if (this.slug() === slug) this._integrationDetails.set(list);
    } catch {
      /* keep what we have; the snapshot still lists the connections */
    }
  }

  private upsertIntegration(c: IntegrationDetail): void {
    this.upsert(this._integrations, c);
    this.upsert(this._integrationDetails, c);
  }

  /** PATCH token / baseUrl; the server re-validates against the provider. */
  async updateIntegration(id: ID, input: UpdateIntegrationInput): Promise<IntegrationDetail | undefined> {
    return this.write('update integration', (s) => this.api.integrations.update(s, id, input), {
      onResult: (c) => this.upsertIntegration(c),
    });
  }

  /** New webhook secret (the old one stops working at once). Resolves the one-time setup. */
  async rotateWebhookSecret(id: ID): Promise<IntegrationWithWebhook | undefined> {
    return this.write('rotate webhook secret', (s) => this.api.integrations.rotateWebhookSecret(s, id), {
      onResult: (r) => this.upsertIntegration(r.connection),
    });
  }

  /** Repositories visible to a connection's token (read; rejects with ApiError). */
  async remoteRepositories(id: ID, page = 1, perPage = 30): Promise<RemoteRepositoryPage> {
    return this.api.integrations.remoteRepositories(this.requireSlug(), id, page, perPage);
  }

  /** Link a remote repository: creates (or adopts) the repository and attaches it to the connection. */
  async linkRepository(id: ID, input: LinkRepositoryInput): Promise<Repository | undefined> {
    return this.write('link repository', (s) => this.api.integrations.linkRepository(s, id, input), {
      onResult: (r) => {
        this.upsert(this._repositories, r);
        this._integrationDetails.update((list) =>
          list.map((c) => (c.id === id && !c.repositoryIds.includes(r.id) ? { ...c, repositoryIds: [...c.repositoryIds, r.id] } : c)),
        );
      },
    });
  }

  /** Detach a repository from a connection (the repository stays). Optimistic. */
  async unlinkRepository(id: ID, repositoryId: ID): Promise<boolean> {
    const prev = this._integrationDetails();
    this._integrationDetails.update((list) =>
      list.map((c) => (c.id === id ? { ...c, repositoryIds: c.repositoryIds.filter((r) => r !== repositoryId) } : c)),
    );
    return this.ok('unlink repository', (s) => this.api.integrations.unlinkRepository(s, id, repositoryId), {
      tx: { rollback: () => this._integrationDetails.set(prev) },
    });
  }

}
