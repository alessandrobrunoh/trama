import { HttpClient, ProviderHttpError, type HttpResponse } from '../integrations/http-client.js';
import { ensureOk } from '../integrations/providers.js';
import { githubIssueId, mapGithubState, priorityFromLabels, redactSecrets } from './mapping.js';
import type {
  Discovery,
  DiscoveredEntity,
  ExternalComment,
  ExternalIssue,
  ExternalMilestone,
  ExternalUser,
  ImportSourceAdapter,
  Page,
} from './types.js';

const PER_PAGE = 100;
const MAX_LIST_PAGES = 5;

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Where the REST API lives: api.github.com for github.com, `<base>/api/v3` for Enterprise. */
export function githubApiBase(baseUrl?: string | null): string {
  const base = baseUrl ?? 'https://github.com';
  if (/^https?:\/\/(www\.)?github\.com$/.test(base)) return 'https://api.github.com';
  return base.endsWith('/api/v3') ? base : `${base}/api/v3`;
}

export function githubUser(raw: unknown): ExternalUser | undefined {
  const u = raw as Json | null;
  const login = str(u?.login);
  return login ? { id: login.toLowerCase(), login, name: str(u?.name) } : undefined;
}

/**
 * Reads issues of one repository through the GitHub REST API. Works without a token for public
 * repositories (60 requests an hour). Reads only; every call goes through HttpClient, hence safe-fetch.
 */
export class GithubAdapter implements ImportSourceAdapter {
  readonly provider = 'github' as const;
  private readonly api: string;
  /** When the budget ran out: the next call waits for it (the runner sleeps, we only report). */
  private blockedUntil = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly token: string | null,
    private readonly repository: string,
    baseUrl?: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.api = githubApiBase(baseUrl);
  }

  private get pseudoId(): string {
    return `repo:${this.repository.toLowerCase()}`;
  }

  private async get(path: string): Promise<HttpResponse> {
    if (this.blockedUntil > this.now()) throw new ProviderHttpError(429, 'Rate limit reached', new Date(this.blockedUntil));
    const res = await this.http.request({
      url: `${this.api}${path}`,
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'trama-importer',
      },
    });
    if (res.headers['x-ratelimit-remaining'] === '0') {
      const reset = Number(res.headers['x-ratelimit-reset']);
      if (Number.isFinite(reset)) this.blockedUntil = reset * 1000;
    }
    try {
      ensureOk(res);
    } catch (e) {
      // A provider message should never carry the token, but whatever is stored or shown must not either.
      if (e instanceof ProviderHttpError) throw new ProviderHttpError(e.status, redactSecrets(e.message, [this.token]), e.rateLimitedUntil);
      throw e;
    }
    return res;
  }

  private async all(path: string, maxPages = MAX_LIST_PAGES): Promise<Json[]> {
    const out: Json[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.get(`${path}${sep}per_page=${PER_PAGE}&page=${page}`);
      const list = Array.isArray(res.json) ? (res.json as Json[]) : [];
      out.push(...list);
      if (!/rel="next"/.test(res.headers.link ?? '')) break;
    }
    return out;
  }

  private async searchCount(state: 'open' | 'closed'): Promise<number | null> {
    try {
      const q = encodeURIComponent(`repo:${this.repository} type:issue state:${state}`);
      const res = await this.get(`/search/issues?q=${q}&per_page=1`);
      const total = (res.json as Json | null)?.total_count;
      return typeof total === 'number' ? total : null;
    } catch (e) {
      // The search API has its own, smaller budget; a count is nice to have, not required.
      if (e instanceof ProviderHttpError && (e.status === 401 || e.status === 404)) throw e;
      return null;
    }
  }

  async discover(): Promise<Discovery> {
    const warnings: string[] = [];
    const repo = (await this.get(`/repos/${this.repository}`)).json as Json;
    const fullName = str(repo.full_name) ?? this.repository;
    if (repo.has_issues === false) warnings.push('Issues are disabled on this repository.');
    let account = 'anonymous';
    if (this.token) {
      try {
        account = str(((await this.get('/user')).json as Json).login) ?? account;
      } catch {
        warnings.push('The token could not read /user; continuing.');
      }
    } else warnings.push('No token: public data only and 60 requests an hour. Add a token for private repositories or large imports.');

    const [open, closed] = [await this.searchCount('open'), await this.searchCount('closed')];
    if (open === null || closed === null) warnings.push('Issue counts are unavailable right now (search rate limit).');

    const labels: DiscoveredEntity[] = (await this.all(`/repos/${this.repository}/labels`)).map((l) => ({
      id: String(l.id),
      name: String(l.name),
      color: str(l.color) ? `#${String(l.color).toLowerCase()}` : undefined,
    }));
    const milestones: ExternalMilestone[] = (await this.all(`/repos/${this.repository}/milestones?state=all`, 3)).map((m) => ({
      id: String(m.id),
      name: String(m.title),
      projectId: this.pseudoId,
      description: str(m.description),
      dueOn: str(m.due_on),
    }));
    let users: ExternalUser[] = [];
    try {
      users = (await this.all(`/repos/${this.repository}/assignees`, 3)).map(githubUser).filter((u): u is ExternalUser => !!u);
    } catch (e) {
      if (e instanceof ProviderHttpError && e.rateLimited) throw e;
      warnings.push('Assignable users could not be listed; assignees stay unmapped unless you add them.');
    }
    const sample = (await this.issues(null, { includeClosed: true })).items.slice(0, 5).map((i) => ({ key: i.key, title: i.title, state: i.state.name }));
    const entity: DiscoveredEntity = { id: this.pseudoId, name: fullName };
    return {
      provider: 'github',
      account,
      sourceLabel: fullName,
      sourceUrl: str(repo.html_url),
      counts: { issues: open !== null && closed !== null ? open + closed : null, open, closed },
      teams: [entity],
      projects: [entity],
      labels,
      milestones,
      users,
      statuses: [
        { id: 'open', name: 'Open', type: 'open', count: open ?? undefined },
        { id: 'closed', name: 'Closed (completed)', type: 'closed' },
        { id: 'not_planned', name: 'Closed (not planned)', type: 'not_planned' },
      ],
      sample,
      warnings,
    };
  }

  private toIssue(raw: Json): ExternalIssue {
    const number = Number(raw.number);
    const labels = ((raw.labels as Json[] | undefined) ?? [])
      .filter((l) => typeof l === 'object' && l)
      .map((l) => ({ id: String(l.id), name: String(l.name), color: str(l.color) ? `#${String(l.color).toLowerCase()}` : undefined }));
    const milestone = raw.milestone as Json | null;
    const assignee = githubUser(raw.assignee ?? (raw.assignees as unknown[] | undefined)?.[0]);
    return {
      id: githubIssueId(this.repository, number),
      key: `#${number}`,
      url: String(raw.html_url),
      title: str(raw.title) ?? '',
      body: str(raw.body) ?? null,
      state: mapGithubState(String(raw.state), str(raw.state_reason)),
      priority: priorityFromLabels(labels.map((l) => l.name)),
      labels,
      assignee,
      creator: githubUser(raw.user),
      teamId: this.pseudoId,
      projectId: this.pseudoId,
      milestone: milestone
        ? { id: String(milestone.id), name: String(milestone.title), projectId: this.pseudoId, description: str(milestone.description), dueOn: str(milestone.due_on) }
        : undefined,
      createdAt: String(raw.created_at),
      updatedAt: String(raw.updated_at ?? raw.created_at),
      closedAt: str(raw.closed_at),
    };
  }

  async issues(cursor: string | null, opts: { includeClosed: boolean }): Promise<Page<ExternalIssue>> {
    const page = Math.max(1, Number(cursor) || 1);
    const state = opts.includeClosed ? 'all' : 'open';
    // Oldest first: the order does not move while new issues arrive, so a resumed page is the same page.
    const res = await this.get(
      `/repos/${this.repository}/issues?state=${state}&sort=created&direction=asc&per_page=${PER_PAGE}&page=${page}`,
    );
    const list = Array.isArray(res.json) ? (res.json as Json[]) : [];
    const items = list.filter((i) => !i.pull_request).map((i) => this.toIssue(i));
    return { items, next: /rel="next"/.test(res.headers.link ?? '') ? String(page + 1) : null };
  }

  async comments(cursor: string | null): Promise<Page<ExternalComment>> {
    const page = Math.max(1, Number(cursor) || 1);
    const res = await this.get(`/repos/${this.repository}/issues/comments?sort=created&direction=asc&per_page=${PER_PAGE}&page=${page}`);
    const list = Array.isArray(res.json) ? (res.json as Json[]) : [];
    const items: ExternalComment[] = [];
    for (const c of list) {
      const number = /\/issues\/(\d+)$/.exec(str(c.issue_url) ?? '')?.[1];
      if (!number || !str(c.body)) continue;
      items.push({
        id: String(c.id),
        issueId: githubIssueId(this.repository, Number(number)),
        author: githubUser(c.user),
        body: String(c.body),
        createdAt: String(c.created_at),
      });
    }
    return { items, next: /rel="next"/.test(res.headers.link ?? '') ? String(page + 1) : null };
  }

  async getIssue(id: string): Promise<ExternalIssue> {
    const number = /#(\d+)$/.exec(id)?.[1];
    if (!number) throw new ProviderHttpError(400, `Not a GitHub issue id: ${id}`);
    return this.toIssue((await this.get(`/repos/${this.repository}/issues/${number}`)).json as Json);
  }
}
