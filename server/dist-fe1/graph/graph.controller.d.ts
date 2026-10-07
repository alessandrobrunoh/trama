import { type WorkspaceContext } from '../auth/request-context.js';
import { WorkstreamsService } from '../workstreams/workstreams.service.js';
import { GraphService } from './graph.service.js';
declare class GraphQuery {
    teamId?: string;
    workstreamId?: string;
    includeArtifacts?: boolean;
    includeActors?: boolean;
    includeRepositories?: boolean;
}
declare class WorkstreamGraphQuery {
    includeArtifacts?: boolean;
    includeActors?: boolean;
    includeRepositories?: boolean;
}
export declare class GraphController {
    private readonly service;
    private readonly workstreams;
    constructor(service: GraphService, workstreams: WorkstreamsService);
    workspace(ctx: WorkspaceContext, q: GraphQuery): Promise<import("./graph.types.js").Graph>;
    forWorkstream(ctx: WorkspaceContext, idOrKey: string, q: WorkstreamGraphQuery): Promise<import("./graph.types.js").Graph>;
}
export {};
