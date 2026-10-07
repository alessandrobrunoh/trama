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
import { INTAKE_KEY_PREFIX, } from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import { IntakeItemEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
import { WorkstreamsService } from '../workstreams/workstreams.service.js';
const KEY_RE = /^[A-Za-z]+-\d+$/;
let IntakeService = class IntakeService {
    ds;
    refs;
    counters;
    events;
    bus;
    workstreams;
    repo;
    constructor(ds, refs, counters, events, bus, workstreams, repo) {
        this.ds = ds;
        this.refs = refs;
        this.counters = counters;
        this.events = events;
        this.bus = bus;
        this.workstreams = workstreams;
        this.repo = repo;
    }
    list(workspaceId, f = {}) {
        const qb = this.repo.createQueryBuilder('i').where('i.workspaceId = :workspaceId', { workspaceId }).orderBy('i.createdAt', 'DESC');
        if (f.kind)
            qb.andWhere('i.kind = :k', { k: f.kind });
        if (f.state)
            qb.andWhere('i.state = :s', { s: f.state });
        if (f.teamId)
            qb.andWhere('i.teamId = :t', { t: f.teamId });
        if (f.workstreamId)
            qb.andWhere('i.workstreamIds @> :w::jsonb', { w: JSON.stringify([f.workstreamId]) });
        if (f.q)
            qb.andWhere('(i.title ILIKE :q OR i.key ILIKE :q)', { q: `%${f.q}%` });
        return qb.getMany();
    }
    async get(workspaceId, idOrKey) {
        const row = await this.repo.findOneBy(KEY_RE.test(idOrKey) ? { workspaceId, key: idOrKey.toUpperCase() } : { workspaceId, id: idOrKey });
        if (!row)
            throw notFound('Intake item', idOrKey);
        return row;
    }
    async create(workspaceId, actor, input) {
        await this.refs.teams(workspaceId, [input.teamId].filter((x) => !!x));
        const row = await this.ds.transaction(async (m) => {
            const number = await this.counters.next(m, workspaceId, `intake:${input.kind}`);
            return m.save(m.create(IntakeItemEntity, {
                id: uid('in'),
                workspaceId,
                key: `${INTAKE_KEY_PREFIX[input.kind]}-${number}`,
                number,
                kind: input.kind,
                title: input.title.trim(),
                body: input.body ?? null,
                source: input.source ?? (actor.type === 'agent' ? 'agent' : 'manual'),
                reporterName: input.reporterName ?? null,
                reporterId: actor.type === 'user' ? (actor.id ?? null) : null,
                teamId: input.teamId ?? null,
                priority: input.priority ?? 'none',
                externalUrl: input.externalUrl ?? null,
            }));
        });
        await this.events.record({
            workspaceId,
            actor,
            type: 'intake.created',
            subject: { type: 'intake', id: row.id },
            data: { key: row.key, kind: row.kind, title: row.title },
        });
        return row;
    }
    async update(workspaceId, actor, idOrKey, patch) {
        const row = await this.get(workspaceId, idOrKey);
        await this.refs.teams(workspaceId, [patch.teamId].filter((x) => !!x));
        await this.refs.workstreams(workspaceId, patch.workstreamIds);
        const before = new Set(row.workstreamIds);
        if (patch.title !== undefined)
            row.title = patch.title.trim();
        if (patch.body !== undefined)
            row.body = patch.body;
        if (patch.reporterName !== undefined)
            row.reporterName = patch.reporterName;
        if (patch.teamId !== undefined)
            row.teamId = patch.teamId;
        if (patch.priority !== undefined)
            row.priority = patch.priority;
        if (patch.externalUrl !== undefined)
            row.externalUrl = patch.externalUrl;
        if (patch.workstreamIds !== undefined)
            row.workstreamIds = unique(patch.workstreamIds);
        row.updatedAt = new Date();
        await this.repo.save(row);
        await this.events.record({
            workspaceId,
            actor,
            type: 'intake.updated',
            subject: { type: 'intake', id: row.id },
            data: { key: row.key, fields: Object.keys(patch) },
        });
        const touched = new Set([...before, ...row.workstreamIds]);
        await this.bus.touchMany(workspaceId, touched, 'intake.updated');
        return row;
    }
    async triage(workspaceId, actor, idOrKey, input) {
        const row = await this.get(workspaceId, idOrKey);
        await this.refs.workstreams(workspaceId, input.workstreamIds);
        await this.refs.teams(workspaceId, [input.teamId].filter((x) => !!x));
        let duplicateOfId = null;
        if (input.state === 'duplicate') {
            if (!input.duplicateOfId)
                throw new BadRequestException('duplicateOfId is required when state is "duplicate"');
            const target = await this.get(workspaceId, input.duplicateOfId);
            if (target.id === row.id)
                throw new BadRequestException('An item cannot duplicate itself');
            duplicateOfId = target.id;
        }
        else if (input.duplicateOfId) {
            throw new BadRequestException('duplicateOfId is only valid when state is "duplicate"');
        }
        if ((input.state === 'declined' || input.state === 'duplicate' || input.state === 'new') && (input.createWorkstream || input.workstreamIds?.length))
            throw new BadRequestException(`Cannot link workstreams when state is "${input.state}"`);
        let created;
        const previous = row.workstreamIds;
        await this.ds.transaction(async (m) => {
            const ids = unique([...(row.workstreamIds ?? []), ...(input.workstreamIds ?? [])]);
            if (input.createWorkstream) {
                created = await this.workstreams.create(workspaceId, actor, input.createWorkstream, {
                    manager: m,
                    data: { fromIntake: row.key },
                });
                ids.push(created.id);
            }
            row.state = input.state;
            row.workstreamIds = input.state === 'declined' || input.state === 'duplicate' ? [] : ids;
            row.duplicateOfId = duplicateOfId;
            if (input.teamId !== undefined)
                row.teamId = input.teamId;
            if (input.priority !== undefined)
                row.priority = input.priority;
            row.updatedAt = new Date();
            await m.save(row);
        });
        if (created)
            await created.after?.();
        const targets = row.workstreamIds.length ? row.workstreamIds : [null];
        for (const workstreamId of targets)
            await this.events.record({
                workspaceId,
                actor,
                type: 'intake.triaged',
                subject: { type: 'intake', id: row.id },
                workstreamId,
                data: { key: row.key, state: row.state, workstreamIds: row.workstreamIds, createdWorkstreamId: created?.id, duplicateOfId },
            });
        await this.bus.touchMany(workspaceId, [...previous, ...row.workstreamIds], 'intake.triaged');
        return row;
    }
    async remove(workspaceId, actor, idOrKey) {
        const row = await this.get(workspaceId, idOrKey);
        await this.ds.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`, [workspaceId, row.id]);
        await this.ds.query(`UPDATE "intake_items" SET "duplicateOfId" = NULL WHERE "workspaceId" = $1 AND "duplicateOfId" = $2`, [workspaceId, row.id]);
        await this.repo.delete({ id: row.id });
        await this.events.record({
            workspaceId,
            actor,
            type: 'intake.deleted',
            subject: { type: 'intake', id: row.id },
            data: { key: row.key, title: row.title },
        });
        await this.bus.touchMany(workspaceId, row.workstreamIds, 'intake.deleted');
    }
};
IntakeService = __decorate([
    Injectable(),
    __param(6, InjectRepository(IntakeItemEntity)),
    __metadata("design:paramtypes", [DataSource,
        RefsService,
        CountersService,
        EventsService,
        WorkstreamBus,
        WorkstreamsService, Function])
], IntakeService);
export { IntakeService };
//# sourceMappingURL=intake.service.js.map