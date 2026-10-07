export interface HttpRequest {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
}
export interface HttpResponse {
    status: number;
    headers: Record<string, string>;
    json: unknown;
}
export declare abstract class HttpClient {
    abstract request(req: HttpRequest): Promise<HttpResponse>;
}
export declare class FetchHttpClient extends HttpClient {
    request(req: HttpRequest): Promise<HttpResponse>;
}
export declare class ProviderHttpError extends Error {
    readonly status: number;
    readonly rateLimitedUntil?: Date | undefined;
    constructor(status: number, message: string, rateLimitedUntil?: Date | undefined);
    get rateLimited(): boolean;
}
