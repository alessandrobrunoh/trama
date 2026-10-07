import type { Repository } from 'typeorm';
import { type WorkspaceContext } from '../auth/request-context.js';
import type { SubjectRef } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { CommentEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
export declare class CommentsService {
    private readonly refs;
    private readonly events;
    private readonly bus;
    private readonly repo;
    constructor(refs: RefsService, events: EventsService, bus: WorkstreamBus, repo: Repository<CommentEntity>);
    list(workspaceId: string, f?: {
        subjectType?: string;
        subjectId?: string;
    }): Promise<CommentEntity[]>;
    get(workspaceId: string, id: string): Promise<CommentEntity>;
    create(ctx: WorkspaceContext, subject: SubjectRef, body: string): Promise<CommentEntity>;
    update(ctx: WorkspaceContext, id: string, body: string): Promise<CommentEntity>;
    remove(ctx: WorkspaceContext, id: string): Promise<void>;
}
