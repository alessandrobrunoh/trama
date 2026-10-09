import { describe, expect, it } from 'vitest';
import { HttpClient, ProviderHttpError, type HttpRequest, type HttpResponse } from '../integrations/http-client.js';
import { GithubAdapter, githubApiBase } from './github-adapter.js';
import { LINEAR_API, LinearAdapter } from './linear-adapter.js';

/** An HttpClient that answers from a table and records every request. No network. */
class FakeHttp extends HttpClient {
  readonly calls: HttpRequest[] = [];
  constructor(private readonly route: (req: HttpRequest) => Partial<HttpResponse> | undefined) {
    super();
  }
  async request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    const r = this.route(req);
    if (!r) throw new Error(`unexpected request ${req.method ?? 'GET'} ${req.url}`);
    return { status: 200, headers: {}, json: null, ...r };
  }
}

const ghIssue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  id: 1000 + n,
  html_url: `https://github.com/acme/api/issues/${n}`,
  title: `Issue ${n}`,
  body: 'body',
  state: 'open',
  labels: [{ id: 1, name: 'bug', color: 'E11D48' }],
  assignee: { login: 'Ada' },
  user: { login: 'carl' },
  milestone: { id: 77, title: 'v1', due_on: '2026-12-01T00:00:00Z' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  ...extra,
});

describe('GithubAdapter', () => {
  const TOKEN = 'ghp_secretsecretsecretsecretsecretsecret1';

  it('lists issues oldest first, drops pull requests, and follows the Link header', async () => {
    const http = new FakeHttp((req) =>
      req.url.includes('/issues?')
        ? {
            json: [ghIssue(1), ghIssue(2, { pull_request: { url: 'x' } }), ghIssue(3, { state: 'closed', state_reason: 'not_planned', closed_at: '2026-02-01T00:00:00Z' })],
            headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
          }
        : undefined,
    );
    const page = await new GithubAdapter(http, TOKEN, 'Acme/api').issues(null, { includeClosed: true });
    expect(page.items.map((i) => i.key)).toEqual(['#1', '#3']);
    expect(page.next).toBe('2');
    expect(http.calls[0].url).toContain('/repos/Acme/api/issues?state=all&sort=created&direction=asc');
    expect(http.calls[0].headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    const first = page.items[0];
    expect(first).toMatchObject({
      id: 'acme/api#1',
      state: { id: 'open' },
      assignee: { id: 'ada', login: 'Ada' },
      milestone: { id: '77', name: 'v1' },
      labels: [{ id: '1', name: 'bug', color: '#e11d48' }],
    });
    expect(page.items[1].state).toMatchObject({ id: 'not_planned', type: 'not_planned' });
  });

  it('only asks for open issues when closed ones are excluded, and ends without a next link', async () => {
    const http = new FakeHttp(() => ({ json: [] }));
    const page = await new GithubAdapter(http, null, 'acme/api').issues('4', { includeClosed: false });
    expect(page.next).toBeNull();
    expect(http.calls[0].url).toContain('state=open');
    expect(http.calls[0].url).toContain('page=4');
    // public repositories are read without a token
    expect(http.calls[0].headers?.Authorization).toBeUndefined();
  });

  it('turns repo-wide comments into per-issue comments', async () => {
    const http = new FakeHttp(() => ({
      json: [
        { id: 5, issue_url: 'https://api.github.com/repos/acme/api/issues/12', body: 'hello', user: { login: 'Dee' }, created_at: '2026-01-03T00:00:00Z' },
        { id: 6, issue_url: 'https://api.github.com/repos/acme/api/issues/12', body: '', user: { login: 'Dee' }, created_at: '2026-01-04T00:00:00Z' },
      ],
    }));
    const page = await new GithubAdapter(http, null, 'acme/api').comments(null);
    expect(page.items).toEqual([{ id: '5', issueId: 'acme/api#12', author: { id: 'dee', login: 'Dee', name: undefined }, body: 'hello', createdAt: '2026-01-03T00:00:00Z' }]);
  });

  it('reports a rate limit with the time it ends, and stops calling until then', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const http = new FakeHttp(() => ({ status: 403, json: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }));
    const adapter = new GithubAdapter(http, TOKEN, 'acme/api');
    const err = await adapter.issues(null, { includeClosed: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).rateLimited).toBe(true);
    expect((err as ProviderHttpError).rateLimitedUntil?.getTime()).toBe(reset * 1000);
    // the budget is known to be spent: no second request is sent
    await adapter.issues(null, { includeClosed: true }).catch(() => undefined);
    expect(http.calls).toHaveLength(1);
  });

  it('never puts the token in an error message', async () => {
    const http = new FakeHttp(() => ({ status: 401, json: { message: 'Bad credentials' } }));
    const err = (await new GithubAdapter(http, TOKEN, 'acme/api').issues(null, { includeClosed: true }).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });

  it('reads one issue by id and describes the source in discover()', async () => {
    const http = new FakeHttp((req) => {
      if (req.url.endsWith('/repos/acme/api')) return { json: { full_name: 'acme/api', html_url: 'https://github.com/acme/api', has_issues: true } };
      if (req.url.endsWith('/user')) return { json: { login: 'ada' } };
      if (req.url.includes('/search/issues')) return { json: { total_count: req.url.includes('state%3Aopen') ? 7 : 3 } };
      if (req.url.includes('/labels')) return { json: [{ id: 9, name: 'bug', color: 'ff0000' }] };
      if (req.url.includes('/milestones')) return { json: [{ id: 77, title: 'v1', due_on: null }] };
      if (req.url.includes('/assignees')) return { json: [{ login: 'Ada' }] };
      if (/\/issues\?/.test(req.url)) return { json: [ghIssue(1)] };
      if (req.url.endsWith('/issues/12')) return { json: ghIssue(12) };
      return undefined;
    });
    const adapter = new GithubAdapter(http, TOKEN, 'acme/api');
    const d = await adapter.discover();
    expect(d).toMatchObject({ account: 'ada', sourceLabel: 'acme/api', counts: { issues: 10, open: 7, closed: 3 } });
    expect(d.labels).toEqual([{ id: '9', name: 'bug', color: '#ff0000' }]);
    expect(d.users).toEqual([{ id: 'ada', login: 'Ada', name: undefined }]);
    expect(d.milestones[0]).toMatchObject({ id: '77', projectId: 'repo:acme/api' });
    expect(d.statuses.map((s) => s.id)).toEqual(['open', 'closed', 'not_planned']);
    expect((await adapter.getIssue('acme/api#12')).key).toBe('#12');
  });

  it('uses the Enterprise API root for self-hosted hosts', () => {
    expect(githubApiBase()).toBe('https://api.github.com');
    expect(githubApiBase('https://ghe.example.com')).toBe('https://ghe.example.com/api/v3');
  });
});

describe('LinearAdapter', () => {
  const KEY = 'lin_api_secretsecretsecretsecretsecret12';
  const node = (extra: Record<string, unknown> = {}) => ({
    id: 'uuid-1',
    identifier: 'ENG-1',
    title: 'Crash',
    description: 'details',
    priority: 2,
    estimate: 5,
    url: 'https://linear.app/acme/issue/ENG-1/crash',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    startedAt: '2026-01-03T00:00:00.000Z',
    completedAt: null,
    canceledAt: null,
    state: { id: 's1', name: 'In Progress', type: 'started' },
    assignee: { id: 'u1', name: 'Ada', email: 'ADA@acme.dev' },
    creator: { id: 'u2', name: 'Carl', email: null },
    team: { id: 't1' },
    project: { id: 'p1' },
    projectMilestone: { id: 'm1', name: 'Beta', project: { id: 'p1' } },
    labels: { nodes: [{ id: 'l1', name: 'Bug', color: '#e11d48' }] },
    ...extra,
  });

  it('sends the key as the Authorization header to the Linear endpoint, with a team filter', async () => {
    const http = new FakeHttp(() => ({ json: { data: { issues: { nodes: [node()], pageInfo: { hasNextPage: true, endCursor: 'c2' } } } } }));
    const page = await new LinearAdapter(http, KEY, ['t1']).issues('c1', { includeClosed: false });
    const req = http.calls[0];
    expect(req.url).toBe(LINEAR_API);
    expect(req.method).toBe('POST');
    expect(req.headers?.Authorization).toBe(KEY);
    const body = req.body as { query: string; variables: { after: string; filter: Record<string, unknown> } };
    expect(body.query.trimStart().startsWith('query')).toBe(true);
    expect(body.query).not.toMatch(/mutation/i);
    expect(body.variables.after).toBe('c1');
    expect(body.variables.filter).toEqual({ team: { id: { in: ['t1'] } }, state: { type: { nin: ['completed', 'canceled'] } } });
    expect(page.next).toBe('c2');
    expect(page.items[0]).toMatchObject({
      id: 'uuid-1',
      key: 'ENG-1',
      priority: 'high',
      estimate: 5,
      assignee: { id: 'u1', email: 'ada@acme.dev' },
      teamId: 't1',
      projectId: 'p1',
      milestone: { id: 'm1', name: 'Beta', projectId: 'p1' },
      labels: [{ id: 'l1', name: 'Bug', color: '#e11d48' }],
      state: { id: 's1', type: 'started' },
    });
  });

  it('takes the close date from completedAt or canceledAt', async () => {
    const http = new FakeHttp(() => ({
      json: { data: { issues: { nodes: [node({ canceledAt: '2026-04-01T00:00:00.000Z' })], pageInfo: { hasNextPage: false, endCursor: null } } } },
    }));
    const page = await new LinearAdapter(http, KEY).issues(null, { includeClosed: true });
    expect(page.items[0].closedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(page.next).toBeNull();
  });

  it('maps a RATELIMITED answer to a wait until the reset time', async () => {
    const reset = Math.floor(Date.now() / 1000) + 300;
    const http = new FakeHttp(() => ({
      status: 400,
      json: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
      headers: { 'x-ratelimit-requests-reset': String(reset) },
    }));
    const err = (await new LinearAdapter(http, KEY).issues(null, { includeClosed: true }).catch((e: unknown) => e)) as ProviderHttpError;
    expect(err.rateLimited).toBe(true);
    expect(err.rateLimitedUntil?.getTime()).toBe(reset * 1000);
  });

  it('turns a rejected key into a 401 that does not echo the key', async () => {
    const http = new FakeHttp(() => ({ status: 401, json: { errors: [{ message: `Authentication required, ${KEY} is not valid` }] } }));
    const err = (await new LinearAdapter(http, KEY).whoami().catch((e: unknown) => e)) as ProviderHttpError;
    expect(err.status).toBe(401);
    expect(err.message).not.toContain(KEY);
  });

  it('reads one issue by identifier and reports a missing one as 404', async () => {
    let issue: unknown = node();
    const http = new FakeHttp(() => ({ json: { data: { issue } } }));
    const adapter = new LinearAdapter(http, KEY);
    expect((await adapter.getIssue('ENG-1')).id).toBe('uuid-1');
    expect((http.calls[0].body as { variables: { id: string } }).variables.id).toBe('ENG-1');
    issue = null;
    await expect(adapter.getIssue('ENG-9')).rejects.toMatchObject({ status: 404 });
  });

  it('drops comments without a body or an issue', async () => {
    const http = new FakeHttp(() => ({
      json: {
        data: {
          comments: {
            nodes: [
              { id: 'c1', body: 'hi', createdAt: '2026-01-01T00:00:00.000Z', user: { id: 'u1', name: 'Ada' }, issue: { id: 'uuid-1' } },
              { id: 'c2', body: '', createdAt: '2026-01-01T00:00:00.000Z', user: null, issue: { id: 'uuid-1' } },
              { id: 'c3', body: 'orphan', createdAt: '2026-01-01T00:00:00.000Z', user: null, issue: null },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }));
    const page = await new LinearAdapter(http, KEY, ['t1']).comments(null);
    expect(page.items.map((c) => c.id)).toEqual(['c1']);
    expect(page.items[0].issueId).toBe('uuid-1');
  });
});
