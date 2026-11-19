import {
  UNASSIGNED_ISSUE_KEY_PREFIX,
  uniqueProjectKey,
} from '../../contracts/domain.js';
import type { WorkspaceSettings } from '../../contracts/domain.js';
import type {
  ActorRef,
  ArtifactKind,
  ArtifactProvider,
  ArtifactState,
  CiState,
  ExecutionProvider,
  GitProvider,
  IssueKind,
  IssueSource,
  IssueStatus,
  Priority,
  ProjectHealth,
  ProjectStatus,
  ReviewState,
  Role,
  SubjectRef,
  ViewEntity,
  ViewFilter,
  ViewLayout,
} from '../../contracts/domain.js';
import { uid, unique } from '../../common/util.js';
import type {
  AgentEntity,
  ArtifactEntity,
  CommentEntity,
  DependencyEntity,
  DomainEventEntity,
  IssueEntity,
  IntegrationConnectionEntity,
  MembershipEntity,
  MilestoneEntity,
  ProjectEntity,
  SavedViewEntity,
  UserEntity,
  WorkspaceEntity,
} from '../entities/index.js';

const STARTED: ReadonlySet<string> = new Set(['in_progress', 'in_review']);
const FINISHED: ReadonlySet<string> = new Set(['done', 'canceled']);

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;

type Rows<T> = Partial<T>[];

export interface SeedData {
  users: Rows<UserEntity>;
  workspace: Partial<WorkspaceEntity>;
  memberships: Rows<MembershipEntity>;
  agents: Rows<AgentEntity>;
  projects: Rows<ProjectEntity>;
  legacyWorkstreams: { id: string; key: string; title: string; objective: string }[];
  milestones: Rows<MilestoneEntity>;
  issues: Rows<IssueEntity>;
  artifacts: Rows<ArtifactEntity>;
  dependencies: Rows<DependencyEntity>;
  comments: Rows<CommentEntity>;
  events: Rows<DomainEventEntity>;
  views: Rows<SavedViewEntity>;
  integrations: Rows<IntegrationConnectionEntity>;
  /** counter name → value */
  counters: Record<string, number>;
}

export const user = (id: string): ActorRef => ({ type: 'user', id });
export const agent = (id: string): ActorRef => ({ type: 'agent', id });
export const SYSTEM: ActorRef = { type: 'system' };

export interface ExecOpts {
  title: string;
  description?: string;
  parent?: string;
  team?: string;
  repos?: string[];
  performers: ActorRef[];
  provider: ExecutionProvider;
  state: string;
  deps?: string[];
  session?: string;
  branch?: string;
  note?: string;
  /** days ago when created */
  created: number;
  /** days ago when it started (default: created) */
  started?: number;
  /** days ago when it reached a terminal state */
  done?: number;
  /** extra progress notes: [daysAgo, text] */
  notes?: [number, string][];
}

/** Collects seed rows plus the matching event history. */
export class SeedBuilder {
  readonly data: SeedData;
  readonly workspaceId: string;
  private readonly keyCounters: Record<string, number> = {};
  private readonly streamKeys = new Map<string, string>();
  private readonly issueLinks = new Map<string, string[]>();
  private readonly pendingComments: {
    streamId: string;
    author: ActorRef;
    body: string;
    daysAgo: number;
  }[] = [];

  constructor(
    readonly now: number,
    workspaceId = uid('ws'),
  ) {
    this.workspaceId = workspaceId;
    this.data = {
      users: [], workspace: {}, memberships: [], agents: [], projects: [], legacyWorkstreams: [], milestones: [],
      issues: [], artifacts: [], dependencies: [], comments: [],
      events: [], views: [], integrations: [], counters: {},
    };
  }

  /** `days` (and `hours`) ago. */
  at = (days: number, hours = 0): Date => new Date(this.now - days * DAY - hours * HOUR);

  private bump(name: string, value: number) {
    this.data.counters[name] = Math.max(this.data.counters[name] ?? 0, value);
  }

  event(at: Date, actor: ActorRef, type: string, subject: SubjectRef, legacyWorkstreamKey: string | null, data: Record<string, unknown> = {}) {
    const key = legacyWorkstreamKey
      ? this.streamKeys.get(legacyWorkstreamKey) ?? legacyWorkstreamKey
      : undefined;
    this.data.events.push({ id: uid('ev'), workspaceId: this.workspaceId, at, actor, type, subject, legacyWorkstreamKey: key, data });
  }

  user(name: string, email: string, avatarHue: number, passwordHash: string, role: Role, created = 60) {
    const id = uid('usr');
    this.data.users.push({ id, name, email, passwordHash, avatarHue, createdAt: this.at(created) });
    this.data.memberships.push({ id: uid('mb'), workspaceId: this.workspaceId, userId: id, role, createdAt: this.at(created) });
    return id;
  }

  agent(name: string, provider: Exclude<ExecutionProvider, 'human'>, description: string, ownerUserId?: string) {
    const id = uid('ag');
    this.data.agents.push({ id, workspaceId: this.workspaceId, name, provider, description, ownerUserId: ownerUserId ?? null, createdAt: this.at(55) });
    return id;
  }

  /** Teams are gone. The id is only so existing seed scripts can keep local variables. */
  team(_name: string, _key: string, _color: string, _description: string, _memberIds: string[]) {
    return uid('tm');
  }

  /** Repository registry is gone. Projects keep a nullable repository string instead. */
  repo(_provider: GitProvider, _fullName: string, _teamIds: string[]) {
    return uid('rp');
  }

  /** Linear-style project. */
  project(o: {
    name: string;
    summary?: string;
    description?: string;
    color?: string;
    status: ProjectStatus;
    health?: ProjectHealth;
    priority?: Priority;
    lead?: string;
    teams: string[];
    start?: number;
    target?: number;
    created: number;
    createdBy: string;
  }): string {
    const id = uid('pj');
    const createdAt = this.at(o.created);
    const key = uniqueProjectKey(
      o.name,
      this.data.projects.map((project) => project.key).filter((projectKey): projectKey is string => !!projectKey),
    );
    this.data.projects.push({
      id, workspaceId: this.workspaceId, name: o.name, key, summary: o.summary ?? null, description: o.description ?? null,
      color: o.color ?? '#6b7280', status: o.status, health: o.health ?? null, priority: o.priority ?? 'medium', leadId: o.lead ?? null, repository: null,
      startDate: o.start !== undefined ? this.at(o.start) : null, targetDate: o.target !== undefined ? this.at(-o.target) : null,
      createdAt, updatedAt: createdAt, completedAt: o.status === 'completed' || o.status === 'canceled' ? createdAt : null,
    });
    this.event(createdAt, user(o.createdBy), 'project.created', { type: 'project', id }, null, { name: o.name });
    return id;
  }

  /** Initialize the workspace's label catalog. */
  adoptLabels() {
    const settings = (this.data.workspace.settings ?? {}) as Partial<WorkspaceSettings>;
    this.data.workspace.settings = { ...settings, labels: settings.labels ?? [] };
  }

  /** Project repositories are managed independently. */
  syncProjectRepos() {
    // Retained as a no-op for seed construction call sites.
  }

  workstream(o: {
    key: string;
    title: string;
    objective: string;
    context?: string;
    owner: string;
    participating?: string[];
    accountable?: string;
    project?: string;
    repos?: string[];
    criteria?: [string, string][];
    priority?: Priority;
    labels?: string[];
    path: string[];
    override?: string;
    start?: number;
    target?: number;
    created: number;
    shipped?: number;
    createdBy: string;
  }) {
    const id = uid('wk');
    this.data.legacyWorkstreams.push({ id, key: o.key, title: o.title, objective: o.objective });
    this.streamKeys.set(id, o.key);
    return id;
  }

  /** Criteria and status history are retired with the Workstream model. */
  criterionEvents(_workstreamId: string, _key: string, _items: { daysAgo: number; text: string; state: string; by: string }[]) {}

  /** Execution stories are retired; return a local id for old seed call sites. */
  execution(_workstreamId: string, _o: ExecOpts): string {
    return uid('ex');
  }

  dependency(_fromType: 'workstream' | 'execution', _fromId: string, _toType: 'workstream' | 'execution', _toId: string, _toWorkstreamId: string, _daysAgo: number) {
    return '';
  }

  artifact(workstreamId: string, o: {
    kind: ArtifactKind;
    provider: ArtifactProvider;
    title: string;
    execution?: string;
    repo?: string;
    url?: string;
    externalId?: string;
    state: ArtifactState;
    ci?: CiState;
    review?: ReviewState;
    conflicts?: boolean;
    env?: string;
    by: ActorRef;
    created: number;
    updated?: number;
  }) {
    const id = uid('ar');
    const legacyWorkstreamKey = this.streamKeys.get(workstreamId) ?? workstreamId;
    const isPr = o.kind === 'pull_request' || o.kind === 'merge_request';
    this.data.artifacts.push({
      id, workspaceId: this.workspaceId, issueId: null, legacyWorkstreamKey, repository: null, description: null, kind: o.kind,
      provider: o.provider, title: o.title, url: o.url ?? null, externalId: o.externalId ?? null, state: o.state,
      ci: o.ci ?? null, review: o.review ?? (isPr ? 'none' : null), hasConflicts: o.conflicts ?? (isPr ? false : null), environment: o.env ?? null,
      authorRef: o.by, createdAt: this.at(o.created), updatedAt: this.at(o.updated ?? o.created),
    });
    const subj: SubjectRef = { type: 'artifact', id };
    this.event(this.at(o.created), o.by, 'artifact.attached', subj, workstreamId, { kind: o.kind, title: o.title, externalId: o.externalId, state: 'open' });
    if (o.updated !== undefined && o.updated !== o.created)
      this.event(this.at(o.updated), SYSTEM, 'artifact.updated', subj, workstreamId, { title: o.title, externalId: o.externalId, changes: { state: [null, o.state], ci: [null, o.ci ?? null] } });
    if (o.review === 'requested')
      this.event(this.at(o.updated ?? o.created, 1), o.by, 'review.requested', subj, workstreamId, { title: o.title, externalId: o.externalId });
    return id;
  }

  /** Milestone of a project; `target` = days from now (negative = past). */
  milestone(projectId: string, o: { name: string; description?: string; target?: number; sort: number; created: number }): string {
    const id = uid('ms');
    this.data.milestones.push({
      id, workspaceId: this.workspaceId, projectId, name: o.name, description: o.description ?? null,
      targetDate: o.target !== undefined ? this.at(-o.target) : null, sortOrder: o.sort, createdAt: this.at(o.created), updatedAt: this.at(o.created),
    });
    this.event(this.at(o.created), SYSTEM, 'milestone.created', { type: 'milestone', id }, null, { name: o.name, projectId });
    return id;
  }

  issue(o: {
    kind: IssueKind;
    number: number;
    title: string;
    body?: string;
    source?: IssueSource;
    reporterName?: string;
    reporter?: string;
    assignee?: string;
    team?: string;
    project?: string;
    priority?: Priority;
    status: IssueStatus;
    workstreams?: string[];
    milestones?: string[];
    estimate?: number;
    duplicateOf?: string;
    url?: string;
    /** Delta thread the task is worked on in. */
    thread?: string;
    created: number;
    /** When the status left `backlog`. */
    moved?: number;
    movedBy?: string;
  }) {
    const id = uid('in');
    const milestoneProjects = unique(
      (o.milestones ?? [])
        .map((milestoneId) => this.data.milestones.find((m) => m.id === milestoneId)?.projectId)
        .filter((projectId): projectId is string => !!projectId),
    );
    const projectId = o.project ?? (milestoneProjects.length === 1 ? milestoneProjects[0] : null);
    const project = this.data.projects.find((candidate) => candidate.id === projectId);
    const prefix = project?.key ?? UNASSIGNED_ISSUE_KEY_PREFIX;
    const counterName = `issue-key:${prefix}`;
    const number = Math.max(o.number, (this.data.counters[counterName] ?? 0) + 1);
    const key = `${prefix}-${number}`;
    this.bump(counterName, number);
    this.data.issues.push({
      id, workspaceId: this.workspaceId, key, number, kind: o.kind, title: o.title, body: o.body ?? null, source: o.source ?? 'manual',
      reporterName: o.reporterName ?? null, reporterId: o.reporter ?? null, assigneeId: o.assignee ?? null, priority: o.priority ?? 'none', status: o.status,
      projectId, milestoneIds: o.milestones ?? [], labels: [], aliases: [], estimate: o.estimate ?? null,
      startedAt: STARTED.has(o.status) || FINISHED.has(o.status) ? this.at(o.moved ?? o.created) : null,
      completedAt: FINISHED.has(o.status) ? this.at(o.moved ?? o.created) : null,
      duplicateOfId: o.duplicateOf ?? null, externalUrl: o.url ?? null, threadUrl: o.thread ?? null,
      createdAt: this.at(o.created), updatedAt: this.at(o.moved ?? o.created),
    });
    for (const streamId of o.workstreams ?? []) {
      const linked = this.issueLinks.get(streamId) ?? [];
      linked.push(id);
      this.issueLinks.set(streamId, linked);
    }
    const subj: SubjectRef = { type: 'issue', id };
    this.event(this.at(o.created), o.reporter ? user(o.reporter) : SYSTEM, 'issue.created', subj, null, { key, kind: o.kind, title: o.title, status: 'backlog' });
    if (o.status !== 'backlog' && o.moved !== undefined) {
      this.event(this.at(o.moved), user(o.movedBy!), 'issue.status_changed', subj, null, { key, from: 'backlog', to: o.status });
    }
    return id;
  }

  comment(subject: { type: string; id: string }, workstreamId: string | null, author: ActorRef, body: string, daysAgo: number) {
    if (subject.type === 'execution') return '';
    if (subject.type === 'workstream' && workstreamId) {
      this.pendingComments.push({ streamId: workstreamId, author, body, daysAgo });
      return '';
    }
    const id = uid('cm');
    const resolved = subject as SubjectRef;
    this.data.comments.push({ id, workspaceId: this.workspaceId, subject: resolved, author, body, createdAt: this.at(daysAgo), updatedAt: this.at(daysAgo) });
    this.event(this.at(daysAgo), author, 'comment.created', resolved, null, { commentId: id, excerpt: body.slice(0, 200) });
    return id;
  }

  view(owner: string, name: string, entity: string, o: { filters?: ViewFilter[]; sort?: { field: string; direction: 'asc' | 'desc' }; groupBy?: string; layout?: ViewLayout; shared: boolean; created: number }) {
    if (entity !== 'issue' && entity !== 'project') return;
    const viewEntity: ViewEntity = entity;
    this.data.views.push({
      id: uid('vw'), workspaceId: this.workspaceId, ownerId: owner, name, entity: viewEntity, filters: o.filters ?? [], sort: o.sort ?? null,
      groupBy: o.groupBy ?? null, layout: o.layout ?? 'list', shared: o.shared, sharing: { visibility: o.shared ? 'workspace' : 'private', grants: [] }, publicTokenHash: null, publicTokenEnc: null, createdAt: this.at(o.created), updatedAt: this.at(o.created),
    });
  }

  finalize(): void {
    const issuesByKey = new Map<string, string[]>();
    for (const [streamId, issueIds] of this.issueLinks) {
      const key = this.streamKeys.get(streamId);
      if (key) issuesByKey.set(key, issueIds);
    }
    const ownerIssue = (key?: string | null) => {
      const ids = key ? issuesByKey.get(key) ?? [] : [];
      return ids.length === 1 ? ids[0] : null;
    };
    for (const row of this.data.artifacts) {
      const issueId = ownerIssue(row.legacyWorkstreamKey);
      if (issueId) {
        row.issueId = issueId;
        row.legacyWorkstreamKey = null;
      }
    }
    for (const event of this.data.events) {
      if (ownerIssue(event.legacyWorkstreamKey)) event.legacyWorkstreamKey = undefined;
    }
    for (const pending of this.pendingComments) {
      const key = this.streamKeys.get(pending.streamId);
      const issueId = ownerIssue(key);
      if (!issueId) continue;
      const id = uid('cm');
      const subject = { type: 'issue' as const, id: issueId };
      this.data.comments.push({ id, workspaceId: this.workspaceId, subject, author: pending.author, body: pending.body, createdAt: this.at(pending.daysAgo), updatedAt: this.at(pending.daysAgo) });
      this.event(this.at(pending.daysAgo), pending.author, 'comment.created', subject, null, { commentId: id, excerpt: pending.body.slice(0, 200) });
    }
  }
}
