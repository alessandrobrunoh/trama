import { ProviderHttpError } from './http-client.js';
function describeError(res) {
    const j = res.json;
    const m = typeof j?.message === 'string' ? j.message : typeof j?.error === 'string' ? j.error : '';
    return m ? `${res.status}: ${m}` : String(res.status);
}
function ensureOk(res) {
    if (res.status >= 200 && res.status < 300)
        return;
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
export function normalizeBaseUrl(raw) {
    if (!raw?.trim())
        return null;
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error('baseUrl must be http(s)');
    if (url.username || url.password)
        throw new Error('baseUrl must not contain credentials');
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
export class GithubClient {
    http;
    token;
    api;
    constructor(http, token, baseUrl) {
        this.http = http;
        this.token = token;
        const base = baseUrl ?? 'https://github.com';
        this.api = /^https?:\/\/(www\.)?github\.com$/.test(base)
            ? 'https://api.github.com'
            : base.endsWith('/api/v3')
                ? base
                : `${base}/api/v3`;
    }
    async get(path) {
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
        const j = (await this.get('/user')).json;
        if (!j?.login)
            throw new ProviderHttpError(502, 'Unexpected response from GitHub /user');
        return { account: j.login };
    }
    map(r) {
        return {
            fullName: String(r.full_name),
            url: String(r.html_url),
            defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
            private: Boolean(r.private),
            description: typeof r.description === 'string' ? r.description : undefined,
        };
    }
    async listRepositories(page, perPage) {
        const res = await this.get(`/user/repos?per_page=${perPage}&page=${page}&sort=pushed`);
        const list = Array.isArray(res.json) ? res.json : [];
        return { items: list.map((r) => this.map(r)), page, perPage, hasMore: /rel="next"/.test(res.headers.link ?? '') };
    }
    async getRepository(fullName) {
        return this.map((await this.get(`/repos/${fullName}`)).json);
    }
}
export class GitlabClient {
    http;
    token;
    api;
    constructor(http, token, baseUrl) {
        this.http = http;
        this.token = token;
        this.api = `${baseUrl ?? 'https://gitlab.com'}/api/v4`;
    }
    async get(path) {
        const res = await this.http.request({
            url: `${this.api}${path}`,
            headers: { 'PRIVATE-TOKEN': this.token, Accept: 'application/json', 'User-Agent': 'nabla' },
        });
        ensureOk(res);
        return res;
    }
    async currentUser() {
        const j = (await this.get('/user')).json;
        if (!j?.username)
            throw new ProviderHttpError(502, 'Unexpected response from GitLab /user');
        return { account: j.username };
    }
    map(r) {
        return {
            fullName: String(r.path_with_namespace),
            url: String(r.web_url),
            defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : 'main',
            private: r.visibility !== undefined ? r.visibility !== 'public' : undefined,
            description: typeof r.description === 'string' ? r.description : undefined,
        };
    }
    async listRepositories(page, perPage) {
        const res = await this.get(`/projects?membership=true&simple=true&per_page=${perPage}&page=${page}&order_by=last_activity_at`);
        const list = Array.isArray(res.json) ? res.json : [];
        return { items: list.map((r) => this.map(r)), page, perPage, hasMore: !!res.headers['x-next-page'] };
    }
    async getRepository(fullName) {
        return this.map((await this.get(`/projects/${encodeURIComponent(fullName)}`)).json);
    }
}
export function createGitClient(provider, http, token, baseUrl) {
    return provider === 'github' ? new GithubClient(http, token, baseUrl) : new GitlabClient(http, token, baseUrl);
}
//# sourceMappingURL=providers.js.map