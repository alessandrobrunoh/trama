import { type WorkspaceContext } from '../auth/request-context.js';
import type { SavedView, ViewEntity, ViewFilter, ViewLayout } from '../contracts/domain.js';
import { ViewsService } from './views.service.js';
declare class FilterDto {
    field: string;
    op: ViewFilter['op'];
    value: string | string[];
}
declare class CreateViewDto {
    name: string;
    entity: ViewEntity;
    filters?: FilterDto[];
    sort?: SavedView['sort'];
    groupBy?: string;
    layout?: ViewLayout;
    shared?: boolean;
}
declare class UpdateViewDto {
    name?: string;
    entity?: ViewEntity;
    filters?: FilterDto[];
    sort?: SavedView['sort'] | null;
    groupBy?: string | null;
    layout?: ViewLayout;
    shared?: boolean;
}
export declare class ViewsController {
    private readonly service;
    constructor(service: ViewsService);
    list(ctx: WorkspaceContext): Promise<import("../database/entities/index.js").SavedViewEntity[]>;
    get(ctx: WorkspaceContext, id: string): Promise<import("../database/entities/index.js").SavedViewEntity>;
    create(ctx: WorkspaceContext, dto: CreateViewDto): Promise<import("../database/entities/index.js").SavedViewEntity>;
    update(ctx: WorkspaceContext, id: string, dto: UpdateViewDto): Promise<import("../database/entities/index.js").SavedViewEntity>;
    remove(ctx: WorkspaceContext, id: string): Promise<void>;
}
export {};
