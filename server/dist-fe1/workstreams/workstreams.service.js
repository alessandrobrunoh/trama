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
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, toDate, uid, unique } from '../common/util.js';
import { TeamEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
const KEY_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
function criteria(items) {
    return (items ?? []).map((c) => ({
        id: c.id ?? uid('ac'),
        text: c.text.trim(),
        state: c.state ?? 'pending',
    }));
}
let WorkstreamsService = class WorkstreamsService {
    ds;
    refs;
    counters;
    events;
    bus;
    repo;
    constructor(ds, refs, counters, events, bus, repo) {
        this.ds = ds;
        this.refs = refs;
        this.counters = counters;
        this.events = events;
        this.bus = bus;
        this.repo = repo;
    }
    list(workspaceId, f = {}) {
        const qb = this.repo
            .createQueryBuilder('w')
            .where('w.workspaceId = :workspaceId', { workspaceId })
            .orderBy('w.updatedAt', 'DESC');
        if (f.status)
            qb.andWhere('w.status = :status', { status: f.status });
        if (f.ownerTeamId)
            qb.andWhere('w.ownerTeamId = :ot', { ot: f.ownerTeamId });
        if (f.teamId)
            qb.andWhere(`(w.ownerTeamId = :tid OR w.participatingTeamIds @> :tidj::jsonb)`, {
                tid: f.teamId,
                tidj: JSON.stringify([f.teamId]),
            });
        if (f.accountableUserId)
            qb.andWhere('w.accountableUserId = :au', { au: f.accountableUserId });
        if (f.priority)
            qb.andWhere('w.priority = :p', { p: f.priority });
        if (f.repositoryId)
            qb.andWhere('w.repositoryIds @> :rid::jsonb', { rid: JSON.stringify([f.repositoryId]) });
        if (f.label)
            qb.andWhere('w.labels @> :lb::jsonb', { lb: JSON.stringify([f.label]) });
        if (f.q)
            qb.andWhere('(w.title ILIKE :q OR w.key ILIKE :q)', { q: `%${f.q}%` });
        return qb.getMany();
    }
    async get(workspaceId, idOrKey, manager) {
        const repo = manager ? manager.getRepository(WorkstreamEntity) : this.repo;
        const row = await repo.findOne({
            where: KEY_RE.test(idOrKey) ? { workspaceId, key: idOrKey.toUpperCase() } : { workspaceId, id: idOrKey },
        });
        if (!row)
            throw notFound('Workstream', idOrKey);
        return row;
    }
    async create(workspaceId, actor, input, options = {}) {
        await this.refs.teams(workspaceId, [input.ownerTeamId, ...(input.participatingTeamIds ?? [])]);
        await this.refs.users(workspaceId, [input.accountableUserId]);
        await this.refs.repositories(workspaceId, input.repositoryIds);
        const run = async (m) => {
            const team = await m.findOneByOrFail(TeamEntity, { id: input.ownerTeamId, workspaceId });
            const number = await this.counters.next(m, workspaceId, `ws:${team.id}`);
            const acceptanceCriteria = criteria(input.acceptanceCriteria);
            const derived = acceptanceCriteria.length ? 'planned' : 'draft';
            return m.save(m.create(WorkstreamEntity, {
                id: uid('wk'),
                workspaceId,
                key: `${team.key}-${number}`,
                number,
                title: input.title.trim(),
                objective: input.objective ?? '',
                context: input.context ?? null,
                ownerTeamId: team.id,
                participatingTeamIds: unique(input.participatingTeamIds).filter((t) => t !== team.id),
                accountableUserId: input.accountableUserId ?? null,
                repositoryIds: unique(input.repositoryIds),
                acceptanceCriteria,
                priority: input.priority ?? 'none',
                labels: unique(input.labels),
                derivedStatus: derived,
                statusOverride: input.statusOverride ?? null,
                status: input.statusOverride ?? derived,
                targetDate: toDate(input.targetDate) ?? null,
                createdById: actor.id ?? 'system',
            }));
        };
        const after = async (row) => {
            await this.events.record({
                workspaceId,
                actor,
                type: 'workstream.created',
                subject: { type: 'workstream', id: row.id },
                workstreamId: row.id,
                data: { key: row.key, title: row.title, ...options.data },
            });
            await this.bus.touch(workspaceId, row.id, 'workstream.created');
        };
        if (options.manager) {
            const row = await run(options.manager);
            return Object.assign(row, { after: () => after(row) });
        }
        const row = await this.ds.transaction(run);
        await after(row);
        return row;
    }
    async update(workspaceId, actor, idOrKey, patch) {
        const ws = await this.get(workspaceId, idOrKey);
        if (patch.ownerTeamId !== undefined)
            await this.refs.teams(workspaceId, [patch.ownerTeamId]);
        await this.refs.teams(workspaceId, patch.participatingTeamIds);
        await this.refs.users(workspaceId, [patch.accountableUserId]);
        await this.refs.repositories(workspaceId, patch.repositoryIds);
        const changed = [];
        const set = (k, v) => {
            if (JSON.stringify(ws[k]) !== JSON.stringify(v)) {
                ws[k] = v;
                changed.push(k);
            }
        };
        if (patch.title !== undefined)
            set('title', patch.title.trim());
        if (patch.objective !== undefined)
            set('objective', patch.objective);
        if (patch.context !== undefined)
            set('context', patch.context);
        if (patch.ownerTeamId !== undefined)
            set('ownerTeamId', patch.ownerTeamId);
        if (patch.participatingTeamIds !== undefined)
            set('participatingTeamIds', unique(patch.participatingTeamIds).filter((t) => t !== ws.ownerTeamId));
        if (patch.accountableUserId !== undefined)
            set('accountableUserId', patch.accountableUserId);
        if (patch.repositoryIds !== undefined)
            set('repositoryIds', unique(patch.repositoryIds));
        if (patch.acceptanceCriteria !== undefined)
            set('acceptanceCriteria', criteria(patch.acceptanceCriteria));
        if (patch.priority !== undefined)
            set('priority', patch.priority);
        if (patch.labels !== undefined)
            set('labels', unique(patch.labels));
        if (patch.targetDate !== undefined)
            set('targetDate', toDate(patch.targetDate) ?? null);
        if (patch.statusOverride !== undefined) {
            set('statusOverride', patch.statusOverride);
            ws.status = ws.statusOverride ?? ws.derivedStatus;
        }
        if (!changed.length)
            return ws;
        ws.updatedAt = new Date();
        await this.repo.save(ws);
        await this.events.record({
            workspaceId,
            actor,
            type: 'workstream.updated',
            subject: { type: 'workstream', id: ws.id },
            workstreamId: ws.id,
            data: { key: ws.key, fields: changed },
        });
        await this.bus.touch(workspaceId, ws.id, 'workstream.updated');
        return this.get(workspaceId, ws.id);
    }
    async remove(workspaceId, actor, idOrKey) {
        const ws = await this.get(workspaceId, idOrKey);
        await this.ds.transaction(async (m) => {
            const ids = (await m.query(`SELECT "id" FROM "executions" WHERE "workstreamId" = $1
           UNION SELECT "id" FROM "artifacts" WHERE "workstreamId" = $1
           UNION SELECT "id" FROM "input_requests" WHERE "workstreamId" = $1`, [ws.id])).map((r) => r.id);
            ids.push(ws.id);
            await m.query(`DELETE FROM "dependencies" WHERE "workspaceId" = $1 AND ("fromId" = ANY($2) OR "toId" = ANY($2))`, [workspaceId, ids]);
            await m.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`, [workspaceId, ids]);
            await m.query(`UPDATE "intake_items" SET "workstreamIds" = "workstreamIds" - $2::text WHERE "workspaceId" = $1 AND "workstreamIds" ? $2::text`, [workspaceId, ws.id]);
            await m.query(`UPDATE "decisions" SET "relatedWorkstreamIds" = "relatedWorkstreamIds" - $2::text WHERE "workspaceId" = $1 AND "relatedWorkstreamIds" ? $2::text`, [workspaceId, ws.id]);
            await m.delete(WorkstreamEntity, { id: ws.id });
        });
        await this.events.record({
            workspaceId,
            actor,
            type: 'workstream.deleted',
            subject: { type: 'workstream', id: ws.id },
            data: { key: ws.key, title: ws.title },
        });
    }
    async addCriterion(workspaceId, actor, idOrKey, input) {
        const ws = await this.get(workspaceId, idOrKey);
        const criterion = { id: uid('ac'), text: input.text.trim(), state: input.state ?? 'pending' };
        ws.acceptanceCriteria = [...ws.acceptanceCriteria, criterion];
        return this.saveCriteria(ws, actor, 'added', criterion);
    }
    async updateCriterion(workspaceId, actor, idOrKey, criterionId, patch) {
        const ws = await this.get(workspaceId, idOrKey);
        const current = ws.acceptanceCriteria.find((c) => c.id === criterionId);
        if (!current)
            throw notFound('Criterion', criterionId);
        const next = {
            ...current,
            ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
            ...(patch.state !== undefined ? { state: patch.state } : {}),
        };
        ws.acceptanceCriteria = ws.acceptanceCriteria.map((c) => (c.id === criterionId ? next : c));
        return this.saveCriteria(ws, actor, 'updated', next, current.state);
    }
    async removeCriterion(workspaceId, actor, idOrKey, criterionId) {
        const ws = await this.get(workspaceId, idOrKey);
        const current = ws.acceptanceCriteria.find((c) => c.id === criterionId);
        if (!current)
            throw notFound('Criterion', criterionId);
        ws.acceptanceCriteria = ws.acceptanceCriteria.filter((c) => c.id !== criterionId);
        return this.saveCriteria(ws, actor, 'removed', current);
    }
    async saveCriteria(ws, actor, change, criterion, previousState) {
        if (ws.acceptanceCriteria.length > 50)
            throw new BadRequestException('At most 50 acceptance criteria');
        ws.updatedAt = new Date();
        await this.repo.save(ws);
        await this.events.record({
            workspaceId: ws.workspaceId,
            actor,
            type: 'criterion.updated',
            subject: { type: 'workstream', id: ws.id },
            workstreamId: ws.id,
            data: { change, criterionId: criterion.id, text: criterion.text, state: criterion.state, previousState },
        }, { type: 'updated', entity: 'workstream', id: ws.id });
        await this.bus.touch(ws.workspaceId, ws.id, 'criterion.updated');
        return this.get(ws.workspaceId, ws.id);
    }
};
WorkstreamsService = __decorate([
    Injectable(),
    __param(5, InjectRepository(WorkstreamEntity)),
    __metadata("design:paramtypes", [DataSource,
        RefsService,
        CountersService,
        EventsService,
        WorkstreamBus, Function])
], WorkstreamsService);
export { WorkstreamsService };
//# sourceMappingURL=workstreams.service.js.map