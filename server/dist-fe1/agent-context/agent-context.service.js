var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AgentEntity, ArtifactEntity, DecisionEntity, DependencyEntity, DomainEventEntity, ExecutionEntity, InputRequestEntity, IntakeItemEntity, RepositoryEntity, TeamEntity, UserEntity, WorkstreamEntity, } from '../database/entities/index.js';
import { WorkstreamsService } from '../workstreams/workstreams.service.js';
export const RECENT_PROGRESS = 10;
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
let AgentContextService = class AgentContextService {
    ds;
    workstreams;
    constructor(ds, workstreams) {
        this.ds = ds;
        this.workstreams = workstreams;
    }
    async build(workspaceId, idOrKey) {
        const ws = await this.workstreams.get(workspaceId, idOrKey);
        const where = { workspaceId };
        const repo = (e) => this.ds.getRepository(e);
        const [teams, repos, execs, artifacts, inputs, decisions, deps, intake, agents, users] = await Promise.all([
            repo(TeamEntity).find({ where }),
            repo(RepositoryEntity).find({ where }),
            repo(ExecutionEntity).find({ where: { workstreamId: ws.id }, order: { createdAt: 'ASC' } }),
            repo(ArtifactEntity).find({ where: { workstreamId: ws.id }, order: { createdAt: 'ASC' } }),
            repo(InputRequestEntity).find({ where: { workstreamId: ws.id, state: 'open' }, order: { createdAt: 'ASC' } }),
            repo(DecisionEntity).find({ where, order: { number: 'ASC' } }),
            repo(DependencyEntity).find({ where }),
            repo(IntakeItemEntity).find({ where, order: { number: 'ASC' } }),
            repo(AgentEntity).find({ where }),
            repo(UserEntity).find(),
        ]);
        const names = new Map([...agents.map((a) => [a.id, a.name]), ...users.map((u) => [u.id, u.name])]);
        const nameOf = (a) => (a?.id ? (names.get(a.id) ?? a.id) : 'system');
        const teamById = new Map(teams.map((t) => [t.id, t]));
        const execIds = new Set(execs.map((e) => e.id));
        const execById = new Map(execs.map((e) => [e.id, e]));
        const decisionById = new Map(decisions.map((d) => [d.id, d]));
        const lookupNode = async (type, id) => {
            if (type === 'workstream') {
                const w = await repo(WorkstreamEntity).findOneBy({ id });
                return w ? { type, key: w.key, title: w.title, state: w.status, resolved: w.status === 'shipped' } : null;
            }
            const e = await repo(ExecutionEntity).findOneBy({ id });
            if (!e)
                return null;
            const w = await repo(WorkstreamEntity).findOneBy({ id: e.workstreamId });
            return { type, key: w?.key, title: e.title, state: e.state, resolved: e.state === 'completed' };
        };
        const blockedBy = [];
        const blocking = [];
        for (const d of deps) {
            const toMine = d.toId === ws.id || execIds.has(d.toId);
            const fromMine = d.fromId === ws.id || execIds.has(d.fromId);
            if (toMine && !fromMine) {
                const n = await lookupNode(d.fromType, d.fromId);
                if (n)
                    blockedBy.push(n);
            }
            else if (fromMine && !toMine) {
                const n = await lookupNode(d.toType, d.toId);
                if (n)
                    blocking.push({ type: n.type, key: n.key, title: n.title, state: n.state });
            }
        }
        const mine = decisions.filter((d) => d.originWorkstreamId === ws.id || d.relatedWorkstreamIds.includes(ws.id));
        const ctxDecisions = mine
            .filter((d) => d.status !== 'rejected')
            .map((d) => ({
            key: d.key,
            title: d.title,
            status: d.status,
            relation: d.originWorkstreamId === ws.id ? 'origin' : 'related',
            statement: d.statement,
            ...(d.rationale ? { rationale: d.rationale } : {}),
            ...(d.supersededById && decisionById.get(d.supersededById) ? { supersededBy: decisionById.get(d.supersededById).key } : {}),
        }));
        const events = await repo(DomainEventEntity)
            .createQueryBuilder('e')
            .where('e.workspaceId = :workspaceId AND e.workstreamId = :w', { workspaceId, w: ws.id })
            .andWhere(`e.type IN ('execution.progress', 'execution.state_changed', 'input.answered')`)
            .orderBy('e.at', 'DESC')
            .limit(RECENT_PROGRESS)
            .getMany();
        const recentProgress = events.map((e) => {
            const exec = execById.get(e.subject.id);
            const d = e.data;
            const text = e.type === 'execution.progress'
                ? str(d.note)
                : e.type === 'execution.state_changed'
                    ? `state ${str(d.from)} → ${str(d.to)}`
                    : `input answered: ${str(d.answer)}`;
            return { at: e.at.toISOString(), by: nameOf(e.actor), text, ...(exec ? { execution: exec.title } : {}) };
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
            ...(ws.context ? { context: ws.context } : {}),
            acceptanceCriteria: ws.acceptanceCriteria,
            ...(ws.accountableUserId && names.get(ws.accountableUserId) ? { accountable: names.get(ws.accountableUserId) } : {}),
            teams: {
                owner: { key: owner?.key ?? '', name: owner?.name ?? '' },
                participating: ws.participatingTeamIds.flatMap((id) => (teamById.get(id) ? [{ key: teamById.get(id).key, name: teamById.get(id).name }] : [])),
            },
            repositories: ws.repositoryIds.flatMap((id) => {
                const r = repos.find((x) => x.id === id);
                return r ? [{ fullName: r.fullName, url: r.url, defaultBranch: r.defaultBranch, provider: r.provider }] : [];
            }),
            dependencies: { blockedBy, blocking },
            decisions: ctxDecisions,
            intake: intake
                .filter((i) => i.workstreamIds.includes(ws.id))
                .map((i) => ({ key: i.key, title: i.title, kind: i.kind, state: i.state })),
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
            executions: execs.map((e) => ({
                id: e.id,
                title: e.title,
                state: e.state,
                provider: e.provider,
                ...(e.parentExecutionId ? { parentExecutionId: e.parentExecutionId } : {}),
                ...(e.progressNote ? { progressNote: e.progressNote } : {}),
            })),
            openInputRequests: inputs.map((r) => ({
                id: r.id,
                question: r.question,
                ...(r.options?.length ? { options: r.options } : {}),
                ...(r.executionId ? { executionId: r.executionId } : {}),
            })),
            recentProgress,
        };
    }
    static toMarkdown(c) {
        const out = [];
        const section = (title, lines) => {
            if (lines.length)
                out.push(`## ${title}`, '', ...lines, '');
        };
        const status = c.status.replace('_', ' ');
        out.push(`# ${c.key} — ${c.title}`, '', `Status: ${status} · Priority: ${c.priority}${c.targetDate ? ` · Target: ${c.targetDate}` : ''}`, '');
        section('Objective', [c.objective.trim() || '_No objective written yet._']);
        section('Acceptance Criteria', c.acceptanceCriteria.map((a) => `- [${a.state === 'met' ? 'x' : ' '}] ${a.text}${a.state === 'in_progress' ? ' _(in progress)_' : ''}`));
        if (c.context?.trim())
            section('Context', [c.context.trim()]);
        section('Repositories', c.repositories.map((r) => `- ${r.fullName} — ${r.url} (default branch: ${r.defaultBranch})`));
        section('Teams', [
            `- Owner: ${c.teams.owner.name} (${c.teams.owner.key})`,
            ...(c.teams.participating.length ? [`- Participating: ${c.teams.participating.map((t) => `${t.name} (${t.key})`).join(', ')}`] : []),
            ...(c.accountable ? [`- Accountable: ${c.accountable}`] : []),
        ]);
        const deps = [
            ...c.dependencies.blockedBy.map((d) => `- Waiting on ${d.key ? `${d.key} — ` : ''}${d.title} (${d.type}: ${d.state.replace('_', ' ')}${d.resolved ? ', resolved' : ', not resolved'})`),
            ...c.dependencies.blocking.map((d) => `- Blocks ${d.key ? `${d.key} — ` : ''}${d.title} (${d.type}: ${d.state.replace('_', ' ')})`),
        ];
        section('Dependencies', deps);
        const line = (d) => `- ${d.key} ${d.title}: ${d.statement.trim().split('\n')[0]}${d.rationale ? ` — because ${d.rationale.trim().split('\n')[0]}` : ''} (${d.relation === 'origin' ? 'originated here' : 'related'})`;
        section('Decisions', [
            ...c.decisions.filter((d) => d.status === 'accepted').map(line),
            ...c.decisions.filter((d) => d.status === 'proposed').map((d) => `- ${d.key} ${d.title} — proposed, not yet accepted`),
            ...c.decisions.filter((d) => d.status === 'superseded').map((d) => `- ${d.key} ${d.title} — superseded${d.supersededBy ? ` by ${d.supersededBy}` : ''}; do not follow`),
        ]);
        section('Related intake', c.intake.map((i) => `- ${i.key} ${i.title} (${i.kind}, ${i.state})`));
        section('Artifacts', c.artifacts.map((a) => {
            const bits = [a.state, a.ci ? `CI ${a.ci}` : '', a.review && a.review !== 'none' ? `review ${a.review.replace('_', ' ')}` : '', a.hasConflicts ? 'has conflicts' : '', a.environment ?? ''].filter(Boolean);
            return `- ${a.kind.replace('_', ' ')}${a.externalId ? ` ${a.externalId}` : ''}: ${a.title}${a.url ? ` — ${a.url}` : ''} (${bits.join(', ')})`;
        }));
        section('Executions', c.executions.map((e) => `- ${e.parentExecutionId ? '  ' : ''}${e.title} — ${e.state.replace('_', ' ')} (${e.provider}, id ${e.id})`));
        section('Open input requests', c.openInputRequests.map((r) => `- ${r.question}${r.options ? ` [options: ${r.options.join(' / ')}]` : ''}`));
        section('Recent progress', c.recentProgress.map((p) => `- ${p.at.slice(0, 16).replace('T', ' ')} — ${p.by}${p.execution ? ` (${p.execution})` : ''}: ${p.text}`));
        return `${out.join('\n').trimEnd()}\n`;
    }
};
AgentContextService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource,
        WorkstreamsService])
], AgentContextService);
export { AgentContextService };
//# sourceMappingURL=agent-context.service.js.map