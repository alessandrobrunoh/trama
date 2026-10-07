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
import { BadRequestException, Controller, Get, Query, Sse, } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Observable, filter, interval, map, merge } from 'rxjs';
import { Ctx } from '../auth/request-context.js';
import { DomainEventEntity } from '../database/entities/index.js';
import { EventsService } from './events.service.js';
class ListEventsQuery {
    workstreamId;
    subject;
    type;
    before;
    limit;
}
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListEventsQuery.prototype, "workstreamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListEventsQuery.prototype, "subject", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListEventsQuery.prototype, "type", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListEventsQuery.prototype, "before", void 0);
__decorate([
    IsOptional(),
    Type(() => Number),
    IsInt(),
    Min(1),
    Max(500),
    __metadata("design:type", Number)
], ListEventsQuery.prototype, "limit", void 0);
let EventsController = class EventsController {
    events;
    repo;
    constructor(events, repo) {
        this.events = events;
        this.repo = repo;
    }
    list(ctx, q) {
        const qb = this.repo
            .createQueryBuilder('e')
            .where('e.workspaceId = :ws', { ws: ctx.workspace.id })
            .orderBy('e.at', 'DESC')
            .addOrderBy('e.id', 'DESC')
            .limit(q.limit ?? 100);
        if (q.workstreamId)
            qb.andWhere('e.workstreamId = :wk', { wk: q.workstreamId });
        if (q.subject) {
            const [type, id] = q.subject.split(':');
            if (!type || !id)
                throw new BadRequestException('subject must be "<type>:<id>"');
            qb.andWhere("e.subject->>'type' = :st AND e.subject->>'id' = :sid", { st: type, sid: id });
        }
        if (q.type)
            qb.andWhere('e.type LIKE :type', { type: `${q.type.replace(/[%_]/g, '')}%` });
        if (q.before) {
            const before = new Date(q.before);
            if (Number.isNaN(before.getTime()))
                throw new BadRequestException('before must be an ISO date');
            qb.andWhere('e.at < :before', { before });
        }
        return qb.getMany();
    }
    stream(ctx) {
        const live$ = this.events.stream$.pipe(filter((e) => e.workspaceId === ctx.workspace.id), map((e) => ({ data: e.event })));
        const ping$ = interval(25_000).pipe(map(() => ({ type: 'ping', data: { at: new Date().toISOString() } })));
        return merge(live$, ping$);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ListEventsQuery]),
    __metadata("design:returntype", void 0)
], EventsController.prototype, "list", null);
__decorate([
    Sse('stream'),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Observable)
], EventsController.prototype, "stream", null);
EventsController = __decorate([
    Controller('w/:slug/events'),
    __param(1, InjectRepository(DomainEventEntity)),
    __metadata("design:paramtypes", [EventsService, Function])
], EventsController);
export { EventsController };
//# sourceMappingURL=events.controller.js.map