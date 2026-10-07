import type { EntityManager, Repository } from 'typeorm';
import type { ActorRef, LiveEvent, SubjectRef } from '../contracts/domain.js';
import { DomainEventEntity } from '../database/entities/index.js';
export interface RecordEventInput {
    workspaceId: string;
    actor: ActorRef;
    type: string;
    subject: SubjectRef;
    workstreamId?: string | null;
    data?: Record<string, unknown>;
    at?: Date;
    manager?: EntityManager;
}
export interface PublishedEvent {
    workspaceId: string;
    event: LiveEvent;
}
export declare class EventsService {
    private readonly repo;
    private readonly bus;
    readonly stream$: import("rxjs").Observable<PublishedEvent>;
    constructor(repo: Repository<DomainEventEntity>);
    record(input: RecordEventInput, live?: false | Pick<LiveEvent, 'type' | 'entity' | 'id'>): Promise<DomainEventEntity>;
    publish(workspaceId: string, event: Pick<LiveEvent, 'type' | 'entity' | 'id'>): void;
}
