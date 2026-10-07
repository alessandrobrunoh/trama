var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { notFound, uid } from '../common/util.js';
import { DependencyEntity, ExecutionEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
const key = (n) => `${n.type}:${n.id}`;
let DependenciesService = class DependenciesService {
    ds;
    events;
    bus;
    repo;
    constructor(ds, events, bus, repo) {
        this.ds = ds;
        this.events = events;
        this.bus = bus;
        this.repo = repo;
    }
    list(workspaceId, f = {}) {
        const where = { workspaceId };
        if (f.fromId)
            where.fromId = f.fromId;
        if (f.toId)
            where.toId = f.toId;
        return this.repo.find({ where, order: { createdAt: 'ASC' } });
    }
    async get(workspaceId, id) {
        const d = await this.repo.findOneBy({ workspaceId, id });
        if (!d)
            throw notFound('Dependency', id);
        return d;
    }
    async workstreamOf(workspaceId, node) {
        if (node.type === 'workstream') {
            const w = await this.ds.getRepository(WorkstreamEntity).findOne({ where: { workspaceId, id: node.id }, select: { id: true } });
            return w?.id;
        }
        const e = await this.ds.getRepository(ExecutionEntity).findOne({ where: { workspaceId, id: node.id }, select: { id: true, workstreamId: true } });
        return e?.workstreamId;
    }
    async wouldCycle(workspaceId, from, to, extra = []) {
        const edges = await this.repo.find({ where: { workspaceId } });
        const adj = new Map();
        const add = (a, b) => adj.set(a, [...(adj.get(a) ?? []), b]);
        for (const e of edges)
            add(`${e.fromType}:${e.fromId}`, `${e.toType}:${e.toId}`);
        for (const [a, b] of extra)
            add(key(a), key(b));
        const target = key(from);
        const seen = new Set();
        const stack = [key(to)];
        while (stack.length) {
            const cur = stack.pop();
            if (cur === target)
                return true;
            if (seen.has(cur))
                continue;
            seen.add(cur);
            stack.push(...(adj.get(cur) ?? []));
        }
        return false;
    }
    async create(workspaceId, actor, from, to) {
        if (from.type === to.type && from.id === to.id)
            throw new BadRequestException('A node cannot depend on itself');
        const fromWs = await this.workstreamOf(workspaceId, from);
        const toWs = await this.workstreamOf(workspaceId, to);
        if (!fromWs)
            throw new BadRequestException(`Unknown ${from.type} "${from.id}"`);
        if (!toWs)
            throw new BadRequestException(`Unknown ${to.type} "${to.id}"`);
        if (await this.repo.existsBy({ workspaceId, fromType: from.type, fromId: from.id, toType: to.type, toId: to.id }))
            throw new ConflictException('Dependency already exists');
        if (await this.wouldCycle(workspaceId, from, to))
            throw new ConflictException('This dependency would create a cycle');
        const dep = await this.repo.save(this.repo.create({ id: uid('dp'), workspaceId, fromType: from.type, fromId: from.id, toType: to.type, toId: to.id }));
        await this.events.record({
            workspaceId,
            actor,
            type: 'dependency.added',
            subject: { type: to.type, id: to.id },
            workstreamId: toWs,
            data: { dependencyId: dep.id, from, to, fromWorkstreamId: fromWs },
        }, { type: 'created', entity: 'dependency', id: dep.id });
        await this.bus.touchMany(workspaceId, [fromWs, toWs], 'dependency.added');
        return dep;
    }
    async remove(workspaceId, actor, id) {
        const dep = await this.get(workspaceId, id);
        await this.repo.delete({ id });
        const from = { type: dep.fromType, id: dep.fromId };
        const to = { type: dep.toType, id: dep.toId };
        const fromWs = await this.workstreamOf(workspaceId, from);
        const toWs = await this.workstreamOf(workspaceId, to);
        await this.events.record({
            workspaceId,
            actor,
            type: 'dependency.removed',
            subject: { type: to.type, id: to.id },
            workstreamId: toWs,
            data: { dependencyId: id, from, to },
        }, { type: 'deleted', entity: 'dependency', id });
        await this.bus.touchMany(workspaceId, [fromWs, toWs].filter((x) => !!x), 'dependency.removed');
    }
    async executionDeps(workspaceId, executionIds) {
        const out = new Map();
        if (!executionIds.length)
            return out;
        const rows = await this.ds
            .getRepository(DependencyEntity)
            .createQueryBuilder('d')
            .where("d.workspaceId = :workspaceId AND d.fromType = 'execution' AND d.toType = 'execution' AND d.toId IN (:...ids)", {
            workspaceId,
            ids: executionIds,
        })
            .getMany();
        for (const r of rows)
            out.set(r.toId, [...(out.get(r.toId) ?? []), r.fromId]);
        return out;
    }
    async syncExecutionDeps(workspaceId, actor, executionId, dependsOn) {
        const current = (await this.executionDeps(workspaceId, [executionId])).get(executionId) ?? [];
        const wanted = new Set(dependsOn);
        for (const id of dependsOn.filter((d) => !current.includes(d)))
            await this.create(workspaceId, actor, { type: 'execution', id }, { type: 'execution', id: executionId });
        for (const id of current.filter((c) => !wanted.has(c))) {
            const dep = await this.repo.findOneBy({ workspaceId, fromType: 'execution', fromId: id, toType: 'execution', toId: executionId });
            if (dep)
                await this.remove(workspaceId, actor, dep.id);
        }
    }
};
DependenciesService = __decorate([
    Injectable(),
    __param(3, InjectRepository(DependencyEntity)),
    __metadata("design:paramtypes", [DataSource,
        EventsService,
        WorkstreamBus, Function])
], DependenciesService);
export { DependenciesService };
//# sourceMappingURL=dependencies.service.js.map