import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, GitProvider } from '../contracts/domain.js';
import { RepositoriesService } from './repositories.service.js';
declare class CreateRepositoryDto {
    provider: GitProvider;
    fullName: string;
    url?: string;
    defaultBranch?: string;
    teamIds?: string[];
}
declare class UpdateRepositoryDto {
    url?: string;
    defaultBranch?: string;
    teamIds?: string[];
}
export declare class RepositoriesController {
    private readonly service;
    constructor(service: RepositoriesService);
    list(ctx: WorkspaceContext): Promise<import("../database/entities/index.js").RepositoryEntity[]>;
    get(ctx: WorkspaceContext, id: string): Promise<import("../database/entities/index.js").RepositoryEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateRepositoryDto): Promise<import("../database/entities/index.js").RepositoryEntity>;
    update(ctx: WorkspaceContext, actor: ActorRef, id: string, dto: UpdateRepositoryDto): Promise<import("../database/entities/index.js").RepositoryEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, id: string): Promise<void>;
}
export {};
