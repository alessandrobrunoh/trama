import { type WorkspaceContext } from '../auth/request-context.js';
import { SearchService, type SearchType } from './search.service.js';
declare class SearchQuery {
    q: string;
    types?: SearchType[];
    limit?: number;
}
export declare class SearchController {
    private readonly service;
    constructor(service: SearchService);
    search(ctx: WorkspaceContext, q: SearchQuery): Promise<{
        results: import("./search.service.js").SearchResult[];
    }>;
}
export {};
