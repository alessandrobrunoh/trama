import { DataSource } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { type RepositoryEntity } from '../database/entities/index.js';
import type { ArtifactCandidate, CiPatch } from './candidates.js';
export declare const SYSTEM_ACTOR: ActorRef;
export interface LinkResult {
    created: number;
    updated: number;
    workstreamKeys: string[];
}
export declare class ArtifactLinkerService {
    private readonly ds;
    private readonly artifacts;
    private readonly logger;
    private readonly locks;
    constructor(ds: DataSource, artifacts: ArtifactsService);
    private serial;
    keyMap(workspaceId: string): Promise<Map<string, string>>;
    upsert(workspaceId: string, repo: RepositoryEntity, c: ArtifactCandidate): Promise<LinkResult>;
    private doUpsert;
    applyCi(workspaceId: string, repo: RepositoryEntity, patch: CiPatch): Promise<number>;
}
