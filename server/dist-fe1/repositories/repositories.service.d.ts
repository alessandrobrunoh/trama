import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, GitProvider } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { RepositoryEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
export interface RepositoryInput {
    provider?: GitProvider;
    fullName?: string;
    url?: string;
    defaultBranch?: string;
    teamIds?: string[];
}
export declare class RepositoriesService {
    private readonly ds;
    private readonly refs;
    private readonly events;
    private readonly repo;
    constructor(ds: DataSource, refs: RefsService, events: EventsService, repo: Repository<RepositoryEntity>);
    list(workspaceId: string): Promise<RepositoryEntity[]>;
    get(workspaceId: string, id: string): Promise<RepositoryEntity>;
    create(workspaceId: string, actor: ActorRef, input: RepositoryInput & {
        provider: GitProvider;
        fullName: string;
    }): Promise<RepositoryEntity>;
    update(workspaceId: string, actor: ActorRef, id: string, patch: RepositoryInput): Promise<RepositoryEntity>;
    remove(workspaceId: string, actor: ActorRef, id: string): Promise<void>;
}
