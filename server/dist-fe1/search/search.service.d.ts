import { DataSource } from 'typeorm';
export declare const SEARCH_TYPES: readonly ["workstream", "intake", "decision", "execution", "artifact", "repository", "team"];
export type SearchType = (typeof SEARCH_TYPES)[number];
export interface SearchResult {
    type: SearchType;
    id: string;
    key?: string;
    title: string;
    subtitle: string;
    workstreamKey?: string;
    score: number;
}
interface Row {
    id: string;
    key: string | null;
    title: string;
    subtitle: string;
    workstreamKey: string | null;
    body: string | null;
}
export declare function scoreRow(q: string, row: Pick<Row, 'key' | 'title' | 'body'>): number;
export declare class SearchService {
    private readonly ds;
    constructor(ds: DataSource);
    search(workspaceId: string, q: string, opts?: {
        types?: SearchType[];
        limit?: number;
    }): Promise<{
        results: SearchResult[];
    }>;
}
export {};
