import { DataSource, type Repository } from 'typeorm';
import { type ActorRef, type ExecutionProvider, type ExecutionState } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { ExecutionEntity } from '../database/entities/index.js';
import { DependenciesService } from '../dependencies/dependencies.service.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
export interface ExecutionInput {
    workstreamId?: string;
    parentExecutionId?: string | null;
    title?: string;
    description?: string | null;
    teamId?: string | null;
    repositoryIds?: string[];
    performers?: ActorRef[];
    provider?: ExecutionProvider;
    state?: ExecutionState;
    dependsOnExecutionIds?: string[];
    sessionUrl?: string | null;
    branch?: string | null;
    progressNote?: string | null;
}
export interface ExecutionFilter {
    workstreamId?: string;
    state?: ExecutionState;
    parentExecutionId?: string;
    teamId?: string;
}
export declare class ExecutionsService {
    private readonly ds;
    private readonly refs;
    private readonly events;
    private readonly bus;
    private readonly deps;
    private readonly repo;
    constructor(ds: DataSource, refs: RefsService, events: EventsService, bus: WorkstreamBus, deps: DependenciesService, repo: Repository<ExecutionEntity>);
    attach<T extends ExecutionEntity | ExecutionEntity[]>(workspaceId: string, rows: T): Promise<T>;
    list(workspaceId: string, f?: ExecutionFilter): Promise<ExecutionEntity[]>;
    get(workspaceId: string, id: string): Promise<ExecutionEntity>;
    private validate;
    private inferProvider;
    create(workspaceId: string, actor: ActorRef, input: ExecutionInput & {
        workstreamId: string;
        title: string;
    }): Promise<ExecutionEntity>;
    update(workspaceId: string, actor: ActorRef, id: string, patch: ExecutionInput): Promise<ExecutionEntity>;
    private applyState;
    progress(workspaceId: string, actor: ActorRef, id: string, input: {
        note: string;
        state?: ExecutionState;
    }): Promise<ExecutionEntity>;
    complete(workspaceId: string, actor: ActorRef, id: string, input: {
        note?: string;
    }): Promise<ExecutionEntity>;
    remove(workspaceId: string, actor: ActorRef, id: string): Promise<void>;
}
