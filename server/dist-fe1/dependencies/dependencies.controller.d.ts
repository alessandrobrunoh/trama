import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, DependencyNodeType } from '../contracts/domain.js';
import { DependenciesService } from './dependencies.service.js';
declare class CreateDependencyDto {
    fromType: DependencyNodeType;
    fromId: string;
    toType: DependencyNodeType;
    toId: string;
}
declare class ListDependenciesQuery {
    fromId?: string;
    toId?: string;
}
export declare class DependenciesController {
    private readonly service;
    constructor(service: DependenciesService);
    list(ctx: WorkspaceContext, q: ListDependenciesQuery): Promise<import("../database/entities/index.js").DependencyEntity[]>;
    get(ctx: WorkspaceContext, id: string): Promise<import("../database/entities/index.js").DependencyEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateDependencyDto): Promise<import("../database/entities/index.js").DependencyEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, id: string): Promise<void>;
}
export {};
