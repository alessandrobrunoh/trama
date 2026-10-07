import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, InputRequestState } from '../contracts/domain.js';
import { InputRequestsService } from './input-requests.service.js';
declare class CreateInputRequestDto {
    workstreamId?: string;
    executionId?: string;
    question: string;
    options?: string[];
    assigneeUserId?: string;
}
declare class UpdateInputRequestDto {
    question?: string;
    options?: string[] | null;
    assigneeUserId?: string | null;
}
declare class AnswerDto {
    answer: string;
}
declare class ListQuery {
    state?: InputRequestState;
    workstreamId?: string;
    executionId?: string;
    assigneeUserId?: string;
}
export declare class InputRequestsController {
    private readonly service;
    constructor(service: InputRequestsService);
    list(ctx: WorkspaceContext, q: ListQuery): Promise<import("../database/entities/index.js").InputRequestEntity[]>;
    get(ctx: WorkspaceContext, id: string): Promise<import("../database/entities/index.js").InputRequestEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateInputRequestDto): Promise<import("../database/entities/index.js").InputRequestEntity>;
    update(ctx: WorkspaceContext, actor: ActorRef, id: string, dto: UpdateInputRequestDto): Promise<import("../database/entities/index.js").InputRequestEntity>;
    answer(ctx: WorkspaceContext, actor: ActorRef, id: string, dto: AnswerDto): Promise<import("../database/entities/index.js").InputRequestEntity>;
    dismiss(ctx: WorkspaceContext, actor: ActorRef, id: string): Promise<import("../database/entities/index.js").InputRequestEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, id: string): Promise<void>;
}
export {};
