import {
  GIT_PROVIDER_META,
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
  DecisionStatus,
  ExecutionProvider,
  GitProvider,
  IssueKind,
  IssueSource,
  IssueStatus,
  Priority,
  ProjectStatus,
  ReviewState,
  Role,
  SubjectRef,
  ViewFilter,
  ViewLayout,
} from '../../contracts/domain.js';
import { uid, unique } from '../../common/util.js';
import type {
  AgentEntity,
  ArtifactEntity,
  CommentEntity,
  DecisionEntity,
  DependencyEntity,
  DomainEventEntity,
  InputRequestEntity,
  IssueEntity,
  IntegrationConnectionEntity,
  MembershipEntity,
  MilestoneEntity,
  ProjectEntity,
  RepositoryEntity,
  SavedViewEntity,
  TeamEntity,
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
  teams: Rows<TeamEntity>;
  repositories: Rows<RepositoryEntity>;
  projects: Rows<ProjectEntity>;
  legacyWorkstreams: { id: string; key: string; title: string; objective: string }[];
  milestones: Rows<MilestoneEntity>;
  inputRequests: Rows<InputRequestEntity>;
  issues: Rows<IssueEntity>;
  artifacts: Rows<ArtifactEntity>;
  decisions: Rows<DecisionEntity>;
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
export const team = (id: string): ActorRef => ({ type: 'team', id });
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
      users: [], workspace: {}, memberships: [], agents: [], teams: [], repositories: [], projects: [], legacyWorkstreams: [], milestones: [],
      inputRequests: [], issues: [], artifacts: [], decisions: [], dependencies: [], comments: [],
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

  team(name: string, key: string, color: string, description: string, memberIds: string[]) {
    const id = uid('tm');
    this.data.teams.push({ id, workspaceId: this.workspaceId, name, key, color, description, memberIds });
    return id;
  }

  repo(provider: GitProvider, fullName: string, teamIds: string[]) {
    const id = uid('rp');
    const host = GIT_PROVIDER_META[provider].host;
    this.data.repositories.push({
      id, workspaceId: this.workspaceId, provider, fullName, url: `https://${host}/${fullName}`, defaultBranch: 'main', teamIds, createdAt: this.at(58),
    });
    return id;
  }

  /** Linear-style project. */
  project(o: {
    name: string;
    summary?: string;
    description?: string;
    color?: string;
    status: ProjectStatus;
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
      color: o.color ?? '#6b7280', status: o.status, priority: o.priority ?? 'medium', leadId: o.lead ?? null, teamIds: o.teams, repositoryIds: [],
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
    const project = o.project && this.data.projects.find((row) => row.id === o.project);
    if (project)
      project.repositoryIds = [...new Set([...(project.repositoryIds ?? []), ...(o.repos ?? [])])];
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

  input(workstreamId: string, o: {
    execution?: string;
    question: string;
    options?: string[];
    by: ActorRef;
    assignee?: string;
    created: number;
    answer?: { text: string; by: string; daysAgo: number };
  }) {
    const id = uid('ir');
    const legacyWorkstreamKey = this.streamKeys.get(workstreamId) ?? workstreamId;
    this.data.inputRequests.push({
      id, workspaceId: this.workspaceId, issueId: null, legacyWorkstreamKey, question: o.question, options: o.options ?? null,
      requestedBy: o.by, assigneeUserId: o.assignee ?? null, state: o.answer ? 'answered' : 'open', answer: o.answer?.text ?? null,
      answeredById: o.answer?.by ?? null, createdAt: this.at(o.created), answeredAt: o.answer ? this.at(o.answer.daysAgo) : null,
    });
    const subj: SubjectRef = { type: 'input_request', id };
    this.event(this.at(o.created), o.by, 'input.requested', subj, workstreamId, { question: o.question });
    if (o.answer) this.event(this.at(o.answer.daysAgo), user(o.answer.by), 'input.answered', subj, workstreamId, { question: o.question, answer: o.answer.text });
    return id;
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
      id, workspaceId: this.workspaceId, projectId: null, issueId: null, legacyWorkstreamKey, repositoryId: o.repo ?? null, kind: o.kind,
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

  decision(o: {
    number: number;
    title: string;
    statement: string;
    rationale?: string;
    status: DecisionStatus;
    origin?: string;
    originExecution?: string;
    related?: string[];
    by: ActorRef;
    decidedBy?: string;
    created: number;
    decided?: number;
    superseded?: string;
    tags?: string[];
  }) {
    const id = uid('dc');
    const legacyWorkstreamKey = o.origin ? this.streamKeys.get(o.origin) ?? o.origin : null;
    const legacyWorkstreamKeys = [...new Set([
      ...(legacyWorkstreamKey ? [legacyWorkstreamKey] : []),
      ...(o.related ?? []).map((streamId) => this.streamKeys.get(streamId) ?? streamId),
    ])];
    this.bump('adr', o.number);
    this.data.decisions.push({
      id, workspaceId: this.workspaceId, key: `ADR-${o.number}`, number: o.number, title: o.title, statement: o.statement,
      rationale: o.rationale ?? null, status: o.status, originIssueId: null, relatedIssueIds: [],
      legacyWorkstreamKey, legacyWorkstreamKeys,
      supersededById: o.superseded ?? null, proposedBy: o.by,
      decidedById: o.decidedBy ?? null, decidedAt: o.decided !== undefined ? this.at(o.decided) : null, tags: o.tags ?? [],
      createdAt: this.at(o.created), updatedAt: this.at(o.decided ?? o.created),
    });
    const subj: SubjectRef = { type: 'decision', id };
    const key = `ADR-${o.number}`;
    this.event(this.at(o.created), o.by, 'decision.proposed', subj, o.origin ?? null, { key, title: o.title });
    if (o.decided !== undefined && o.decidedBy)
      this.event(this.at(o.decided), user(o.decidedBy), o.status === 'rejected' ? 'decision.rejected' : 'decision.accepted', subj, o.origin ?? null, { key, title: o.title });
    return id;
  }

  /** Records the supersede event after both decisions exist. */
  superseded(decisionId: string, byKey: string, daysAgo: number, by: string) {
    const d = this.data.decisions.find((x) => x.id === decisionId)!;
    this.event(this.at(daysAgo), user(by), 'decision.superseded', { type: 'decision', id: decisionId }, d.legacyWorkstreamKey ?? null, { key: d.key, title: d.title, supersededBy: byKey });
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
      reporterName: o.reporterName ?? null, reporterId: o.reporter ?? null, assigneeId: o.assignee ?? null, teamId: o.team ?? null, priority: o.priority ?? 'none', status: o.status,
      goal: null, projectId, milestoneIds: o.milestones ?? [], releaseId: null, aliases: [], estimate: o.estimate ?? null,
      startedAt: STARTED.has(o.status) || FINISHED.has(o.status) ? this.at(o.moved ?? o.created) : null,
      completedAt: FINISHED.has(o.status) ? this.at(o.moved ?? o.created) : null,
      duplicateOfId: o.duplicateOf ?? null, externalUrl: o.url ?? null,
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
    if (entity === 'execution' || entity === 'workstream') return;
    this.data.views.push({
      id: uid('vw'), workspaceId: this.workspaceId, ownerId: owner, name, entity: entity as 'issue' | 'decision' | 'project', filters: o.filters ?? [], sort: o.sort ?? null,
      groupBy: o.groupBy ?? null, layout: o.layout ?? 'list', shared: o.shared, sharing: { visibility: o.shared ? 'workspace' : 'private', grants: [] }, publicTokenHash: null, publicTokenEnc: null, createdAt: this.at(o.created), updatedAt: this.at(o.created),
    });
  }

  finalize(): void {
    const issuesByKey = new Map<string, string[]>();
    for (const [streamId, issueIds] of this.issueLinks) {
      const key = this.streamKeys.get(streamId);
      if (key) issuesByKey.set(key, issueIds);
      if (key && issueIds.length === 1) {
        const issue = this.data.issues.find((row) => row.id === issueIds[0]);
        const stream = this.data.legacyWorkstreams.find((row) => row.id === streamId);
        if (issue && stream && !issue.goal) issue.goal = stream.objective || null;
      }
    }
    const ownerIssue = (key?: string | null) => {
      const ids = key ? issuesByKey.get(key) ?? [] : [];
      return ids.length === 1 ? ids[0] : null;
    };
    for (const row of this.data.inputRequests) {
      const issueId = ownerIssue(row.legacyWorkstreamKey);
      if (issueId) {
        row.issueId = issueId;
        row.legacyWorkstreamKey = null;
      }
    }
    for (const row of this.data.artifacts) {
      const issueId = ownerIssue(row.legacyWorkstreamKey);
      if (issueId) {
        row.issueId = issueId;
        row.legacyWorkstreamKey = null;
      }
    }
    for (const row of this.data.decisions) {
      const issueId = ownerIssue(row.legacyWorkstreamKey);
      if (issueId) {
        row.originIssueId = issueId;
        row.legacyWorkstreamKey = null;
      }
      const remainingLegacyKeys: string[] = [];
      for (const key of row.legacyWorkstreamKeys ?? []) {
        const relatedIssueId = ownerIssue(key);
        if (relatedIssueId) row.relatedIssueIds = [...new Set([...(row.relatedIssueIds ?? []), relatedIssueId])];
        else remainingLegacyKeys.push(key);
      }
      row.legacyWorkstreamKeys = remainingLegacyKeys;
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
