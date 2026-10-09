import { HttpClient, ProviderHttpError } from '../integrations/http-client.js';
import { mapLinearPriority, redactSecrets } from './mapping.js';
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

export const LINEAR_API = 'https://api.linear.app/graphql';
const ISSUE_PAGE = 50;
const COMMENT_PAGE = 100;
const MAX_LIST_PAGES = 20;

type Json = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const ISSUE_FIELDS = `
  id identifier title description priority estimate url createdAt updatedAt startedAt completedAt canceledAt
  state { id name type }
  assignee { id name email }
  creator { id name email }
  team { id }
  project { id }
  projectMilestone { id name description targetDate project { id } }
  labels(first: 25) { nodes { id name color } }
`;

function linearUser(raw: unknown): ExternalUser | undefined {
  const u = raw as Json | null;
  const id = str(u?.id);
  return id ? { id, name: str(u?.name), email: str(u?.email)?.toLowerCase() } : undefined;
}

/** Linear sends the reset time as epoch seconds (some deployments in milliseconds). */
function resetDate(value: string | undefined, fallbackMs: number): Date {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return new Date(Date.now() + fallbackMs);
  return new Date(n > 1e12 ? n : n * 1000);
}

/**
 * Reads a Linear workspace over GraphQL with a personal API key. Read-only: only `query` documents are sent.
 * Rate limiting is reported as ProviderHttpError.rateLimitedUntil so the runner can wait and retry the same page.
 */
export class LinearAdapter implements ImportSourceAdapter {
  readonly provider = 'linear' as const;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string,
    private readonly teamIds: readonly string[] = [],
  ) {}

  private async gql<T>(query: string, variables: Json = {}): Promise<T> {
    const res = await this.http.request({
      method: 'POST',
      url: LINEAR_API,
      headers: { Authorization: this.apiKey, 'User-Agent': 'trama-importer' },
      body: { query, variables },
    });
    const body = res.json as { data?: T; errors?: { message?: string; extensions?: { code?: string } }[] } | null;
    const limited = res.status === 429 || body?.errors?.some((e) => e.extensions?.code === 'RATELIMITED');
    if (limited) {
      const until = resetDate(res.headers['x-ratelimit-requests-reset'] ?? res.headers['x-ratelimit-complexity-reset'], 60_000);
      throw new ProviderHttpError(429, 'Rate limited by Linear', until);
    }
    if (res.status === 401 || res.status === 403) throw new ProviderHttpError(res.status, 'Linear rejected the API key');
    if (body?.errors?.length) {
      const first = body.errors[0];
      const code = first.extensions?.code;
      throw new ProviderHttpError(code === 'AUTHENTICATION_ERROR' ? 401 : res.status >= 400 ? res.status : 502, redactSecrets(`Linear: ${first.message ?? 'GraphQL error'}`, [this.apiKey]));
    }
    if (res.status >= 400 || !body?.data) throw new ProviderHttpError(res.status >= 400 ? res.status : 502, `Linear answered ${res.status}`);
    return body.data;
  }

  private async list<T>(field: string, nodeFields: string, extraArgs = '', maxPages = MAX_LIST_PAGES): Promise<T[]> {
    const out: T[] = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page++) {
      const data: Record<string, Connection<T>> = await this.gql(
        `query($after:String){ ${field}(first:250, after:$after${extraArgs ? `, ${extraArgs}` : ''}){ nodes{ ${nodeFields} } pageInfo{ hasNextPage endCursor } } }`,
        { after },
      );
      const conn = data[field];
      out.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  private teamFilter(): Json | undefined {
    return this.teamIds.length ? { team: { id: { in: [...this.teamIds] } } } : undefined;
  }

  async discover(): Promise<Discovery> {
    const warnings: string[] = [];
    const me = await this.gql<{ viewer: Json; organization: Json }>(
      `{ viewer { id name email } organization { name urlKey } }`,
    );
    const allTeams = await this.list<Json>('teams', 'id key name');
    const wanted = new Set(this.teamIds);
    const teams: DiscoveredEntity[] = allTeams
      .filter((t) => !wanted.size || wanted.has(String(t.id)))
      .map((t) => ({ id: String(t.id), key: str(t.key), name: String(t.name) }));
    const inScope = new Set(teams.map((t) => t.id));

    // Counts and per-team numbers are a convenience: a schema or complexity problem must not stop the preview.
    let sum = 0;
    let known = true;
    for (const t of teams) {
      try {
        const data = await this.gql<{ team: { issueCount?: number } }>(`query($id:String!){ team(id:$id){ issueCount } }`, { id: t.id });
        if (typeof data.team.issueCount === 'number') {
          t.count = data.team.issueCount;
          sum += data.team.issueCount;
        } else known = false;
      } catch (e) {
        if (e instanceof ProviderHttpError && (e.rateLimited || e.status === 401)) throw e;
        known = false;
      }
    }
    const total = known ? sum : null;
    if (!known) warnings.push('Issue counts are unavailable for this workspace.');

    const states = (await this.list<Json>('workflowStates', 'id name type team { id key }')).filter((s) =>
      inScope.has(String((s.team as Json | null)?.id)),
    );
    const teamKey = new Map(teams.map((t) => [t.id, t.key ?? t.name]));
    const labels = (await this.list<Json>('issueLabels', 'id name color team { id }'))
      .filter((l) => !(l.team as Json | null)?.id || inScope.has(String((l.team as Json).id)))
      .map((l) => ({ id: String(l.id), name: String(l.name), color: str(l.color) }));
    const projects = (await this.list<Json>('projects', 'id name color teams { nodes { id } }'))
      .filter((p) => (((p.teams as Json | undefined)?.nodes as Json[] | undefined) ?? []).some((t) => inScope.has(String(t.id))))
      .map((p) => ({ id: String(p.id), name: String(p.name), color: str(p.color) }));
    const projectIds = new Set(projects.map((p) => p.id));
    let milestones: ExternalMilestone[] = [];
    try {
      milestones = (await this.list<Json>('projectMilestones', 'id name description targetDate project { id }'))
        .filter((m) => projectIds.has(String((m.project as Json | null)?.id)))
        .map((m) => ({
          id: String(m.id),
          name: String(m.name),
          projectId: String((m.project as Json).id),
          description: str(m.description),
          dueOn: str(m.targetDate),
        }));
    } catch (e) {
      if (e instanceof ProviderHttpError && e.rateLimited) throw e;
      warnings.push('Project milestones could not be read; they are skipped.');
    }
    const users = (await this.list<Json>('users', 'id name email active'))
      .filter((u) => u.active !== false)
      .map((u) => linearUser(u))
      .filter((u): u is ExternalUser => !!u);

    const first = await this.issues(null, { includeClosed: true });
    return {
      provider: 'linear',
      account: str(me.viewer.name) ?? str(me.viewer.email) ?? 'linear',
      sourceLabel: `${str(me.organization.name) ?? 'Linear'}: ${teams.map((t) => t.key ?? t.name).join(', ') || 'no team'}`,
      sourceUrl: str(me.organization.urlKey) ? `https://linear.app/${str(me.organization.urlKey)}` : undefined,
      counts: { issues: total, open: null, closed: null },
      teams,
      projects,
      labels,
      milestones,
      users,
      statuses: states.map((s) => ({
        id: String(s.id),
        name: teams.length > 1 ? `${teamKey.get(String((s.team as Json).id))} · ${String(s.name)}` : String(s.name),
        type: String(s.type),
      })),
      sample: first.items.slice(0, 5).map((i) => ({ key: i.key, title: i.title, state: i.state.name })),
      warnings,
    };
  }

  private toIssue(raw: Json): ExternalIssue {
    const state = raw.state as Json;
    const m = raw.projectMilestone as Json | null;
    const labelNodes = ((raw.labels as Json | undefined)?.nodes as Json[] | undefined) ?? [];
    const estimate = raw.estimate;
    return {
      id: String(raw.id),
      key: String(raw.identifier),
      url: String(raw.url),
      title: str(raw.title) ?? '',
      body: str(raw.description) ?? null,
      state: { id: String(state.id), name: String(state.name), type: String(state.type) },
      priority: mapLinearPriority(typeof raw.priority === 'number' ? raw.priority : 0),
      estimate: typeof estimate === 'number' ? estimate : undefined,
      labels: labelNodes.map((l) => ({ id: String(l.id), name: String(l.name), color: str(l.color) })),
      assignee: linearUser(raw.assignee),
      creator: linearUser(raw.creator),
      teamId: str((raw.team as Json | null)?.id),
      projectId: str((raw.project as Json | null)?.id),
      milestone: m
        ? {
            id: String(m.id),
            name: String(m.name),
            projectId: str((m.project as Json | null)?.id),
            description: str(m.description),
            dueOn: str(m.targetDate),
          }
        : undefined,
      createdAt: String(raw.createdAt),
      updatedAt: String(raw.updatedAt ?? raw.createdAt),
      startedAt: str(raw.startedAt),
      closedAt: str(raw.completedAt) ?? str(raw.canceledAt),
    };
  }

  async issues(cursor: string | null, opts: { includeClosed: boolean }): Promise<Page<ExternalIssue>> {
    const filter: Json = { ...this.teamFilter() };
    if (!opts.includeClosed) filter.state = { type: { nin: ['completed', 'canceled'] } };
    const data = await this.gql<{ issues: Connection<Json> }>(
      `query($first:Int!,$after:String,$filter:IssueFilter){ issues(first:$first, after:$after, filter:$filter, orderBy:createdAt){ nodes{ ${ISSUE_FIELDS} } pageInfo{ hasNextPage endCursor } } }`,
      { first: ISSUE_PAGE, after: cursor, filter },
    );
    return {
      items: data.issues.nodes.map((n) => this.toIssue(n)),
      next: data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null,
    };
  }

  async comments(cursor: string | null): Promise<Page<ExternalComment>> {
    const team = this.teamFilter();
    const data = await this.gql<{ comments: Connection<Json> }>(
      `query($first:Int!,$after:String,$filter:CommentFilter){ comments(first:$first, after:$after, filter:$filter){ nodes{ id body createdAt user { id name email } issue { id } } pageInfo{ hasNextPage endCursor } } }`,
      { first: COMMENT_PAGE, after: cursor, filter: team ? { issue: team } : {} },
    );
    const items: ExternalComment[] = [];
    for (const c of data.comments.nodes) {
      const issueId = str((c.issue as Json | null)?.id);
      if (!issueId || !str(c.body)) continue;
      items.push({ id: String(c.id), issueId, author: linearUser(c.user), body: String(c.body), createdAt: String(c.createdAt) });
    }
    return { items, next: data.comments.pageInfo.hasNextPage ? data.comments.pageInfo.endCursor : null };
  }

  /** `id`: the issue uuid or its identifier (`ENG-123`). */
  async getIssue(id: string): Promise<ExternalIssue> {
    const data = await this.gql<{ issue: Json | null }>(`query($id:String!){ issue(id:$id){ ${ISSUE_FIELDS} } }`, { id });
    if (!data.issue) throw new ProviderHttpError(404, `Linear issue ${id} not found`);
    return this.toIssue(data.issue);
  }

  /** Validates the key and names the account (used when a credential is saved). */
  async whoami(): Promise<{ account: string }> {
    const data = await this.gql<{ viewer: Json }>(`{ viewer { id name email } }`);
    return { account: str(data.viewer.name) ?? str(data.viewer.email) ?? 'linear' };
  }
}
