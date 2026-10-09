import { GIT_PROVIDER_META, ISSUE_KEY_PREFIX, adoptFreeTextLabels, isDeltaThreadUrl } from '../../contracts/domain.js';
import type { WorkspaceSettings } from '../../contracts/domain.js';
import type {
  AcceptanceCriterion,
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
  ViewEntity,
  ViewFilter,
  ViewLayout,
  WorkstreamStatus,
} from '../../contracts/domain.js';
import { uid } from '../../common/util.js';
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
  WorkstreamEntity,
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
  workstreams: Rows<WorkstreamEntity>;
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

  constructor(
    readonly now: number,
    workspaceId = uid('ws'),
  ) {
    this.workspaceId = workspaceId;
    this.data = {
      users: [], workspace: {}, memberships: [], agents: [], teams: [], repositories: [], projects: [], workstreams: [], milestones: [],
      inputRequests: [], issues: [], artifacts: [], decisions: [], dependencies: [], comments: [],
      events: [], views: [], integrations: [], counters: {},
    };
  }

  /** `days` (and `hours`) ago. */
  at = (days: number, hours = 0): Date => new Date(this.now - days * DAY - hours * HOUR);

  private bump(name: string, value: number) {
    this.data.counters[name] = Math.max(this.data.counters[name] ?? 0, value);
  }

  event(at: Date, actor: ActorRef, type: string, subject: SubjectRef, workstreamId: string | null, data: Record<string, unknown> = {}) {
    this.data.events.push({ id: uid('ev'), workspaceId: this.workspaceId, at, actor, type, subject, workstreamId, data });
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

  /** Linear-style project. Its repositories are the union of its workstreams' (see `syncProjectRepos`). */
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
    this.data.projects.push({
      id, workspaceId: this.workspaceId, name: o.name, summary: o.summary ?? null, description: o.description ?? null,
      color: o.color ?? '#6b7280', status: o.status, priority: o.priority ?? 'medium', leadId: o.lead ?? null, teamIds: o.teams, repositoryIds: [],
      startDate: o.start !== undefined ? this.at(o.start) : null, targetDate: o.target !== undefined ? this.at(-o.target) : null,
      createdAt, updatedAt: createdAt, completedAt: o.status === 'completed' || o.status === 'canceled' ? createdAt : null,
    });
    this.event(createdAt, user(o.createdBy), 'project.created', { type: 'project', id }, null, { name: o.name });
    return id;
  }

  /** Replace free-text workstream labels with catalog ids and store that catalog on the workspace. */
  adoptLabels() {
    const { catalog, groups } = adoptFreeTextLabels(
      undefined,
      this.data.workstreams.map((row) => (row.labels ?? []) as string[]),
    );
    groups.forEach((ids, i) => {
      this.data.workstreams[i].labels = ids;
    });
    const settings = (this.data.workspace.settings ?? {}) as Partial<WorkspaceSettings>;
    this.data.workspace.settings = { ...settings, labels: catalog };
  }

  /** A workstream of a project may only use the project's repositories: give each project the union of its workstreams'. */
  syncProjectRepos() {
    for (const p of this.data.projects) {
      const repos = new Set<string>();
      for (const w of this.data.workstreams) if (w.projectId === p.id) for (const r of (w.repositoryIds ?? []) as string[]) repos.add(r);
      p.repositoryIds = [...repos];
    }
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
    criteria?: [string, AcceptanceCriterion['state']][];
    priority?: Priority;
    labels?: string[];
    /** status progression, oldest first; last = current derived status */
    path: WorkstreamStatus[];
    override?: 'draft' | 'canceled';
    /** days ago the work started (timeline start) */
    start?: number;
    target?: number;
    created: number;
    shipped?: number;
    createdBy: string;
  }) {
    const [prefix, numStr] = o.key.split('-');
    const number = Number(numStr);
    this.bump(`ws:${o.owner}`, number);
    const id = uid('wk');
    const current = o.path[o.path.length - 1];
    const createdAt = this.at(o.created);
    const lastChange = o.path.length > 1 ? this.at(Math.max(0.05, o.created / (o.path.length + 1))) : createdAt;
    this.data.workstreams.push({
      id,
      workspaceId: this.workspaceId,
      key: o.key,
      number,
      title: o.title,
      description: o.context ?? null,
      objective: o.objective,
      context: o.context ?? null,
      deltaThreadUrl: `https://delta.dev/t/${o.key.toLowerCase()}`,
      ownerTeamId: o.owner,
      participatingTeamIds: o.participating ?? [],
      accountableUserId: o.accountable ?? null,
      projectId: o.project ?? null,
      repositoryIds: o.repos ?? [],
      acceptanceCriteria: (o.criteria ?? []).map(([text, state]) => ({ id: uid('ac'), text, state })),
      priority: o.priority ?? 'medium',
      labels: o.labels ?? [],
      status: o.override ?? current,
      derivedStatus: current,
      delivery: 'none',
      statusOverride: o.override ?? null,
      startDate: o.start !== undefined ? this.at(o.start) : null,
      targetDate: o.target !== undefined ? this.at(-o.target) : null,
      createdById: o.createdBy,
      createdAt,
      updatedAt: lastChange,
      shippedAt: o.shipped !== undefined ? this.at(o.shipped) : null,
    });
    void prefix;
    const actor = user(o.createdBy);
    this.event(createdAt, actor, 'workstream.created', { type: 'workstream', id }, id, { key: o.key, title: o.title });
    // status history, spread between creation and the last change
    o.path.slice(1).forEach((to, i, arr) => {
      const frac = (i + 1) / (arr.length + 1);
      const when = new Date(createdAt.getTime() + (lastChange.getTime() - createdAt.getTime()) * frac);
      this.event(i === arr.length - 1 ? lastChange : when, SYSTEM, 'workstream.status_changed', { type: 'workstream', id }, id, {
        key: o.key, from: o.path[i], to,
      });
    });
    if (o.override === 'canceled')
      this.event(lastChange, actor, 'workstream.updated', { type: 'workstream', id }, id, { key: o.key, fields: ['statusOverride'] });
    return id;
  }

  /** Criterion progress events for a workstream (criteria must already exist). */
  criterionEvents(workstreamId: string, key: string, items: { daysAgo: number; text: string; state: AcceptanceCriterion['state']; by: string }[]) {
    for (const c of items)
      this.event(this.at(c.daysAgo), user(c.by), 'criterion.updated', { type: 'workstream', id: workstreamId }, workstreamId, {
        change: 'updated', text: c.text, state: c.state,
      });
    void key;
  }

  /** Kept so older seed stories compile. A Delta session URL is stored on the workstream. */
  execution(workstreamId: string, o: ExecOpts): string {
    if (o.session && isDeltaThreadUrl(o.session)) {
      const ws = this.data.workstreams.find((w) => w.id === workstreamId);
      if (ws) ws.deltaThreadUrl = o.session;
    }
    return uid('ex');
  }

  dependency(fromType: 'workstream' | 'execution', fromId: string, toType: 'workstream' | 'execution', toId: string, toWorkstreamId: string, daysAgo: number) {
    if (fromType !== 'workstream' || toType !== 'workstream') return '';
    const id = uid('dp');
    this.data.dependencies.push({ id, workspaceId: this.workspaceId, fromType, fromId, toType, toId, createdAt: this.at(daysAgo) });
    this.event(this.at(daysAgo), SYSTEM, 'dependency.added', { type: toType, id: toId }, toWorkstreamId, { dependencyId: id, from: { type: fromType, id: fromId }, to: { type: toType, id: toId } });
    return id;
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
    this.data.inputRequests.push({
      id, workspaceId: this.workspaceId, workstreamId, question: o.question, options: o.options ?? null,
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
    const isPr = o.kind === 'pull_request' || o.kind === 'merge_request';
    this.data.artifacts.push({
      id, workspaceId: this.workspaceId, workstreamId, repositoryId: o.repo ?? null, kind: o.kind,
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
    this.bump('adr', o.number);
    this.data.decisions.push({
      id, workspaceId: this.workspaceId, key: `ADR-${o.number}`, number: o.number, title: o.title, statement: o.statement,
      rationale: o.rationale ?? null, status: o.status, originWorkstreamId: o.origin ?? null,
      relatedWorkstreamIds: o.related ?? [], supersededById: o.superseded ?? null, proposedBy: o.by,
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
    this.event(this.at(daysAgo), user(by), 'decision.superseded', { type: 'decision', id: decisionId }, d.originWorkstreamId ?? null, { key: d.key, title: d.title, supersededBy: byKey });
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
    const key = `${ISSUE_KEY_PREFIX[o.kind]}-${o.number}`;
    this.bump(`issue:${o.kind}`, o.number);
    this.data.issues.push({
      id, workspaceId: this.workspaceId, key, number: o.number, kind: o.kind, title: o.title, body: o.body ?? null, source: o.source ?? 'manual',
      reporterName: o.reporterName ?? null, reporterId: o.reporter ?? null, assigneeId: o.assignee ?? null, teamId: o.team ?? null, priority: o.priority ?? 'none', status: o.status,
      workstreamIds: o.workstreams ?? [], milestoneIds: o.milestones ?? [], aliases: [], estimate: o.estimate ?? null,
      startedAt: STARTED.has(o.status) || FINISHED.has(o.status) ? this.at(o.moved ?? o.created) : null,
      completedAt: FINISHED.has(o.status) ? this.at(o.moved ?? o.created) : null,
      duplicateOfId: o.duplicateOf ?? null, externalUrl: o.url ?? null,
      createdAt: this.at(o.created), updatedAt: this.at(o.moved ?? o.created),
    });
    const subj: SubjectRef = { type: 'issue', id };
    this.event(this.at(o.created), o.reporter ? user(o.reporter) : SYSTEM, 'issue.created', subj, null, { key, kind: o.kind, title: o.title, status: 'backlog' });
    if (o.status !== 'backlog' && o.moved !== undefined) {
      const targets = o.workstreams?.length ? o.workstreams : [null];
      for (const w of targets)
        this.event(this.at(o.moved), user(o.movedBy!), 'issue.status_changed', subj, w, { key, from: 'backlog', to: o.status, workstreamIds: o.workstreams ?? [] });
    }
    return id;
  }

  comment(subject: SubjectRef | { type: 'execution'; id: string }, workstreamId: string | null, author: ActorRef, body: string, daysAgo: number) {
    const id = uid('cm');
    const resolved: SubjectRef = subject.type === 'execution' && workstreamId ? { type: 'workstream', id: workstreamId } : (subject as SubjectRef);
    this.data.comments.push({ id, workspaceId: this.workspaceId, subject: resolved, author, body, createdAt: this.at(daysAgo), updatedAt: this.at(daysAgo) });
    this.event(this.at(daysAgo), author, 'comment.created', resolved, workstreamId, { commentId: id, excerpt: body.slice(0, 200) });
    return id;
  }

  view(owner: string, name: string, entity: ViewEntity | 'execution', o: { filters?: ViewFilter[]; sort?: { field: string; direction: 'asc' | 'desc' }; groupBy?: string; layout?: ViewLayout; shared: boolean; created: number }) {
    if (entity === 'execution') return;
    this.data.views.push({
      id: uid('vw'), workspaceId: this.workspaceId, ownerId: owner, name, entity, filters: o.filters ?? [], sort: o.sort ?? null,
      groupBy: o.groupBy ?? null, layout: o.layout ?? 'list', shared: o.shared, sharing: { visibility: o.shared ? 'workspace' : 'private', grants: [] }, publicTokenHash: null, publicTokenEnc: null, createdAt: this.at(o.created), updatedAt: this.at(o.created),
    });
  }
}
