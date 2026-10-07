import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, DependencyNodeType } from '../contracts/domain.js';
import { DependencyEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
export interface Node {
    type: DependencyNodeType;
    id: string;
}
export declare class DependenciesService {
    private readonly ds;
    private readonly events;
    private readonly bus;
    private readonly repo;
    constructor(ds: DataSource, events: EventsService, bus: WorkstreamBus, repo: Repository<DependencyEntity>);
    list(workspaceId: string, f?: {
        fromId?: string;
        toId?: string;
        id?: string;
    }): Promise<DependencyEntity[]>;
    get(workspaceId: string, id: string): Promise<DependencyEntity>;
    workstreamOf(workspaceId: string, node: Node): Promise<string | undefined>;
    private wouldCycle;
    create(workspaceId: string, actor: ActorRef, from: Node, to: Node): Promise<DependencyEntity>;
    remove(workspaceId: string, actor: ActorRef, id: string): Promise<void>;
    executionDeps(workspaceId: string, executionIds: string[]): Promise<Map<string, string[]>>;
    syncExecutionDeps(workspaceId: string, actor: ActorRef, executionId: string, dependsOn: string[]): Promise<void>;
}
