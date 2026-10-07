import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, CriterionState, Priority, WorkstreamStatus } from '../contracts/domain.js';
import { WorkstreamsService } from './workstreams.service.js';
export declare const PRIORITIES: Priority[];
export declare const STATUSES: WorkstreamStatus[];
export declare class CriterionDto {
    id?: string;
    text: string;
    state?: CriterionState;
}
declare class UpdateCriterionDto {
    text?: string;
    state?: CriterionState;
}
export declare class CreateWorkstreamDto {
    title: string;
    ownerTeamId: string;
    objective?: string;
    context?: string;
    participatingTeamIds?: string[];
    accountableUserId?: string;
    repositoryIds?: string[];
    acceptanceCriteria?: CriterionDto[];
    priority?: Priority;
    labels?: string[];
    statusOverride?: 'draft' | 'canceled';
    targetDate?: string;
}
declare class UpdateWorkstreamDto {
    title?: string;
    objective?: string;
    context?: string | null;
    ownerTeamId?: string;
    participatingTeamIds?: string[];
    accountableUserId?: string | null;
    repositoryIds?: string[];
    acceptanceCriteria?: CriterionDto[];
    priority?: Priority;
    labels?: string[];
    statusOverride?: 'draft' | 'canceled' | null;
    targetDate?: string | null;
}
declare class ListWorkstreamsQuery {
    status?: WorkstreamStatus;
    ownerTeamId?: string;
    teamId?: string;
    accountableUserId?: string;
    priority?: Priority;
    repositoryId?: string;
    label?: string;
    q?: string;
}
export declare class WorkstreamsController {
    private readonly service;
    constructor(service: WorkstreamsService);
    list(ctx: WorkspaceContext, q: ListWorkstreamsQuery): Promise<import("../database/entities/index.js").WorkstreamEntity[]>;
    get(ctx: WorkspaceContext, idOrKey: string): Promise<import("../database/entities/index.js").WorkstreamEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateWorkstreamDto): Promise<import("../database/entities/index.js").WorkstreamEntity & {
        after?: () => Promise<void>;
    }>;
    update(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, dto: UpdateWorkstreamDto): Promise<import("../database/entities/index.js").WorkstreamEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string): Promise<void>;
    addCriterion(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, dto: CriterionDto): Promise<import("../database/entities/index.js").WorkstreamEntity>;
    updateCriterion(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, criterionId: string, dto: UpdateCriterionDto): Promise<import("../database/entities/index.js").WorkstreamEntity>;
    removeCriterion(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, criterionId: string): Promise<import("../database/entities/index.js").WorkstreamEntity>;
}
export {};
