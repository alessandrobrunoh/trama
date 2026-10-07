import type { Repository } from 'typeorm';
import { type WorkspaceContext } from '../auth/request-context.js';
import type { SavedView, ViewEntity, ViewFilter, ViewLayout } from '../contracts/domain.js';
import { SavedViewEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
export interface ViewInput {
    name?: string;
    entity?: ViewEntity;
    filters?: ViewFilter[];
    sort?: SavedView['sort'] | null;
    groupBy?: string | null;
    layout?: ViewLayout;
    shared?: boolean;
}
export declare class ViewsService {
    private readonly events;
    private readonly repo;
    constructor(events: EventsService, repo: Repository<SavedViewEntity>);
    list(workspaceId: string, userId: string | undefined): Promise<SavedViewEntity[]>;
    get(ctx: WorkspaceContext, id: string): Promise<SavedViewEntity>;
    create(ctx: WorkspaceContext, input: ViewInput & {
        name: string;
        entity: ViewEntity;
    }): Promise<SavedViewEntity>;
    private assertCanEdit;
    update(ctx: WorkspaceContext, id: string, patch: ViewInput): Promise<SavedViewEntity>;
    remove(ctx: WorkspaceContext, id: string): Promise<void>;
}
