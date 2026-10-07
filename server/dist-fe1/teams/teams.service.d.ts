import { DataSource, type Repository } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { TeamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
export interface TeamInput {
    name?: string;
    key?: string;
    color?: string;
    description?: string | null;
    memberIds?: string[];
}
export declare class TeamsService {
    private readonly ds;
    private readonly refs;
    private readonly events;
    private readonly repo;
    constructor(ds: DataSource, refs: RefsService, events: EventsService, repo: Repository<TeamEntity>);
    list(workspaceId: string): Promise<TeamEntity[]>;
    get(workspaceId: string, idOrKey: string): Promise<TeamEntity>;
    create(workspaceId: string, actor: ActorRef, input: TeamInput & {
        name: string;
        key: string;
    }): Promise<TeamEntity>;
    update(workspaceId: string, actor: ActorRef, idOrKey: string, patch: TeamInput): Promise<TeamEntity>;
    remove(workspaceId: string, actor: ActorRef, idOrKey: string): Promise<void>;
}
