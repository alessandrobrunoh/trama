import { DataSource } from 'typeorm';
import type { Graph } from './graph.types.js';
export interface GraphOptions {
    teamId?: string;
    workstreamId?: string;
    includeArtifacts?: boolean;
    includeActors?: boolean;
    includeRepositories?: boolean;
}
export declare class GraphService {
    private readonly ds;
    constructor(ds: DataSource);
    build(workspaceId: string, opts?: GraphOptions): Promise<Graph>;
}
