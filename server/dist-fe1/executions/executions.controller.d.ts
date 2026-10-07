import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, ExecutionProvider, ExecutionState } from '../contracts/domain.js';
import { ExecutionsService } from './executions.service.js';
declare class ActorRefDto {
    type: 'user' | 'agent' | 'team';
    id: string;
}
declare class CreateExecutionDto {
    workstreamId: string;
    title: string;
    parentExecutionId?: string;
    description?: string;
    teamId?: string;
    repositoryIds?: string[];
    performers?: ActorRefDto[];
    provider?: ExecutionProvider;
    state?: ExecutionState;
    dependsOnExecutionIds?: string[];
    sessionUrl?: string;
    branch?: string;
    progressNote?: string;
}
declare class UpdateExecutionDto {
    title?: string;
    parentExecutionId?: string | null;
    description?: string | null;
    teamId?: string | null;
    repositoryIds?: string[];
    performers?: ActorRefDto[];
    provider?: ExecutionProvider;
    state?: ExecutionState;
    dependsOnExecutionIds?: string[];
    sessionUrl?: string | null;
    branch?: string | null;
    progressNote?: string | null;
}
declare class ProgressDto {
    note: string;
    state?: ExecutionState;
}
declare class CompleteDto {
    note?: string;
}
declare class ListExecutionsQuery {
    workstreamId?: string;
    state?: ExecutionState;
    parentExecutionId?: string;
    teamId?: string;
}
export declare class ExecutionsController {
    private readonly service;
    constructor(service: ExecutionsService);
    list(ctx: WorkspaceContext, q: ListExecutionsQuery): Promise<import("../database/entities/index.js").ExecutionEntity[]>;
    get(ctx: WorkspaceContext, id: string): Promise<import("../database/entities/index.js").ExecutionEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateExecutionDto): Promise<import("../database/entities/index.js").ExecutionEntity>;
    update(ctx: WorkspaceContext, actor: ActorRef, id: string, dto: UpdateExecutionDto): Promise<import("../database/entities/index.js").ExecutionEntity>;
    progress(ctx: WorkspaceContext, actor: ActorRef, id: string, dto: ProgressDto): Promise<import("../database/entities/index.js").ExecutionEntity>;
    complete(ctx: WorkspaceContext, actor: ActorRef, id: string, dto: CompleteDto): Promise<import("../database/entities/index.js").ExecutionEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, id: string): Promise<void>;
}
export {};
