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
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Subject } from 'rxjs';
import { DomainEventEntity } from '../database/entities/index.js';
import { uid } from '../common/util.js';
import { requestStore } from './request-store.js';
let EventsService = class EventsService {
    repo;
    bus = new Subject();
    stream$ = this.bus.asObservable();
    constructor(repo) {
        this.repo = repo;
    }
    async record(input, live = {
        type: input.type.endsWith('.created')
            ? 'created'
            : input.type.endsWith('.deleted')
                ? 'deleted'
                : 'updated',
        entity: input.subject.type,
        id: input.subject.id,
    }) {
        const repo = input.manager ? input.manager.getRepository(DomainEventEntity) : this.repo;
        const row = repo.create({
            id: uid('ev'),
            workspaceId: input.workspaceId,
            at: input.at ?? new Date(),
            actor: input.actor,
            type: input.type,
            subject: input.subject,
            workstreamId: input.workstreamId ?? null,
            data: input.data ?? {},
        });
        await repo.save(row);
        if (live)
            this.publish(input.workspaceId, live);
        return row;
    }
    publish(workspaceId, event) {
        this.bus.next({
            workspaceId,
            event: {
                ...event,
                clientId: requestStore.getStore()?.clientId,
                at: new Date().toISOString(),
            },
        });
    }
};
EventsService = __decorate([
    Injectable(),
    __param(0, InjectRepository(DomainEventEntity)),
    __metadata("design:paramtypes", [Function])
], EventsService);
export { EventsService };
//# sourceMappingURL=events.service.js.map