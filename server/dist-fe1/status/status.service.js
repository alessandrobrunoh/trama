var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var StatusService_1;
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { ArtifactEntity, DecisionEntity, DependencyEntity, ExecutionEntity, InputRequestEntity, WorkstreamEntity, } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import { deriveStatus } from './derive-status.js';
let StatusService = StatusService_1 = class StatusService {
    ds;
    events;
    bus;
    logger = new Logger(StatusService_1.name);
    unsubscribe;
    constructor(ds, events, bus) {
        this.ds = ds;
        this.events = events;
        this.bus = bus;
    }
    onModuleInit() {
        this.unsubscribe = this.bus.onTouched((e) => this.onTouched(e));
    }
    onModuleDestroy() {
        this.unsubscribe?.();
    }
    async onApplicationBootstrap() {
        try {
            const changes = await this.recomputeAll();
            if (changes.length)
                this.logger.log(`Boot recompute changed ${changes.length} workstream status(es)`);
        }
        catch (error) {
            this.logger.error(`Boot recompute failed: ${error.message}`);
        }
    }
    async onTouched(e) {
        const changes = [];
        await this.recompute(e.workstreamId, changes, new Set(), true);
        this.events.publish(e.workspaceId, { type: 'attention', entity: 'workstream', id: e.workstreamId });
    }
    async recomputeAll(workspaceId) {
        const rows = await this.ds
            .getRepository(WorkstreamEntity)
            .find({ where: workspaceId ? { workspaceId } : {}, select: { id: true } });
        const changes = [];
        for (const r of rows)
            await this.recompute(r.id, changes, new Set(), false);
        return changes;
    }
    async recompute(workstreamId, changes = [], visited = new Set(), forceDependents = false) {
        if (visited.has(workstreamId))
            return null;
        visited.add(workstreamId);
        const ws = await this.ds.getRepository(WorkstreamEntity).findOneBy({ id: workstreamId });
        if (!ws)
            return null;
        const { workspaceId } = ws;
        const [executions, inputRequests, artifacts, decisions] = await Promise.all([
            this.ds.getRepository(ExecutionEntity).find({ where: { workstreamId } }),
            this.ds.getRepository(InputRequestEntity).find({ where: { workstreamId, state: 'open' } }),
            this.ds.getRepository(ArtifactEntity).find({ where: { workstreamId } }),
            this.ds.getRepository(DecisionEntity).find({ where: { workspaceId, originWorkstreamId: workstreamId, status: 'proposed' } }),
        ]);
        const incomingDependencies = await this.incoming(workspaceId, ws.id, executions);
        const result = deriveStatus({ workstream: ws, executions, inputRequests, artifacts, decisions, incomingDependencies });
        let change = null;
        const dirty = ws.derivedStatus !== result.derivedStatus ||
            ws.status !== result.status ||
            (result.derivedStatus === 'shipped' && !ws.shippedAt);
        if (dirty) {
            const from = ws.status;
            const patch = { derivedStatus: result.derivedStatus, status: result.status };
            if (result.derivedStatus === 'shipped' && !ws.shippedAt)
                patch.shippedAt = new Date();
            if (from !== result.status)
                patch.updatedAt = new Date();
            await this.ds.getRepository(WorkstreamEntity).update({ id: ws.id }, patch);
            if (from !== result.status) {
                change = { workstreamId: ws.id, key: ws.key, from, to: result.status };
                changes.push(change);
                await this.events.record({
                    workspaceId,
                    actor: { type: 'system' },
                    type: 'workstream.status_changed',
                    subject: { type: 'workstream', id: ws.id },
                    workstreamId: ws.id,
                    data: { key: ws.key, title: ws.title, from, to: result.status, derivedStatus: result.derivedStatus },
                });
            }
        }
        if (change || forceDependents) {
            for (const id of await this.dependents(workspaceId, ws.id, executions.map((e) => e.id)))
                await this.recompute(id, changes, visited, false);
        }
        return change;
    }
    async incoming(workspaceId, workstreamId, executions) {
        const execState = new Map(executions.map((e) => [e.id, e.state]));
        const targets = [workstreamId, ...execState.keys()];
        const edges = await this.ds.getRepository(DependencyEntity).find({ where: { workspaceId, toId: In(targets) } });
        if (!edges.length)
            return [];
        const wsIds = edges.filter((e) => e.fromType === 'workstream').map((e) => e.fromId);
        const exIds = edges.filter((e) => e.fromType === 'execution').map((e) => e.fromId);
        const [wss, exs] = await Promise.all([
            wsIds.length ? this.ds.getRepository(WorkstreamEntity).find({ where: { id: In(wsIds) }, select: { id: true, status: true } }) : [],
            exIds.length ? this.ds.getRepository(ExecutionEntity).find({ where: { id: In(exIds) }, select: { id: true, state: true } }) : [],
        ]);
        const wsStatus = new Map(wss.map((w) => [w.id, w.status]));
        const exStateMap = new Map(exs.map((e) => [e.id, e.state]));
        const out = [];
        for (const e of edges) {
            const sourceState = e.fromType === 'workstream' ? wsStatus.get(e.fromId) : exStateMap.get(e.fromId);
            if (!sourceState)
                continue;
            out.push({
                sourceType: e.fromType,
                sourceState,
                targetExecutionState: e.toType === 'execution' ? execState.get(e.toId) : undefined,
            });
        }
        return out;
    }
    async dependents(workspaceId, workstreamId, executionIds) {
        const edges = await this.ds
            .getRepository(DependencyEntity)
            .find({ where: { workspaceId, fromId: In([workstreamId, ...executionIds]) } });
        const out = new Set();
        const exTargets = [];
        for (const e of edges) {
            if (e.toType === 'workstream')
                out.add(e.toId);
            else
                exTargets.push(e.toId);
        }
        if (exTargets.length) {
            const rows = await this.ds.getRepository(ExecutionEntity).find({ where: { id: In(exTargets) }, select: { id: true, workstreamId: true } });
            for (const r of rows)
                out.add(r.workstreamId);
        }
        out.delete(workstreamId);
        return [...out];
    }
};
StatusService = StatusService_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource,
        EventsService,
        WorkstreamBus])
], StatusService);
export { StatusService };
//# sourceMappingURL=status.service.js.map