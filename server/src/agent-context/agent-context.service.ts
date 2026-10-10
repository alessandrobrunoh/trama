import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { resolveWorkstreamPlans } from '../contracts/domain.js';
import type { AcceptanceCriterion, ActorRef, ArtifactKind, CiState, DeliveryState, ReviewState, CompletionGap, WorkstreamCompletion, WorkstreamPlan, WorkstreamStatus, StatusSource } from '../contracts/domain.js';
import { statusSourceOf } from '../status/completion-proof.js';
import {
  AgentEntity,
  ArtifactEntity,
  DecisionEntity,
  DependencyEntity,
  DocumentEntity,
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

/** What each completion gap means for whoever reads the briefing. */
export const GAP_TEXT: Record<CompletionGap, string> = {
  no_criteria: 'no acceptance criteria (add at least one; it defines done)',
  criteria_pending: 'acceptance criteria not met',
  blocked: 'blocked (failing CI, conflicts or an unresolved dependency)',
  needs_input: 'waiting on a person (open input request or proposed decision)',
  no_delivery: 'no delivery yet (merged PR, release or deployment, or every issue done)',
};
/** " _(declared by Claude (agent) on 2026-10-09; proof: PR #12; note)_" or " _(met without proof)_". */
function criterionProof(a: AgentCriterion): string {
  const proof = (a.evidenceArtifacts ?? []).map((e) => `${e.kind.replace('_', ' ')}${e.externalId ? ` ${e.externalId}` : ''} ${e.title}`);
  if (a.evidence?.note) proof.push(a.evidence.note);
  const isUser = a.verifiedBy?.type === 'user';
  const by = a.verifiedBy
    ? `${isUser ? 'verified' : 'declared'} by ${a.verifiedByName ?? a.verifiedBy.type}${isUser ? '' : ` (${a.verifiedBy.type})`}${a.verifiedAt ? ` on ${a.verifiedAt.slice(0, 10)}` : ''}`
    : '';
  if (!proof.length) return ` _(${[by, 'met without proof'].filter(Boolean).join('; ')})_`;
  return ` _(${[by, `proof: ${proof.join('; ')}`].filter(Boolean).join('; ')})_`;
}
/** One line of the Plan section: the plan, its revision and where its approval stands. */
export function planLine(p: WorkstreamPlan): string {
  const where = p.documentId ? `Trama document ${p.documentId}` : (p.url ?? 'no link');
  const rev = p.revision ? ` · rev ${p.revision}` : '';
  const state = p.changedSinceApproval
    ? `plan changed since approval (approved ${p.approved?.revision} in ${p.approved?.decisionKey}) — propose a new decision`
    : p.approved
      ? `approved${p.approved.revision ? ` at ${p.approved.revision}` : ''} (${p.approved.decisionKey})`
      : p.proposedDecisionKey
        ? `not approved yet: ${p.proposedDecisionKey} is proposed and waits for a person`
        : 'not approved: propose a decision "Plan for <KEY> approved at <revision>" for a person to accept';
  const pending = p.changedSinceApproval && p.proposedDecisionKey ? `; ${p.proposedDecisionKey} proposed and waiting for a person` : '';
  return `- ${p.title} — ${where}${rev} · ${state}${pending}`;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));

/** A criterion as the briefing shows it: who vouched for `met`, and the proof, resolved to names. */
export type AgentCriterion = AcceptanceCriterion & {
  verifiedByName?: string;
  evidenceArtifacts?: { kind: ArtifactKind; title: string; externalId?: string }[];
};

export interface AgentContext {
  key: string;
  id: string;
  title: string;
  /** Outcome status. `shipped` means the outcome is achieved, not merely that code landed. */
  status: string;
  /** Delivery evidence (PR / release / deployment); a merged PR does not by itself mean the outcome is done. */
  delivery: DeliveryState;
  /** Derived status from the facts. Differs from `status` only when a person pinned `statusOverride`. */
  derivedStatus: WorkstreamStatus;
  /** Present when a person pinned the status by hand; that is not evidence the outcome is achieved. */
  statusOverride?: WorkstreamStatus;
  /** Where `status` comes from: the facts (`derived`), a manual pin (`override`) or a historic shipped without criteria (`legacy`). */
  statusSource: StatusSource;
  /** Whether the outcome is achieved and what is missing. Computed by the server, never re-derive it. */
  completion: WorkstreamCompletion;
  priority: string;
  targetDate?: string;
  description?: string;
  objective: string;
  context?: string;
  deltaThreadUrl: string;
  acceptanceCriteria: AgentCriterion[];
  /** Plan documents attached to the workstream and whether an accepted decision approves their current revision. */
  plans: WorkstreamPlan[];
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

    const docIds = artifacts.flatMap((a) => (a.documentId ? [a.documentId] : []));
    const docs = docIds.length ? await repo(DocumentEntity).find({ where: { workspaceId, id: In(docIds) }, select: { id: true, version: true } }) : [];
    const plans = resolveWorkstreamPlans({
      workstreamId: ws.id,
      artifacts,
      decisions,
      documentVersions: new Map(docs.map((d) => [d.id, d.version])),
    });

    const owner = teamById.get(ws.ownerTeamId);
    return {
      key: ws.key,
      id: ws.id,
      title: ws.title,
      status: ws.status,
      delivery: ws.delivery,
      derivedStatus: ws.derivedStatus,
      ...(ws.statusOverride ? { statusOverride: ws.statusOverride } : {}),
      statusSource: statusSourceOf(ws),
      completion: ws.completion,
      priority: ws.priority,
      ...(ws.targetDate ? { targetDate: ws.targetDate.toISOString().slice(0, 10) } : {}),
      objective: ws.objective,
      ...(ws.description ? { description: ws.description } : {}),
      deltaThreadUrl: ws.deltaThreadUrl,
      ...(ws.context ? { context: ws.context } : {}),
      acceptanceCriteria: ws.acceptanceCriteria.map((c) => ({
        ...c,
        ...(c.verifiedBy ? { verifiedByName: nameOf(c.verifiedBy) } : {}),
        ...(c.evidence?.artifactIds.length
          ? {
              evidenceArtifacts: c.evidence.artifactIds.flatMap((id) => {
                const a = artifacts.find((x) => x.id === id);
                return a ? [{ kind: a.kind, title: a.title, ...(a.externalId ? { externalId: a.externalId } : {}) }] : [];
              }),
            }
          : {}),
      })),
      plans,
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
    const delivery = c.delivery.replace('_', ' ');
    const overridden =
      c.statusSource === 'override'
        ? ` (pinned manually; the facts say ${c.derivedStatus.replace('_', ' ')})`
        : c.statusSource === 'legacy'
          ? ' (historic: shipped before acceptance criteria were required, not backed by proof)'
          : '';
    out.push(`# ${c.key} — ${c.title}`, '', `Outcome status: ${status}${overridden} · Delivery: ${delivery} · Priority: ${c.priority}${c.targetDate ? ` · Target: ${c.targetDate}` : ''}`, '');
    out.push(
      c.completion.achieved
        ? '> Outcome achieved: nothing is missing.'
        : `> Outcome not achieved. Missing: ${c.completion.gaps.map((g) => GAP_TEXT[g]).join('; ')}.${c.delivery !== 'none' && c.delivery !== 'in_review' ? ' Do not treat this work as done.' : ''}`,
      '',
    );
    section('Description', [c.description?.trim() || '_No description yet._']);
    if (c.deltaThreadUrl) section('Delta thread', [c.deltaThreadUrl]);
    section('Objective', [c.objective.trim() || '_No objective written yet._']);
    section(
      'Acceptance Criteria',
      c.acceptanceCriteria.map((a) => `- [${a.state === 'met' ? 'x' : ' '}] ${a.text}${a.state === 'in_progress' ? ' _(in progress)_' : ''}${a.state === 'met' ? criterionProof(a) : ''}`),
    );
    section('Plan', c.plans.map(planLine));
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
