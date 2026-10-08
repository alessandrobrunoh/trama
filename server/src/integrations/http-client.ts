import { Injectable } from '@nestjs/common';

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Exact bytes to send (already serialized); wins over `body`. Needed when the body is signed. */
  rawBody?: string;
  timeoutMs?: number;
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
    const res = await fetch(req.url, {
      method: req.method ?? 'GET',
      headers: { ...(req.body !== undefined || req.rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}), ...req.headers },
      body: req.rawBody ?? (req.body !== undefined ? JSON.stringify(req.body) : undefined),
      signal: AbortSignal.timeout(req.timeoutMs ?? 15_000),
      redirect: 'error',
    });
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: res.status, headers, json };
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
