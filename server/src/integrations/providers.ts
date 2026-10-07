import type { GitProvider } from '../contracts/domain.js';
import { HttpClient, ProviderHttpError, type HttpResponse } from './http-client.js';

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

/** The slice of a git provider API the integrations need today. */
export interface GitProviderClient {
  /** Validates the credential; returns the account (login / username). */
  currentUser(): Promise<{ account: string }>;
  listRepositories(page: number, perPage: number): Promise<RemoteRepositoryPage>;
  getRepository(fullName: string): Promise<RemoteRepository>;
}

function describeError(res: HttpResponse): string {
  const j = res.json as { message?: unknown; error?: unknown } | null;
  const m = typeof j?.message === 'string' ? j.message : typeof j?.error === 'string' ? j.error : '';
  return m ? `${res.status}: ${m}` : String(res.status);
}

/** Throws ProviderHttpError (with rate-limit info) for non-2xx responses. */
function ensureOk(res: HttpResponse): void {
  if (res.status >= 200 && res.status < 300) return;
  const remaining = res.headers['x-ratelimit-remaining'] ?? res.headers['ratelimit-remaining'];
  const retryAfter = Number(res.headers['retry-after']);
  const reset = Number(res.headers['x-ratelimit-reset'] ?? res.headers['ratelimit-reset']);
  if (res.status === 429 || (res.status === 403 && (remaining === '0' || Number.isFinite(retryAfter)))) {
    const until = Number.isFinite(retryAfter)
      ? new Date(Date.now() + retryAfter * 1000)
      : Number.isFinite(reset)
        ? new Date(reset * 1000)
        : new Date(Date.now() + 60_000);
    throw new ProviderHttpError(res.status, `Rate limited (${describeError(res)})`, until);
  }
  throw new ProviderHttpError(res.status, describeError(res));
}

export function normalizeBaseUrl(raw: string | undefined | null): string | null {
  if (!raw?.trim()) return null;
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('baseUrl must be http(s)');
  if (url.username || url.password) throw new Error('baseUrl must not contain credentials');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class GithubClient implements GitProviderClient {
  private readonly api: string;
  constructor(
    private readonly http: HttpClient,
    private readonly token: string,
    baseUrl?: string | null,
  ) {
    const base = baseUrl ?? 'https://github.com';
    this.api = /^https?:\/\/(www\.)?github\.com$/.test(base)
      ? 'https://api.github.com'
      : base.endsWith('/api/v3')
        ? base
        : `${base}/api/v3`;
  }

  private async get(path: string): Promise<HttpResponse> {
    const res = await this.http.request({
      url: `${this.api}${path}`,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'nabla',
      },
    });
    ensureOk(res);
    return res;
  }

  async currentUser() {
    const j = (await this.get('/user')).json as { login?: string };
    if (!j?.login) throw new ProviderHttpError(502, 'Unexpected response from GitHub /user');
    return { account: j.login };
  }

  private map(r: Record<string, unknown>): RemoteRepository {
    return {
      fullName: String(r.full_name),
      url: String(r.html_url),
      defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
      private: Boolean(r.private),
      description: typeof r.description === 'string' ? r.description : undefined,
    };
  }

  async listRepositories(page: number, perPage: number): Promise<RemoteRepositoryPage> {
    const res = await this.get(`/user/repos?per_page=${perPage}&page=${page}&sort=pushed`);
    const list = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
    return { items: list.map((r) => this.map(r)), page, perPage, hasMore: /rel="next"/.test(res.headers.link ?? '') };
  }

  async getRepository(fullName: string) {
    return this.map((await this.get(`/repos/${fullName}`)).json as Record<string, unknown>);
  }
}

export class GitlabClient implements GitProviderClient {
  private readonly api: string;
  constructor(
    private readonly http: HttpClient,
    private readonly token: string,
    baseUrl?: string | null,
  ) {
    this.api = `${baseUrl ?? 'https://gitlab.com'}/api/v4`;
  }

  private async get(path: string): Promise<HttpResponse> {
    const res = await this.http.request({
      url: `${this.api}${path}`,
      headers: { 'PRIVATE-TOKEN': this.token, Accept: 'application/json', 'User-Agent': 'nabla' },
    });
    ensureOk(res);
    return res;
  }

  async currentUser() {
    const j = (await this.get('/user')).json as { username?: string };
    if (!j?.username) throw new ProviderHttpError(502, 'Unexpected response from GitLab /user');
    return { account: j.username };
  }

  private map(r: Record<string, unknown>): RemoteRepository {
    return {
      fullName: String(r.path_with_namespace),
      url: String(r.web_url),
      defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
      private: r.visibility !== undefined ? r.visibility !== 'public' : undefined,
      description: typeof r.description === 'string' ? r.description : undefined,
    };
  }

  async listRepositories(page: number, perPage: number): Promise<RemoteRepositoryPage> {
    const res = await this.get(`/projects?membership=true&simple=true&per_page=${perPage}&page=${page}&order_by=last_activity_at`);
    const list = Array.isArray(res.json) ? (res.json as Record<string, unknown>[]) : [];
    return { items: list.map((r) => this.map(r)), page, perPage, hasMore: !!res.headers['x-next-page'] };
  }

  async getRepository(fullName: string) {
    return this.map((await this.get(`/projects/${encodeURIComponent(fullName)}`)).json as Record<string, unknown>);
  }
}

export function createGitClient(provider: GitProvider, http: HttpClient, token: string, baseUrl?: string | null): GitProviderClient {
  return provider === 'github' ? new GithubClient(http, token, baseUrl) : new GitlabClient(http, token, baseUrl);
}
