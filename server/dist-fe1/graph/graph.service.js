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
import { DataSource, In } from 'typeorm';
import { notFound } from '../common/util.js';
import { AgentEntity, ArtifactEntity, DependencyEntity, ExecutionEntity, RepositoryEntity, TeamEntity, UserEntity, WorkstreamEntity, MembershipEntity, } from '../database/entities/index.js';
let GraphService = class GraphService {
    ds;
    constructor(ds) {
        this.ds = ds;
    }
    async build(workspaceId, opts = {}) {
        const where = { workspaceId };
        const [allWs, execs, artifacts, deps, teams, repos, agents, memberships] = await Promise.all([
            this.ds.getRepository(WorkstreamEntity).find({ where }),
            this.ds.getRepository(ExecutionEntity).find({ where, order: { createdAt: 'ASC' } }),
            opts.includeArtifacts === false ? [] : this.ds.getRepository(ArtifactEntity).find({ where, order: { createdAt: 'ASC' } }),
            this.ds.getRepository(DependencyEntity).find({ where }),
            this.ds.getRepository(TeamEntity).find({ where }),
            this.ds.getRepository(RepositoryEntity).find({ where }),
            this.ds.getRepository(AgentEntity).find({ where }),
            this.ds.getRepository(MembershipEntity).find({ where }),
        ]);
        const users = await this.ds.getRepository(UserEntity).findBy({ id: In(memberships.map((m) => m.userId)) });
        const wsById = new Map(allWs.map((w) => [w.id, w]));
        const exById = new Map(execs.map((e) => [e.id, e]));
        const teamById = new Map(teams.map((t) => [t.id, t]));
        const repoById = new Map(repos.map((r) => [r.id, r]));
        const agentById = new Map(agents.map((a) => [a.id, a]));
        const userById = new Map(users.map((u) => [u.id, u]));
        if (opts.workstreamId && !wsById.has(opts.workstreamId))
            throw notFound('Workstream', opts.workstreamId);
        const included = allWs.filter((w) => opts.workstreamId
            ? w.id === opts.workstreamId
            : opts.teamId
                ? w.ownerTeamId === opts.teamId || w.participatingTeamIds.includes(opts.teamId)
                : true);
        const nodes = new Map();
        const edges = new Map();
        const node = (n) => {
            if (!nodes.has(n.id))
                nodes.set(n.id, n);
        };
        const edge = (kind, source, target) => {
            const id = `${kind}:${source}>${target}`;
            if (!edges.has(id))
                edges.set(id, { id, source, target, kind });
        };
        const actors = opts.includeActors !== false;
        const withRepos = opts.includeRepositories !== false;
        const addWorkstream = (w, external = false) => {
            node({
                id: w.id,
                type: 'workstream',
                label: `${w.key} ${w.title}`,
                status: w.status,
                parentId: actors ? w.ownerTeamId : undefined,
                data: {
                    key: w.key,
                    title: w.title,
                    priority: w.priority,
                    derivedStatus: w.derivedStatus,
                    ownerTeamId: w.ownerTeamId,
                    participatingTeamIds: w.participatingTeamIds,
                    accountableUserId: w.accountableUserId ?? undefined,
                    targetDate: w.targetDate?.toISOString(),
                    ...(external ? { external: true } : {}),
                },
            });
            if (actors) {
                const t = teamById.get(w.ownerTeamId);
                if (t) {
                    node(teamNode(t));
                    edge('contains', t.id, w.id);
                }
            }
            if (withRepos)
                for (const r of w.repositoryIds)
                    addRepo(w.id, r);
        };
        const teamNode = (t) => ({
            id: t.id,
            type: 'team',
            label: t.name,
            data: { key: t.key, color: t.color },
        });
        const addRepo = (from, repoId) => {
            const r = repoById.get(repoId);
            if (!r)
                return;
            node({ id: r.id, type: 'repository', label: r.fullName, data: { fullName: r.fullName, provider: r.provider, url: r.url, defaultBranch: r.defaultBranch } });
            edge('targets', from, r.id);
        };
        const addExecution = (e) => {
            node({
                id: e.id,
                type: 'execution',
                label: e.title,
                state: e.state,
                parentId: e.parentExecutionId ?? e.workstreamId,
                data: {
                    workstreamId: e.workstreamId,
                    provider: e.provider,
                    parentExecutionId: e.parentExecutionId ?? undefined,
                    progressNote: e.progressNote ?? undefined,
                    sessionUrl: e.sessionUrl ?? undefined,
                    branch: e.branch ?? undefined,
                },
            });
            if (e.parentExecutionId)
                edge('subthread', e.parentExecutionId, e.id);
            else
                edge('contains', e.workstreamId, e.id);
            if (actors)
                for (const p of e.performers) {
                    if (!p.id)
                        continue;
                    if (p.type === 'agent' && agentById.has(p.id)) {
                        const a = agentById.get(p.id);
                        node({ id: a.id, type: 'agent', label: a.name, data: { provider: a.provider } });
                    }
                    else if (p.type === 'user' && userById.has(p.id)) {
                        const u = userById.get(p.id);
                        node({ id: u.id, type: 'user', label: u.name, data: { email: u.email, avatarHue: u.avatarHue } });
                    }
                    else if (p.type === 'team' && teamById.has(p.id)) {
                        node(teamNode(teamById.get(p.id)));
                    }
                    else
                        continue;
                    edge('performed_by', e.id, p.id);
                }
            if (withRepos)
                for (const r of e.repositoryIds)
                    addRepo(e.id, r);
        };
        const includedIds = new Set(included.map((w) => w.id));
        for (const w of included)
            addWorkstream(w);
        for (const e of execs)
            if (includedIds.has(e.workstreamId))
                addExecution(e);
        for (const a of artifacts) {
            if (!includedIds.has(a.workstreamId))
                continue;
            const parentId = a.executionId && exById.has(a.executionId) ? a.executionId : a.workstreamId;
            node({
                id: a.id,
                type: 'artifact',
                label: a.externalId ? `${a.title} (${a.externalId})` : a.title,
                state: a.state,
                parentId,
                data: {
                    kind: a.kind,
                    workstreamId: a.workstreamId,
                    executionId: a.executionId ?? undefined,
                    url: a.url ?? undefined,
                    externalId: a.externalId ?? undefined,
                    ci: a.ci ?? undefined,
                    review: a.review ?? undefined,
                    hasConflicts: a.hasConflicts ?? undefined,
                    environment: a.environment ?? undefined,
                },
            });
            edge(parentId === a.workstreamId ? 'contains' : 'produces', parentId, a.id);
        }
        for (const d of deps) {
            const fromWsId = d.fromType === 'workstream' ? d.fromId : exById.get(d.fromId)?.workstreamId;
            const toWsId = d.toType === 'workstream' ? d.toId : exById.get(d.toId)?.workstreamId;
            if (!fromWsId || !toWsId || !(includedIds.has(fromWsId) || includedIds.has(toWsId)))
                continue;
            for (const [type, id, wsId] of [[d.fromType, d.fromId, fromWsId], [d.toType, d.toId, toWsId]]) {
                if (includedIds.has(wsId))
                    continue;
                addWorkstream(wsById.get(wsId), true);
                if (type === 'execution')
                    addExecution(exById.get(id));
            }
            edge('depends_on', d.toId, d.fromId);
        }
        return { nodes: [...nodes.values()], edges: [...edges.values()] };
    }
};
GraphService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource])
], GraphService);
export { GraphService };
//# sourceMappingURL=graph.service.js.map