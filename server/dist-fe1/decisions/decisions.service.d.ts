import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, DecisionStatus } from '../contracts/domain.js';
import { CountersService } from '../common/counters.service.js';
import { RefsService } from '../common/refs.service.js';
import { DecisionEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
export interface DecisionInput {
    title?: string;
    statement?: string;
    rationale?: string | null;
    status?: DecisionStatus;
    originWorkstreamId?: string | null;
    originExecutionId?: string | null;
    relatedWorkstreamIds?: string[];
    tags?: string[];
}
export declare class DecisionsService {
    private readonly ds;
    private readonly refs;
    private readonly counters;
    private readonly events;
    private readonly bus;
    private readonly repo;
    constructor(ds: DataSource, refs: RefsService, counters: CountersService, events: EventsService, bus: WorkstreamBus, repo: Repository<DecisionEntity>);
    list(workspaceId: string, f?: {
        status?: DecisionStatus;
        workstreamId?: string;
        tag?: string;
        q?: string;
    }): Promise<DecisionEntity[]>;
    get(workspaceId: string, idOrKey: string): Promise<DecisionEntity>;
    private touched;
    private validate;
    private requireHuman;
    create(workspaceId: string, actor: ActorRef, input: DecisionInput & {
        title: string;
        statement: string;
    }): Promise<DecisionEntity>;
    private record;
    update(workspaceId: string, actor: ActorRef, idOrKey: string, patch: DecisionInput): Promise<DecisionEntity>;
    accept(workspaceId: string, actor: ActorRef, idOrKey: string): Promise<DecisionEntity>;
    reject(workspaceId: string, actor: ActorRef, idOrKey: string): Promise<DecisionEntity>;
    supersede(workspaceId: string, actor: ActorRef, idOrKey: string, byId: string): Promise<DecisionEntity>;
    remove(workspaceId: string, actor: ActorRef, idOrKey: string): Promise<void>;
}
