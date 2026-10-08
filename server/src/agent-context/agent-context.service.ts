import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AcceptanceCriterion, ActorRef, ArtifactKind, CiState, ReviewState } from '../contracts/domain.js';
import {
  AgentEntity,
  ArtifactEntity,
  DecisionEntity,
  DependencyEntity,
  DomainEventEntity,
  InputRequestEntity,
  IssueEntity,
  RepositoryEntity,
  TeamEntity,
  UserEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { WorkstreamsService } from '../workstreams/workstreams.service.js';

export const RECENT_PROGRESS = 10;
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

export interface AgentContext {
  key: string;
  id: string;
  title: string;
  status: string;
  priority: string;
  targetDate?: string;
  description?: string;
  objective: string;
  context?: string;
  deltaThreadUrl: string;
  acceptanceCriteria: AcceptanceCriterion[];
  accountable?: string;
  teams: { owner: { key: string; name: string }; participating: { key: string; name: string }[] };
  repositories: { fullName: string; url: string; defaultBranch: string; provider: string }[];
  dependencies: {
    /** what this workstream waits for */
    blockedBy: { type: 'workstream'; key?: string; title: string; state: string; resolved: boolean }[];
    /** what waits for this workstream */
    blocking: { type: 'workstream'; key?: string; title: string; state: string }[];
  };
  decisions: {
    key: string;
    title: string;
    status: string;
    relation: 'origin' | 'related';
    statement: string;
    rationale?: string;
    supersededBy?: string;
  }[];
  issues: { key: string; title: string; kind: string; status: string }[];
  artifacts: {
    kind: ArtifactKind;
    title: string;
    externalId?: string;
    url?: string;
    state: string;
    ci?: CiState;
    review?: ReviewState;
    hasConflicts?: boolean;
    environment?: string;
  }[];
  openInputRequests: { id: string; question: string; options?: string[] }[];
  recentProgress: { at: string; by: string; text: string }[];
}

@Injectable()
export class AgentContextService {
  constructor(
    private readonly ds: DataSource,
    private readonly workstreams: WorkstreamsService,
  ) {}

  async build(workspaceId: string, idOrKey: string): Promise<AgentContext> {
    const ws = await this.workstreams.get(workspaceId, idOrKey);
    const where = { workspaceId };
    const repo = <T extends object>(e: new () => T) => this.ds.getRepository(e);
    const [teams, repos, artifacts, inputs, decisions, deps, issueRows, agents, users] = await Promise.all([
      repo(TeamEntity).find({ where }),
      repo(RepositoryEntity).find({ where }),
      repo(ArtifactEntity).find({ where: { workstreamId: ws.id }, order: { createdAt: 'ASC' } }),
      repo(InputRequestEntity).find({ where: { workstreamId: ws.id, state: 'open' }, order: { createdAt: 'ASC' } }),
      repo(DecisionEntity).find({ where, order: { number: 'ASC' } }),
      repo(DependencyEntity).find({ where }),
      repo(IssueEntity).find({ where, order: { number: 'ASC' } }),
      repo(AgentEntity).find({ where }),
      repo(UserEntity).find(),
    ]);
    const names = new Map<string, string>([...agents.map((a) => [a.id, a.name] as const), ...users.map((u) => [u.id, u.name] as const)]);
    const nameOf = (a?: ActorRef | null) => (a?.id ? (names.get(a.id) ?? a.id) : 'system');
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const decisionById = new Map(decisions.map((d) => [d.id, d]));

    const lookupNode = async (id: string) => {
      const w = await repo(WorkstreamEntity).findOneBy({ id });
      return w ? { type: 'workstream' as const, key: w.key, title: w.title, state: w.status, resolved: w.status === 'shipped' } : null;
    };
    const blockedBy: AgentContext['dependencies']['blockedBy'] = [];
    const blocking: AgentContext['dependencies']['blocking'] = [];
    for (const d of deps) {
      if (d.fromType !== 'workstream' || d.toType !== 'workstream') continue;
      if (d.toId === ws.id && d.fromId !== ws.id) {
        const n = await lookupNode(d.fromId);
        if (n) blockedBy.push(n);
      } else if (d.fromId === ws.id && d.toId !== ws.id) {
        const n = await lookupNode(d.toId);
        if (n) blocking.push({ type: n.type, key: n.key, title: n.title, state: n.state });
      }
    }

    const mine = decisions.filter((d) => d.originWorkstreamId === ws.id || d.relatedWorkstreamIds.includes(ws.id));
    const ctxDecisions: AgentContext['decisions'] = mine
      .filter((d) => d.status !== 'rejected')
      .map((d) => ({
        key: d.key,
        title: d.title,
        status: d.status,
        relation: d.originWorkstreamId === ws.id ? ('origin' as const) : ('related' as const),
        statement: d.statement,
        ...(d.rationale ? { rationale: d.rationale } : {}),
        ...(d.supersededById && decisionById.get(d.supersededById) ? { supersededBy: decisionById.get(d.supersededById)!.key } : {}),
      }));

    const events = await repo(DomainEventEntity)
      .createQueryBuilder('e')
      .where('e.workspaceId = :workspaceId AND e.workstreamId = :w', { workspaceId, w: ws.id })
      .andWhere(`e.type IN ('workstream.status_changed', 'input.answered', 'comment.created')`)
      .orderBy('e.at', 'DESC')
      .limit(RECENT_PROGRESS)
      .getMany();
    const recentProgress = events.map((e) => {
      const d = e.data as Record<string, unknown>;
      const text =
        e.type === 'workstream.status_changed'
          ? `status ${str(d.from)} → ${str(d.to)}`
          : e.type === 'comment.created'
            ? str(d.excerpt) || str(d.body)
            : `input answered: ${str(d.answer)}`;
      return { at: e.at.toISOString(), by: nameOf(e.actor), text };
    });

    const owner = teamById.get(ws.ownerTeamId);
    return {
      key: ws.key,
      id: ws.id,
      title: ws.title,
      status: ws.status,
      priority: ws.priority,
      ...(ws.targetDate ? { targetDate: ws.targetDate.toISOString().slice(0, 10) } : {}),
      objective: ws.objective,
      ...(ws.description ? { description: ws.description } : {}),
      deltaThreadUrl: ws.deltaThreadUrl,
      ...(ws.context ? { context: ws.context } : {}),
      acceptanceCriteria: ws.acceptanceCriteria,
      ...(ws.accountableUserId && names.get(ws.accountableUserId) ? { accountable: names.get(ws.accountableUserId) } : {}),
      teams: {
        owner: { key: owner?.key ?? '', name: owner?.name ?? '' },
        participating: ws.participatingTeamIds.flatMap((id) => (teamById.get(id) ? [{ key: teamById.get(id)!.key, name: teamById.get(id)!.name }] : [])),
      },
      repositories: ws.repositoryIds.flatMap((id) => {
        const r = repos.find((x) => x.id === id);
        return r ? [{ fullName: r.fullName, url: r.url, defaultBranch: r.defaultBranch, provider: r.provider }] : [];
      }),
      dependencies: { blockedBy, blocking },
      decisions: ctxDecisions,
      issues: issueRows
        .filter((i) => i.workstreamIds.includes(ws.id))
        .map((i) => ({ key: i.key, title: i.title, kind: i.kind, status: i.status })),
      artifacts: artifacts.map((a) => ({
        kind: a.kind,
        title: a.title,
        ...(a.externalId ? { externalId: a.externalId } : {}),
        ...(a.url ? { url: a.url } : {}),
        state: a.state,
        ...(a.ci ? { ci: a.ci } : {}),
        ...(a.review ? { review: a.review } : {}),
        ...(a.hasConflicts ? { hasConflicts: true } : {}),
        ...(a.environment ? { environment: a.environment } : {}),
      })),
      openInputRequests: inputs.map((r) => ({
        id: r.id,
        question: r.question,
        ...(r.options?.length ? { options: r.options } : {}),
      })),
      recentProgress,
    };
  }

  /** Markdown in the shape of VISION.md's Agent Context example. */
  static toMarkdown(c: AgentContext): string {
    const out: string[] = [];
    const section = (title: string, lines: string[]) => {
      if (lines.length) out.push(`## ${title}`, '', ...lines, '');
    };
    const status = c.status.replace('_', ' ');
    out.push(`# ${c.key} — ${c.title}`, '', `Status: ${status} · Priority: ${c.priority}${c.targetDate ? ` · Target: ${c.targetDate}` : ''}`, '');
    section('Description', [c.description?.trim() || '_No description yet._']);
    section('Delta thread', [c.deltaThreadUrl]);
    section('Objective', [c.objective.trim() || '_No objective written yet._']);
    section(
      'Acceptance Criteria',
      c.acceptanceCriteria.map((a) => `- [${a.state === 'met' ? 'x' : ' '}] ${a.text}${a.state === 'in_progress' ? ' _(in progress)_' : ''}`),
    );
    if (c.context?.trim()) section('Context', [c.context.trim()]);
    section('Repositories', c.repositories.map((r) => `- ${r.fullName} — ${r.url} (default branch: ${r.defaultBranch})`));
    section('Teams', [
      `- Owner: ${c.teams.owner.name} (${c.teams.owner.key})`,
      ...(c.teams.participating.length ? [`- Participating: ${c.teams.participating.map((t) => `${t.name} (${t.key})`).join(', ')}`] : []),
      ...(c.accountable ? [`- Accountable: ${c.accountable}`] : []),
    ]);
    const deps = [
      ...c.dependencies.blockedBy.map(
        (d) => `- Waiting on ${d.key ? `${d.key} — ` : ''}${d.title} (${d.type}: ${d.state.replace('_', ' ')}${d.resolved ? ', resolved' : ', not resolved'})`,
      ),
      ...c.dependencies.blocking.map((d) => `- Blocks ${d.key ? `${d.key} — ` : ''}${d.title} (${d.type}: ${d.state.replace('_', ' ')})`),
    ];
    section('Dependencies', deps);
    const line = (d: AgentContext['decisions'][number]) =>
      `- ${d.key} ${d.title}: ${d.statement.trim().split('\n')[0]}${d.rationale ? ` — because ${d.rationale.trim().split('\n')[0]}` : ''} (${d.relation === 'origin' ? 'originated here' : 'related'})`;
    section('Decisions', [
      ...c.decisions.filter((d) => d.status === 'accepted').map(line),
      ...c.decisions.filter((d) => d.status === 'proposed').map((d) => `- ${d.key} ${d.title} — proposed, not yet accepted`),
      ...c.decisions.filter((d) => d.status === 'superseded').map((d) => `- ${d.key} ${d.title} — superseded${d.supersededBy ? ` by ${d.supersededBy}` : ''}; do not follow`),
    ]);
    section('Related issues', c.issues.map((i) => `- ${i.key} ${i.title} (${i.kind}, ${i.status.replace(/_/g, ' ')})`));
    section(
      'Artifacts',
      c.artifacts.map((a) => {
        const bits = [a.state, a.ci ? `CI ${a.ci}` : '', a.review && a.review !== 'none' ? `review ${a.review.replace('_', ' ')}` : '', a.hasConflicts ? 'has conflicts' : '', a.environment ?? ''].filter(Boolean);
        return `- ${a.kind.replace('_', ' ')}${a.externalId ? ` ${a.externalId}` : ''}: ${a.title}${a.url ? ` — ${a.url}` : ''} (${bits.join(', ')})`;
      }),
    );
    section(
      'Open input requests',
      c.openInputRequests.map((r) => `- ${r.question}${r.options ? ` [options: ${r.options.join(' / ')}]` : ''}`),
    );
    section(
      'Recent progress',
      c.recentProgress.map((p) => `- ${p.at.slice(0, 16).replace('T', ' ')} — ${p.by}: ${p.text}`),
    );
    return `${out.join('\n').trimEnd()}\n`;
  }
}
