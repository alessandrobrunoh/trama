import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef } from '../contracts/domain.js';
import { TeamsService } from './teams.service.js';
declare class CreateTeamDto {
    name: string;
    key: string;
    color?: string;
    description?: string;
    memberIds?: string[];
}
declare class UpdateTeamDto {
    name?: string;
    color?: string;
    description?: string | null;
    memberIds?: string[];
}
export declare class TeamsController {
    private readonly service;
    constructor(service: TeamsService);
    list(ctx: WorkspaceContext): Promise<import("../database/entities/index.js").TeamEntity[]>;
    get(ctx: WorkspaceContext, idOrKey: string): Promise<import("../database/entities/index.js").TeamEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateTeamDto): Promise<import("../database/entities/index.js").TeamEntity>;
    update(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string, dto: UpdateTeamDto): Promise<import("../database/entities/index.js").TeamEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, idOrKey: string): Promise<void>;
}
export {};
