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
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import { ExecutionEntity, InputRequestEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
let InputRequestsService = class InputRequestsService {
    ds;
    refs;
    events;
    bus;
    repo;
    constructor(ds, refs, events, bus, repo) {
        this.ds = ds;
        this.refs = refs;
        this.events = events;
        this.bus = bus;
        this.repo = repo;
    }
    list(workspaceId, f = {}) {
        const qb = this.repo.createQueryBuilder('r').where('r.workspaceId = :workspaceId', { workspaceId }).orderBy('r.createdAt', 'DESC');
        if (f.state)
            qb.andWhere('r.state = :s', { s: f.state });
        if (f.workstreamId)
            qb.andWhere('r.workstreamId = :w', { w: f.workstreamId });
        if (f.executionId)
            qb.andWhere('r.executionId = :e', { e: f.executionId });
        if (f.assigneeUserId)
            qb.andWhere('r.assigneeUserId = :a', { a: f.assigneeUserId });
        return qb.getMany();
    }
    async get(workspaceId, id) {
        const row = await this.repo.findOneBy({ workspaceId, id });
        if (!row)
            throw notFound('Input request', id);
        return row;
    }
    async create(workspaceId, actor, input) {
        let workstreamId = input.workstreamId;
        if (input.executionId) {
            const ex = await this.ds.getRepository(ExecutionEntity).findOneBy({ id: input.executionId, workspaceId });
            if (!ex)
                throw new BadRequestException(`Unknown execution "${input.executionId}"`);
            if (workstreamId && workstreamId !== ex.workstreamId)
                throw new BadRequestException('executionId belongs to a different workstream');
            workstreamId = ex.workstreamId;
        }
        if (!workstreamId)
            throw new BadRequestException('workstreamId or executionId is required');
        if (!(await this.ds.getRepository(WorkstreamEntity).existsBy({ id: workstreamId, workspaceId })))
            throw new BadRequestException(`Unknown workstream "${workstreamId}"`);
        await this.refs.users(workspaceId, [input.assigneeUserId]);
        const row = await this.repo.save(this.repo.create({
            id: uid('ir'),
            workspaceId,
            workstreamId,
            executionId: input.executionId ?? null,
            question: input.question.trim(),
            options: input.options?.length ? input.options : null,
            requestedBy: actor,
            assigneeUserId: input.assigneeUserId ?? null,
        }));
        await this.events.record({
            workspaceId,
            actor,
            type: 'input.requested',
            subject: { type: 'input_request', id: row.id },
            workstreamId,
            data: { question: row.question, executionId: row.executionId, assigneeUserId: row.assigneeUserId },
        });
        await this.bus.touch(workspaceId, workstreamId, 'input.requested');
        return row;
    }
    async update(workspaceId, actor, id, patch) {
        const row = await this.get(workspaceId, id);
        if (row.state !== 'open')
            throw new ConflictException('Only open input requests can be edited');
        await this.refs.users(workspaceId, [patch.assigneeUserId]);
        if (patch.question !== undefined)
            row.question = patch.question.trim();
        if (patch.options !== undefined)
            row.options = patch.options?.length ? patch.options : null;
        if (patch.assigneeUserId !== undefined)
            row.assigneeUserId = patch.assigneeUserId;
        await this.repo.save(row);
        await this.events.record({
            workspaceId,
            actor,
            type: 'input.updated',
            subject: { type: 'input_request', id },
            workstreamId: row.workstreamId,
            data: { fields: Object.keys(patch) },
        });
        await this.bus.touch(workspaceId, row.workstreamId, 'input.updated');
        return row;
    }
    async answer(workspaceId, actor, id, answer) {
        const row = await this.get(workspaceId, id);
        if (row.state !== 'open')
            throw new ConflictException(`Input request is already ${row.state}`);
        row.state = 'answered';
        row.answer = answer;
        row.answeredById = actor.id ?? null;
        row.answeredAt = new Date();
        await this.repo.save(row);
        await this.events.record({
            workspaceId,
            actor,
            type: 'input.answered',
            subject: { type: 'input_request', id },
            workstreamId: row.workstreamId,
            data: { question: row.question, answer },
        });
        await this.bus.touch(workspaceId, row.workstreamId, 'input.answered');
        return row;
    }
    async dismiss(workspaceId, actor, id) {
        const row = await this.get(workspaceId, id);
        if (row.state !== 'open')
            throw new ConflictException(`Input request is already ${row.state}`);
        row.state = 'dismissed';
        row.answeredAt = new Date();
        await this.repo.save(row);
        await this.events.record({
            workspaceId,
            actor,
            type: 'input.dismissed',
            subject: { type: 'input_request', id },
            workstreamId: row.workstreamId,
            data: { question: row.question },
        });
        await this.bus.touch(workspaceId, row.workstreamId, 'input.dismissed');
        return row;
    }
    async remove(workspaceId, actor, id) {
        const row = await this.get(workspaceId, id);
        await this.ds.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`, [workspaceId, id]);
        await this.repo.delete({ id });
        await this.events.record({
            workspaceId,
            actor,
            type: 'input.deleted',
            subject: { type: 'input_request', id },
            workstreamId: row.workstreamId,
            data: { question: row.question },
        });
        await this.bus.touch(workspaceId, row.workstreamId, 'input.deleted');
    }
};
InputRequestsService = __decorate([
    Injectable(),
    __param(4, InjectRepository(InputRequestEntity)),
    __metadata("design:paramtypes", [DataSource,
        RefsService,
        EventsService,
        WorkstreamBus, Function])
], InputRequestsService);
export { InputRequestsService };
//# sourceMappingURL=input-requests.service.js.map