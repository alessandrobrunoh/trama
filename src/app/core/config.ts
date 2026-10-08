// App-wide configuration tokens.
import { InjectionToken } from '@angular/core';
import { environment } from '../../environments/environment';

/**
 * Base URL of the NestJS backend (new-delta-linear-clone/server/). Defaults to
 * '/api' — `ng serve` proxies /api → http://localhost:3000 via proxy.conf.json.
 * Usage: `private readonly api = inject(API_BASE_URL);  http.get(`${this.api}/issues`)`.
 */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL', {
  providedIn: 'root',
  factory: () => environment.apiBaseUrl,
});

/** Absolute URL of the MCP server (Streamable HTTP), shown in Settings → API tokens. */
export const MCP_URL = new InjectionToken<string>('MCP_URL', {
  providedIn: 'root',
  factory: () => (typeof location !== 'undefined' ? location.origin : '') + environment.mcpPath,
});
