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
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { hasRole } from '../auth/request-context.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import { CommentEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
let CommentsService = class CommentsService {
    refs;
    events;
    bus;
    repo;
    constructor(refs, events, bus, repo) {
        this.refs = refs;
        this.events = events;
        this.bus = bus;
        this.repo = repo;
    }
    list(workspaceId, f = {}) {
        const qb = this.repo.createQueryBuilder('c').where('c.workspaceId = :workspaceId', { workspaceId }).orderBy('c.createdAt', 'ASC');
        if (f.subjectId)
            qb.andWhere("c.subject->>'id' = :sid", { sid: f.subjectId });
        if (f.subjectType)
            qb.andWhere("c.subject->>'type' = :st", { st: f.subjectType });
        return qb.getMany();
    }
    async get(workspaceId, id) {
        const row = await this.repo.findOneBy({ workspaceId, id });
        if (!row)
            throw notFound('Comment', id);
        return row;
    }
    async create(ctx, subject, body) {
        const resolved = await this.refs.resolveSubject(ctx.workspace.id, subject);
        if (!resolved.exists)
            throw new BadRequestException(`Unknown ${subject.type} "${subject.id}"`);
        const row = await this.repo.save(this.repo.create({ id: uid('cm'), workspaceId: ctx.workspace.id, subject, author: ctx.actor, body: body.trim() }));
        await this.events.record({
            workspaceId: ctx.workspace.id,
            actor: ctx.actor,
            type: 'comment.created',
            subject,
            workstreamId: resolved.workstreamId,
            data: { commentId: row.id, excerpt: row.body.slice(0, 200) },
        }, { type: 'created', entity: 'comment', id: row.id });
        if (resolved.workstreamId)
            await this.bus.touch(ctx.workspace.id, resolved.workstreamId, 'comment.created');
        return row;
    }
    async update(ctx, id, body) {
        const row = await this.get(ctx.workspace.id, id);
        if (row.author.type !== ctx.actor.type || row.author.id !== ctx.actor.id)
            throw new ForbiddenException('Only the author can edit a comment');
        row.body = body.trim();
        row.updatedAt = new Date();
        await this.repo.save(row);
        this.events.publish(ctx.workspace.id, { type: 'updated', entity: 'comment', id });
        return row;
    }
    async remove(ctx, id) {
        const row = await this.get(ctx.workspace.id, id);
        const own = row.author.type === ctx.actor.type && row.author.id === ctx.actor.id;
        if (!own && !hasRole(ctx.role, 'admin'))
            throw new ForbiddenException('Only the author or an admin can delete a comment');
        await this.repo.delete({ id });
        this.events.publish(ctx.workspace.id, { type: 'deleted', entity: 'comment', id });
    }
};
CommentsService = __decorate([
    Injectable(),
    __param(3, InjectRepository(CommentEntity)),
    __metadata("design:paramtypes", [RefsService,
        EventsService,
        WorkstreamBus, Function])
], CommentsService);
export { CommentsService };
//# sourceMappingURL=comments.service.js.map