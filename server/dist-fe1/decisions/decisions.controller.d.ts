import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, DecisionStatus } from '../contracts/domain.js';
import { DecisionsService } from './decisions.service.js';
declare class CreateDecisionDto {
    title: string;
    statement: string;
    rationale?: string;
    status?: DecisionStatus;
    originWorkstreamId?: string;
    originExecutionId?: string;
    relatedWorkstreamIds?: string[];
    tags?: string[];
}
declare class UpdateDecisionDto {
    title?: string;
    statement?: string;
    rationale?: string | null;
    originWorkstreamId?: string | null;
    originExecutionId?: string | null;
    relatedWorkstreamIds?: string[];
    tags?: string[];
}
declare class SupersedeDto {
    byId: string;
}
declare class ListDecisionsQuery {
    status?: DecisionStatus;
    workstreamId?: string;
    tag?: string;
    q?: string;
}
export declare class DecisionsController {
    private readonly service;
    constructor(service: DecisionsService);
    list(ctx: WorkspaceContext, q: ListDecisionsQuery): Promise<import("../database/entities/index.js").DecisionEntity[]>;
    get(ctx: WorkspaceContext, idOrKey: string): Promise<import("../database/entities/index.js").DecisionEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateDecisionDto): Promise<import("../database/entities/index.js").DecisionEntity>;
    update(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, dto: UpdateDecisionDto): Promise<import("../database/entities/index.js").DecisionEntity>;
    accept(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string): Promise<import("../database/entities/index.js").DecisionEntity>;
    reject(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string): Promise<import("../database/entities/index.js").DecisionEntity>;
    supersede(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, dto: SupersedeDto): Promise<import("../database/entities/index.js").DecisionEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string): Promise<void>;
}
export {};
