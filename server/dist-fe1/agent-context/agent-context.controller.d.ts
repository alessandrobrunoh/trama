import type { Request, Response } from 'express';
import { type WorkspaceContext } from '../auth/request-context.js';
import { AgentContextService } from './agent-context.service.js';
declare class ContextQuery {
    format?: 'markdown' | 'json';
}
export declare class AgentContextController {
    private readonly service;
    constructor(service: AgentContextService);
    get(ctx: WorkspaceContext, idOrKey: string, q: ContextQuery, req: Request, res: Response): Promise<string | import("./agent-context.service.js").AgentContext>;
}
export {};
