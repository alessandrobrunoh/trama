import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, ArtifactKind, ArtifactProvider, ArtifactState, CiState, ReviewState } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { ArtifactEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
export interface ArtifactInput {
    workstreamId?: string;
    executionId?: string | null;
    repositoryId?: string | null;
    kind?: ArtifactKind;
    provider?: ArtifactProvider;
    title?: string;
    url?: string | null;
    externalId?: string | null;
    state?: ArtifactState;
    ci?: CiState | null;
    review?: ReviewState | null;
    hasConflicts?: boolean | null;
    environment?: string | null;
}
export declare class ArtifactsService {
    private readonly ds;
    private readonly refs;
    private readonly events;
    private readonly bus;
    private readonly repo;
    constructor(ds: DataSource, refs: RefsService, events: EventsService, bus: WorkstreamBus, repo: Repository<ArtifactEntity>);
    list(workspaceId: string, f?: {
        workstreamId?: string;
        executionId?: string;
        repositoryId?: string;
        kind?: ArtifactKind;
        state?: ArtifactState;
    }): Promise<ArtifactEntity[]>;
    get(workspaceId: string, id: string): Promise<ArtifactEntity>;
    private validate;
    create(workspaceId: string, actor: ActorRef, input: ArtifactInput & {
        workstreamId: string;
        kind: ArtifactKind;
        title: string;
    }): Promise<ArtifactEntity>;
    private reviewRequested;
    update(workspaceId: string, actor: ActorRef, id: string, patch: ArtifactInput): Promise<ArtifactEntity>;
    remove(workspaceId: string, actor: ActorRef, id: string): Promise<void>;
}
