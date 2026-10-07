import { INTAKE_KEY_PREFIX, TERMINAL_EXECUTION_STATES } from '../../contracts/domain.js';
import type {
  AcceptanceCriterion,
  ActorRef,
  ArtifactKind,
  ArtifactProvider,
  ArtifactState,
  CiState,
  DecisionStatus,
  ExecutionProvider,
  ExecutionState,
  GitProvider,
  IntakeKind,
  IntakeSource,
  IntakeState,
  Priority,
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
  ExecutionEntity,
  InputRequestEntity,
  IntakeItemEntity,
  IntegrationConnectionEntity,
  MembershipEntity,
  RepositoryEntity,
  SavedViewEntity,
  TeamEntity,
  UserEntity,
  WorkspaceEntity,
  WorkstreamEntity,
} from '../entities/index.js';

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
  workstreams: Rows<WorkstreamEntity>;
  executions: Rows<ExecutionEntity>;
  inputRequests: Rows<InputRequestEntity>;
  intake: Rows<IntakeItemEntity>;
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
  state: ExecutionState;
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
      users: [], workspace: {}, memberships: [], agents: [], teams: [], repositories: [], workstreams: [],
      executions: [], inputRequests: [], intake: [], artifacts: [], decisions: [], dependencies: [], comments: [],
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
    const host = provider === 'github' ? 'github.com' : 'gitlab.com';
    this.data.repositories.push({
      id, workspaceId: this.workspaceId, provider, fullName, url: `https://${host}/${fullName}`, defaultBranch: 'main', teamIds, createdAt: this.at(58),
    });
    return id;
  }

  workstream(o: {
    key: string;
    title: string;
    objective: string;
    context?: string;
    owner: string;
    participating?: string[];
    accountable?: string;
    repos?: string[];
    criteria?: [string, AcceptanceCriterion['state']][];
    priority?: Priority;
    labels?: string[];
    /** status progression, oldest first; last = current derived status */
    path: WorkstreamStatus[];
    override?: 'draft' | 'canceled';
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
      objective: o.objective,
      context: o.context ?? null,
      ownerTeamId: o.owner,
      participatingTeamIds: o.participating ?? [],
      accountableUserId: o.accountable ?? null,
      repositoryIds: o.repos ?? [],
      acceptanceCriteria: (o.criteria ?? []).map(([text, state]) => ({ id: uid('ac'), text, state })),
      priority: o.priority ?? 'medium',
      labels: o.labels ?? [],
      status: o.override ?? current,
      derivedStatus: current,
      statusOverride: o.override ?? null,
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

  execution(workstreamId: string, o: ExecOpts): string {
    const id = uid('ex');
    const terminal = TERMINAL_EXECUTION_STATES.includes(o.state);
    const startedDays = o.state === 'queued' ? undefined : (o.started ?? o.created);
    this.data.executions.push({
      id,
      workspaceId: this.workspaceId,
      workstreamId,
      parentExecutionId: o.parent ?? null,
      title: o.title,
      description: o.description ?? null,
      teamId: o.team ?? null,
      repositoryIds: o.repos ?? [],
      performers: o.performers,
      provider: o.provider,
      state: o.state,
      sessionUrl: o.session ?? null,
      branch: o.branch ?? null,
      progressNote: o.note ?? null,
      startedAt: startedDays !== undefined ? this.at(startedDays) : null,
      completedAt: terminal ? this.at(o.done ?? 0.1) : null,
      createdAt: this.at(o.created),
      updatedAt: this.at(o.notes?.length ? Math.min(...o.notes.map(([d]) => d)) : (o.done ?? startedDays ?? o.created)),
    });
    const lead = o.performers[0] ?? SYSTEM;
    const subj: SubjectRef = { type: 'execution', id };
    this.event(this.at(o.created), lead.type === 'team' ? SYSTEM : lead, 'execution.created', subj, workstreamId, { title: o.title, provider: o.provider, state: 'queued' });
    if (startedDays !== undefined)
      this.event(this.at(startedDays), lead.type === 'team' ? SYSTEM : lead, 'execution.state_changed', subj, workstreamId, { title: o.title, from: 'queued', to: o.state === 'completed' || o.state === 'failed' || o.state === 'canceled' ? 'running' : o.state });
    for (const [d, text] of o.notes ?? [])
      this.event(this.at(d), lead.type === 'team' ? SYSTEM : lead, 'execution.progress', subj, workstreamId, { title: o.title, note: text });
    if (terminal)
      this.event(this.at(o.done ?? 0.1), lead.type === 'team' ? SYSTEM : lead, 'execution.state_changed', subj, workstreamId, { title: o.title, from: 'running', to: o.state });
    for (const dep of o.deps ?? []) this.dependency('execution', dep, 'execution', id, workstreamId, o.created - 0.01);
    return id;
  }

  dependency(fromType: 'workstream' | 'execution', fromId: string, toType: 'workstream' | 'execution', toId: string, toWorkstreamId: string, daysAgo: number) {
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
      id, workspaceId: this.workspaceId, workstreamId, executionId: o.execution ?? null, question: o.question, options: o.options ?? null,
      requestedBy: o.by, assigneeUserId: o.assignee ?? null, state: o.answer ? 'answered' : 'open', answer: o.answer?.text ?? null,
      answeredById: o.answer?.by ?? null, createdAt: this.at(o.created), answeredAt: o.answer ? this.at(o.answer.daysAgo) : null,
    });
    const subj: SubjectRef = { type: 'input_request', id };
    this.event(this.at(o.created), o.by, 'input.requested', subj, workstreamId, { question: o.question, executionId: o.execution });
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
      id, workspaceId: this.workspaceId, workstreamId, executionId: o.execution ?? null, repositoryId: o.repo ?? null, kind: o.kind,
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
      rationale: o.rationale ?? null, status: o.status, originWorkstreamId: o.origin ?? null, originExecutionId: o.originExecution ?? null,
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

  intake(o: {
    kind: IntakeKind;
    number: number;
    title: string;
    body?: string;
    source?: IntakeSource;
    reporterName?: string;
    reporter?: string;
    team?: string;
    priority?: Priority;
    state: IntakeState;
    workstreams?: string[];
    duplicateOf?: string;
    url?: string;
    created: number;
    triaged?: number;
    triagedBy?: string;
  }) {
    const id = uid('in');
    const key = `${INTAKE_KEY_PREFIX[o.kind]}-${o.number}`;
    this.bump(`intake:${o.kind}`, o.number);
    this.data.intake.push({
      id, workspaceId: this.workspaceId, key, number: o.number, kind: o.kind, title: o.title, body: o.body ?? null, source: o.source ?? 'manual',
      reporterName: o.reporterName ?? null, reporterId: o.reporter ?? null, teamId: o.team ?? null, priority: o.priority ?? 'none', state: o.state,
      workstreamIds: o.workstreams ?? [], duplicateOfId: o.duplicateOf ?? null, externalUrl: o.url ?? null,
      createdAt: this.at(o.created), updatedAt: this.at(o.triaged ?? o.created),
    });
    const subj: SubjectRef = { type: 'intake', id };
    this.event(this.at(o.created), o.reporter ? user(o.reporter) : SYSTEM, 'intake.created', subj, null, { key, kind: o.kind, title: o.title });
    if (o.state !== 'new' && o.triaged !== undefined) {
      const targets = o.workstreams?.length ? o.workstreams : [null];
      for (const w of targets)
        this.event(this.at(o.triaged), user(o.triagedBy!), 'intake.triaged', subj, w, { key, state: o.state, workstreamIds: o.workstreams ?? [] });
    }
    return id;
  }

  comment(subject: SubjectRef, workstreamId: string | null, author: ActorRef, body: string, daysAgo: number) {
    const id = uid('cm');
    this.data.comments.push({ id, workspaceId: this.workspaceId, subject, author, body, createdAt: this.at(daysAgo), updatedAt: this.at(daysAgo) });
    this.event(this.at(daysAgo), author, 'comment.created', subject, workstreamId, { commentId: id, excerpt: body.slice(0, 200) });
    return id;
  }

  view(owner: string, name: string, entity: ViewEntity, o: { filters?: ViewFilter[]; sort?: { field: string; direction: 'asc' | 'desc' }; groupBy?: string; layout?: ViewLayout; shared: boolean; created: number }) {
    this.data.views.push({
      id: uid('vw'), workspaceId: this.workspaceId, ownerId: owner, name, entity, filters: o.filters ?? [], sort: o.sort ?? null,
      groupBy: o.groupBy ?? null, layout: o.layout ?? 'list', shared: o.shared, createdAt: this.at(o.created), updatedAt: this.at(o.created),
    });
  }
}
