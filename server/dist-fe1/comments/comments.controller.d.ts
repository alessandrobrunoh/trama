import { type WorkspaceContext } from '../auth/request-context.js';
import type { SubjectType } from '../contracts/domain.js';
import { CommentsService } from './comments.service.js';
declare class SubjectDto {
    type: SubjectType;
    id: string;
}
declare class CreateCommentDto {
    subject: SubjectDto;
    body: string;
}
declare class UpdateCommentDto {
    body: string;
}
declare class ListCommentsQuery {
    subjectType?: SubjectType;
    subjectId?: string;
}
export declare class CommentsController {
    private readonly service;
    constructor(service: CommentsService);
    list(ctx: WorkspaceContext, q: ListCommentsQuery): Promise<import("../database/entities/index.js").CommentEntity[]>;
    create(ctx: WorkspaceContext, dto: CreateCommentDto): Promise<import("../database/entities/index.js").CommentEntity>;
    update(ctx: WorkspaceContext, id: string, dto: UpdateCommentDto): Promise<import("../database/entities/index.js").CommentEntity>;
    remove(ctx: WorkspaceContext, id: string): Promise<void>;
}
export {};
