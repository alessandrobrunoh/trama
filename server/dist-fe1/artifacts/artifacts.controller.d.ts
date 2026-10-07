import { type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, ArtifactKind, ArtifactProvider, ArtifactState, CiState, ReviewState } from '../contracts/domain.js';
import { ArtifactsService } from './artifacts.service.js';
declare class CreateArtifactDto {
    workstreamId: string;
    kind: ArtifactKind;
    title: string;
    executionId?: string;
    repositoryId?: string;
    provider?: ArtifactProvider;
    url?: string;
    externalId?: string;
    state?: ArtifactState;
    ci?: CiState;
    review?: ReviewState;
    hasConflicts?: boolean;
    environment?: string;
}
declare class UpdateArtifactDto {
    title?: string;
    executionId?: string | null;
    repositoryId?: string | null;
    provider?: ArtifactProvider;
    url?: string | null;
    externalId?: string | null;
    state?: ArtifactState;
    ci?: CiState | null;
    review?: ReviewState | null;
    hasConflicts?: boolean | null;
    environment?: string | null;
}
declare class ListArtifactsQuery {
    workstreamId?: string;
    executionId?: string;
    repositoryId?: string;
    kind?: ArtifactKind;
    state?: ArtifactState;
}
export declare class ArtifactsController {
    private readonly service;
    constructor(service: ArtifactsService);
    list(ctx: WorkspaceContext, q: ListArtifactsQuery): Promise<import("../database/entities/index.js").ArtifactEntity[]>;
    get(ctx: WorkspaceContext, id: string): Promise<import("../database/entities/index.js").ArtifactEntity>;
    create(ctx: WorkspaceContext, actor: ActorRef, dto: CreateArtifactDto): Promise<import("../database/entities/index.js").ArtifactEntity>;
    update(ctx: WorkspaceContext, actor: ActorRef, id: string, dto: UpdateArtifactDto): Promise<import("../database/entities/index.js").ArtifactEntity>;
    remove(ctx: WorkspaceContext, actor: ActorRef, id: string): Promise<void>;
}
export {};
