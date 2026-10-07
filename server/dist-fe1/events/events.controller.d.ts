import { MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Repository } from 'typeorm';
import { type WorkspaceContext } from '../auth/request-context.js';
import { DomainEventEntity } from '../database/entities/index.js';
import { EventsService } from './events.service.js';
declare class ListEventsQuery {
    workstreamId?: string;
    subject?: string;
    type?: string;
    before?: string;
    limit?: number;
}
export declare class EventsController {
    private readonly events;
    private readonly repo;
    constructor(events: EventsService, repo: Repository<DomainEventEntity>);
    list(ctx: WorkspaceContext, q: ListEventsQuery): Promise<DomainEventEntity[]>;
    stream(ctx: WorkspaceContext): Observable<MessageEvent>;
}
export {};
