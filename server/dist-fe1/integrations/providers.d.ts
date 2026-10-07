import type { GitProvider } from '../contracts/domain.js';
import { HttpClient } from './http-client.js';
export interface RemoteRepository {
    fullName: string;
    url: string;
    defaultBranch: string;
    private?: boolean;
    description?: string;
}
export interface RemoteRepositoryPage {
    items: RemoteRepository[];
    page: number;
    perPage: number;
    hasMore: boolean;
}
export interface GitProviderClient {
    currentUser(): Promise<{
        account: string;
    }>;
    listRepositories(page: number, perPage: number): Promise<RemoteRepositoryPage>;
    getRepository(fullName: string): Promise<RemoteRepository>;
}
export declare function normalizeBaseUrl(raw: string | undefined | null): string | null;
export declare class GithubClient implements GitProviderClient {
    private readonly http;
    private readonly token;
    private readonly api;
    constructor(http: HttpClient, token: string, baseUrl?: string | null);
    private get;
    currentUser(): Promise<{
        account: string;
    }>;
    private map;
    listRepositories(page: number, perPage: number): Promise<RemoteRepositoryPage>;
    getRepository(fullName: string): Promise<RemoteRepository>;
}
export declare class GitlabClient implements GitProviderClient {
    private readonly http;
    private readonly token;
    private readonly api;
    constructor(http: HttpClient, token: string, baseUrl?: string | null);
    private get;
    currentUser(): Promise<{
        account: string;
    }>;
    private map;
    listRepositories(page: number, perPage: number): Promise<RemoteRepositoryPage>;
    getRepository(fullName: string): Promise<RemoteRepository>;
}
export declare function createGitClient(provider: GitProvider, http: HttpClient, token: string, baseUrl?: string | null): GitProviderClient;
