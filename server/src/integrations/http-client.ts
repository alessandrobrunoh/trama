import { Injectable } from '@nestjs/common';
import { safeRequest } from '../common/safe-fetch.js';

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Exact bytes to send (already serialized); wins over `body`. Needed when the body is signed. */
  rawBody?: string;
  timeoutMs?: number;
  /** Response body cap in bytes (default 10 MB). */
  maxBytes?: number;
  /** With `maxBytes`: cut the body instead of failing; for callers that only need the status. */
  truncate?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

/**
 * Outbound HTTP used for provider APIs. An abstract class so it can be the DI
 * token; tests replace it with a mock (`overrideProvider(HttpClient)`), so no test hits the network.
 */
export abstract class HttpClient {
  abstract request(req: HttpRequest): Promise<HttpResponse>;
}

@Injectable()
export class FetchHttpClient extends HttpClient {
  async request(req: HttpRequest): Promise<HttpResponse> {
    // Every URL here is user-influenced (webhook target, integration baseUrl): go through the SSRF guard.
    const res = await safeRequest({
      url: req.url,
      method: req.method ?? 'GET',
      headers: { ...(req.body !== undefined || req.rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}), ...req.headers },
      body: req.rawBody ?? (req.body !== undefined ? JSON.stringify(req.body) : undefined),
      timeoutMs: req.timeoutMs ?? 15_000,
      maxBytes: req.maxBytes,
      truncate: req.truncate,
    });
    if (res.status >= 300 && res.status < 400) throw new Error(`Redirects are not followed (HTTP ${res.status})`);
    const text = res.body.toString('utf8');
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, headers: res.headers, json };
  }
}

/** The provider answered with a non-2xx status. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Set when the response signals rate limiting. */
    readonly rateLimitedUntil?: Date,
  ) {
    super(message);
  }
  get rateLimited(): boolean {
    return !!this.rateLimitedUntil;
  }
}
