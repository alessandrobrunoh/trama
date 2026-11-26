import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, type Repository } from 'typeorm';
import { projectHidden } from '../auth/member-access.js';
import { notFound, uid } from '../common/util.js';
import {
  GIT_PROVIDER_META,
  ROUTING_PROVIDER_SUPPORT,
  routingSourceKind,
  type ActorRef,
  type GitProvider,
  type MemberAccess,
  type RoutingConnectionOption,
  type RoutingDirection,
  type RoutingFilters,
  type RoutingRule,
  type RoutingRuleConnection,
  type RoutingRuleStats,
  type RoutingRulesOverview,
  type RoutingSourceSuggestion,
  type RoutingSuggestions,
  type UsableConnection,
} from '../contracts/domain.js';
import { IntegrationConnectionEntity, ProjectEntity, UserEntity } from '../database/entities/index.js';
import { ConnectionsService } from '../integrations/connections.service.js';
import { HttpClient, ProviderHttpError } from '../integrations/http-client.js';
import { createGitClient, type GitProviderClient } from '../integrations/providers.js';
import { SecretsService } from '../integrations/secrets.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import {
  connectionHealthy,
  connectionLabel,
  connectionView,
  type ConnectionCaller,
  type RoutingConnection,
} from './connection-access.js';
import { RoutingRuleEntity } from './entities.js';
import {
  SourceInputError,
  filterKey,
  filtersMatch,
  filtersOverlap,
  normalizeFilters,
  normalizeSourcePath,
  parseSourceInput,
  sourceIncludes,
  sourcesOverlap,
  specificity,
  type ItemAttributes,
} from './source-path.js';

export interface RoutingCaller extends ConnectionCaller {
  actor: ActorRef;
  access: MemberAccess | null;
  /** The caller may create tasks in this workspace and its access is not narrowed against it. */
  canWrite: boolean;
}

export interface CreateRuleInput {
  provider: GitProvider;
  sourcePath: string;
  connectionId: string;
  filters?: RoutingFilters;
  direction?: RoutingDirection;
}

export interface UpdateRuleInput {
  connectionId?: string;
  filters?: RoutingFilters;
  direction?: RoutingDirection;
}

const DAY_MS = 24 * 3600_000;
const SUGGESTION_PAGES = 2;
const SUGGESTION_PAGE_SIZE = 100;
const SUGGESTION_LIMIT = 20;

/** The path without its `/*`, as people say it in a sentence. */
const sayPath = (sourcePath: string): string => (routingSourceKind(sourcePath) === 'group' ? sourcePath.slice(0, -2) : sourcePath);

@Injectable()
export class RoutingRulesService {
  constructor(
    private readonly ds: DataSource,
    private readonly secrets: SecretsService,
    private readonly http: HttpClient,
    private readonly projects: ProjectsService,
    private readonly connectionsService: ConnectionsService,
    @InjectRepository(RoutingRuleEntity) private readonly rules: Repository<RoutingRuleEntity>,
    @InjectRepository(IntegrationConnectionEntity) private readonly connections: Repository<IntegrationConnectionEntity>,
  ) {}

  // ───────────────────────────── permissions ─────────────────────────────

  /** Project writers: whoever may create tasks, in a project they can see. Guests only when their role allows it. */
  private assertWriter(caller: RoutingCaller): void {
    if (!caller.canWrite) throw new ForbiddenException('You are not allowed to add sources to this project');
  }

  private async project(caller: RoutingCaller, projectId: string): Promise<ProjectEntity> {
    return this.projects.get(caller.workspaceId, projectId);
  }

  private async ruleOf(caller: RoutingCaller, projectId: string, ruleId: string): Promise<RoutingRuleEntity> {
    const rule = await this.rules.findOneBy({ id: ruleId, projectId, workspaceId: caller.workspaceId });
    if (!rule) throw notFound('Routing rule', ruleId);
    return rule;
  }

  // ───────────────────────────── connections ─────────────────────────────

  /** What the caller may pick, from the connections code: their personal ones, and the workspace's when their role has the integrations permission. Empty for an agent token. */
  private usable(caller: ConnectionCaller): Promise<UsableConnection[]> {
    return caller.userId ? this.connectionsService.usableFor(caller.userId, caller.workspaceId) : Promise.resolve([]);
  }

  /** A connection the caller may read through. 404 for one they cannot pick, so ids do not leak. */
  private async usableConnection(caller: RoutingCaller, connectionId: string): Promise<{ row: IntegrationConnectionEntity; view: RoutingConnection }> {
    const allowed = (await this.usable(caller)).some((c) => c.id === connectionId);
    const row = allowed ? await this.connections.findOneBy({ id: connectionId }) : null;
    const view = row ? connectionView(row) : null;
    if (!row || !view) throw notFound('Connection', connectionId);
    return { row, view };
  }

  async clientFor(row: IntegrationConnectionEntity): Promise<GitProviderClient> {
    const view = connectionView(row);
    if (!view) throw new BadRequestException('This connection has no repository API');
    const token = this.secrets.decrypt(row.secret ?? '', `${row.id}:secret`);
    return createGitClient(view.provider, this.http, token, view.baseUrl);
  }

  /** Connections the caller may use for a rule, with the one to preselect. */
  async connectionOptions(caller: RoutingCaller, projectId: string, provider?: GitProvider): Promise<RoutingConnectionOption[]> {
    await this.project(caller, projectId);
    const options: RoutingConnectionOption[] = [];
    for (const c of await this.usable(caller)) {
      if (c.provider === 'delta' || (provider && c.provider !== provider)) continue;
      options.push({
        id: c.id,
        provider: c.provider,
        label: c.label,
        ownerType: c.ownerType,
        ...(c.ownerName ? { ownerName: c.ownerName } : {}),
        ...(c.ownerType === 'user' && c.ownerUserId === caller.userId ? { mine: true } : {}),
        account: c.account,
        suggested: c.suggested,
        healthy: c.status === 'connected',
      });
    }
    return options;
  }

  private async ownerNames(views: readonly RoutingConnection[]): Promise<Map<string, string>> {
    const ids = [...new Set(views.flatMap((v) => (v.ownerType === 'user' && v.ownerUserId ? [v.ownerUserId] : [])))];
    if (!ids.length) return new Map();
    const users = await this.ds.getRepository(UserEntity).find({ where: { id: In(ids) }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private connectionSummary(v: RoutingConnection, caller: ConnectionCaller, owners: ReadonlyMap<string, string>): RoutingRuleConnection {
    const ownerName = v.ownerType === 'user' && v.ownerUserId ? owners.get(v.ownerUserId) : undefined;
    return {
      id: v.id,
      provider: v.provider,
      label: connectionLabel(v),
      ownerType: v.ownerType,
      ...(ownerName ? { ownerName } : {}),
      ...(v.ownerType === 'user' && caller.userId && v.ownerUserId === caller.userId ? { mine: true } : {}),
    };
  }

  // ───────────────────────────── reading ─────────────────────────────

  async overview(caller: RoutingCaller, projectId: string): Promise<RoutingRulesOverview> {
    await this.project(caller, projectId);
    const rows = await this.rules.find({ where: { workspaceId: caller.workspaceId, projectId }, order: { createdAt: 'ASC', id: 'ASC' } });
    const rules = await this.presentMany(caller, rows);
    const ids = rows.map((r) => r.id);
    const recent = ids.length
      ? ((await this.ds.query(
          `SELECT count(*)::int AS "arrived", (count(*) FILTER (WHERE "kind" = 'pull_request'))::int AS "prs"
           FROM "routing_rule_items" WHERE "ruleId" = ANY($1) AND "createdAt" > $2`,
          [ids, new Date(Date.now() - 7 * DAY_MS)],
        )) as { arrived: number; prs: number }[])[0]
      : undefined;
    const stats: RoutingRuleStats = {
      tasksArrived: recent?.arrived ?? 0,
      unmatchedPlaced: recent?.prs ?? 0,
      rulesFailing: rules.filter((r) => r.health === 'error').length,
    };
    return { rules, stats, canManage: caller.canWrite };
  }

  private async presentMany(caller: ConnectionCaller, rows: readonly RoutingRuleEntity[]): Promise<RoutingRule[]> {
    if (!rows.length) return [];
    const connectionIds = [...new Set(rows.flatMap((r) => (r.connectionId ? [r.connectionId] : [])))];
    const connRows = connectionIds.length ? await this.connections.findBy({ id: In(connectionIds) }) : [];
    const views = new Map(connRows.flatMap((row) => {
      const v = connectionView(row);
      return v ? [[v.id, v] as const] : [];
    }));
    const owners = await this.ownerNames([...views.values()]);
    const counts = new Map(
      ((await this.ds.query(
        `SELECT "ruleId", count(*)::int AS "n" FROM "routing_rule_items" WHERE "ruleId" = ANY($1) GROUP BY "ruleId"`,
        [rows.map((r) => r.id)],
      )) as { ruleId: string; n: number }[]).map((c) => [c.ruleId, c.n]),
    );
    return rows.map((rule) => {
      const conn = rule.connectionId ? views.get(rule.connectionId) : undefined;
      const summary = conn ? this.connectionSummary(conn, caller, owners) : undefined;
      const { health, reason } = this.healthOf(rule, conn, summary);
      return {
        id: rule.id,
        workspaceId: rule.workspaceId,
        projectId: rule.projectId,
        ...(rule.connectionId ? { connectionId: rule.connectionId } : {}),
        provider: rule.provider,
        host: rule.host,
        sourcePath: rule.sourcePath,
        filters: rule.filters ?? {},
        direction: rule.direction,
        ...(summary ? { connection: summary } : {}),
        health,
        ...(reason ? { healthReason: reason } : {}),
        ...(rule.lastSyncAt ? { lastSyncAt: rule.lastSyncAt.toISOString() } : {}),
        ...(rule.lastError ? { lastError: rule.lastError } : {}),
        taskCount: counts.get(rule.id) ?? 0,
        ...(rule.migratedFrom ? { migratedFrom: rule.migratedFrom } : {}),
        createdBy: rule.createdBy,
        createdAt: rule.createdAt.toISOString(),
        updatedAt: rule.updatedAt.toISOString(),
      };
    });
  }

  /** A rule whose connection is missing, revoked or failing is in error, with the reason people need to fix it. */
  private healthOf(
    rule: RoutingRuleEntity,
    conn: RoutingConnection | undefined,
    summary: RoutingRuleConnection | undefined,
  ): { health: 'ok' | 'error'; reason?: string } {
    const source = sayPath(rule.sourcePath);
    if (!rule.connectionId || !conn)
      return { health: 'error', reason: `The connection this source read through was removed. New issues from ${source} aren't arriving.` };
    if (!connectionHealthy(conn)) {
      const who = conn.ownerType === 'user' ? `${summary?.ownerName ?? 'The owner'}'s connection` : `The connection ${connectionLabel(conn)}`;
      if (conn.status === 'revoked') return { health: 'error', reason: `${who} was revoked. New issues from ${source} aren't arriving.` };
      return {
        health: 'error',
        reason: `${who} is failing${conn.lastError ? ` (${conn.lastError})` : ''}. New issues from ${source} may not arrive.`,
      };
    }
    if (rule.lastError) return { health: 'error', reason: rule.lastError };
    return { health: 'ok' };
  }

  // ───────────────────────────── writing ─────────────────────────────

  async create(caller: RoutingCaller, projectId: string, input: CreateRuleInput): Promise<RoutingRule> {
    this.assertWriter(caller);
    await this.project(caller, projectId);
    const { view } = await this.usableConnection(caller, input.connectionId);
    if (view.provider !== input.provider)
      throw new BadRequestException(`${connectionLabel(view)} is a ${GIT_PROVIDER_META[view.provider].label} connection`);
    const host = view.host;
    const parsed = this.parseSource(input.provider, input.sourcePath, host);
    const filters = this.filtersOf(input.filters);
    const direction = this.directionFor(input.provider, input.direction ?? 'inbound');
    const row = await this.ds.transaction(async (m) => {
      // Serialise rule changes of a workspace, so two requests cannot both pass the overlap check.
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`routing:${caller.workspaceId}`]);
      await this.assertNoOverlap(m.getRepository(RoutingRuleEntity), caller, {
        provider: input.provider,
        host,
        sourcePath: parsed,
        filters,
      });
      return m.getRepository(RoutingRuleEntity).save(
        m.getRepository(RoutingRuleEntity).create({
          id: uid('rr'),
          workspaceId: caller.workspaceId,
          projectId,
          connectionId: view.id,
          provider: input.provider,
          host,
          sourcePath: parsed,
          filters,
          filterKey: filterKey(filters),
          direction,
          createdBy: caller.actor,
          migratedFrom: null,
          lastSyncAt: null,
          lastError: null,
        }),
      );
    });
    return (await this.presentMany(caller, [row]))[0];
  }

  async update(caller: RoutingCaller, projectId: string, ruleId: string, patch: UpdateRuleInput): Promise<RoutingRule> {
    this.assertWriter(caller);
    await this.project(caller, projectId);
    const row = await this.ds.transaction(async (m) => {
      await m.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`routing:${caller.workspaceId}`]);
      const repo = m.getRepository(RoutingRuleEntity);
      const rule = await repo.findOneBy({ id: ruleId, projectId, workspaceId: caller.workspaceId });
      if (!rule) throw notFound('Routing rule', ruleId);
      if (patch.connectionId !== undefined) {
        const { view } = await this.usableConnection(caller, patch.connectionId);
        if (view.provider !== rule.provider)
          throw new BadRequestException(`A ${GIT_PROVIDER_META[rule.provider].label} source needs a ${GIT_PROVIDER_META[rule.provider].label} connection`);
        if (view.host !== rule.host)
          throw new BadRequestException(`${connectionLabel(view)} does not reach ${rule.host}`);
        rule.connectionId = view.id;
        rule.lastError = null;
      }
      if (patch.filters !== undefined) {
        rule.filters = this.filtersOf(patch.filters);
        rule.filterKey = filterKey(rule.filters);
      }
      if (patch.direction !== undefined) rule.direction = this.directionFor(rule.provider, patch.direction);
      if (patch.filters !== undefined)
        await this.assertNoOverlap(repo, caller, rule, rule.id);
      rule.updatedAt = new Date();
      return repo.save(rule);
    });
    return (await this.presentMany(caller, [row]))[0];
  }

  async remove(caller: RoutingCaller, projectId: string, ruleId: string): Promise<void> {
    this.assertWriter(caller);
    await this.project(caller, projectId);
    const rule = await this.ruleOf(caller, projectId, ruleId);
    await this.rules.delete({ id: rule.id });
  }

  // ───────────────────────────── validation ─────────────────────────────

  /** Reads what the person typed (a path or a URL) and checks it against the host the connection reaches. */
  private parseSource(provider: GitProvider, raw: string, connectionHost: string): string {
    try {
      const input = parseSourceInput(raw);
      if (input.host && input.host !== connectionHost && input.host !== `www.${connectionHost}`)
        throw new SourceInputError(`That address is on ${input.host}, but this connection reaches ${connectionHost}`);
      return normalizeSourcePath(provider, input.path);
    } catch (e) {
      if (e instanceof SourceInputError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private filtersOf(raw: RoutingFilters | undefined): RoutingFilters {
    try {
      return normalizeFilters(raw);
    } catch (e) {
      if (e instanceof SourceInputError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  private directionFor(provider: GitProvider, direction: RoutingDirection): RoutingDirection {
    const support = ROUTING_PROVIDER_SUPPORT[provider];
    if (direction === 'two_way' && !support.twoWay)
      throw new BadRequestException(`${GIT_PROVIDER_META[provider].label} sources can only be inbound for now`);
    return direction;
  }

  /**
   * One source, one destination: refuses a rule whose source can reach an item that another rule of the
   * workspace already takes (the same repository, a repository inside a group, nested groups) unless their
   * filters keep them apart.
   */
  private async assertNoOverlap(
    repo: Repository<RoutingRuleEntity>,
    caller: RoutingCaller,
    candidate: Pick<RoutingRuleEntity, 'provider' | 'host' | 'sourcePath' | 'filters'>,
    exceptId?: string,
  ): Promise<void> {
    const siblings = (await repo.find({ where: { workspaceId: caller.workspaceId, provider: candidate.provider } })).filter(
      (r) => r.id !== exceptId && r.host.toLowerCase() === candidate.host.toLowerCase(),
    );
    const clash = siblings.find((r) => sourcesOverlap(r.sourcePath, candidate.sourcePath) && filtersOverlap(r.filters ?? {}, candidate.filters ?? {}));
    if (!clash) return;
    const project = await this.ds.getRepository(ProjectEntity).findOneBy({ id: clash.projectId, workspaceId: caller.workspaceId });
    const where = !project || projectHidden(caller.access, project.id) ? 'another project' : `the project "${project.name}"`;
    const sameSource = clash.sourcePath.toLowerCase() === candidate.sourcePath.toLowerCase();
    const how = sameSource
      ? `${candidate.sourcePath} already goes to ${where}`
      : `${candidate.sourcePath} overlaps ${clash.sourcePath}, which already goes to ${where}`;
    throw new ConflictException(
      `${how}. One source, one project: remove that source first, or give the rules filters that cannot match the same item (different milestones).`,
    );
  }

  // ───────────────────────────── suggestions ─────────────────────────────

  /**
   * Repositories the chosen connection can reach, marked with where they already go. The provider is
   * asked for a couple of pages only and the list is narrowed to what was typed.
   */
  async suggestions(
    caller: RoutingCaller,
    projectId: string,
    query: { provider: GitProvider; connectionId?: string; q?: string },
  ): Promise<RoutingSuggestions> {
    this.assertWriter(caller);
    await this.project(caller, projectId);
    const rows: IntegrationConnectionEntity[] = [];
    if (query.connectionId) rows.push((await this.usableConnection(caller, query.connectionId)).row);
    else {
      const ids = (await this.usable(caller)).filter((c) => c.provider === query.provider && c.status === 'connected').map((c) => c.id);
      if (ids.length) rows.push(...(await this.connections.findBy({ id: In(ids) })));
    }
    const needle = (query.q ?? '').trim().toLowerCase();
    const found = new Map<string, { sourcePath: string; url?: string; private?: boolean; host: string }>();
    let error: string | undefined;
    for (const row of rows) {
      const view = connectionView(row)!;
      if (view.provider !== query.provider) continue;
      const host = view.host;
      try {
        const client = await this.clientFor(row);
        for (let page = 1; page <= SUGGESTION_PAGES; page++) {
          const res = await client.listRepositories(page, SUGGESTION_PAGE_SIZE);
          for (const repo of res.items)
            if (!found.has(`${host}|${repo.fullName.toLowerCase()}`) && (!needle || repo.fullName.toLowerCase().includes(needle)))
              found.set(`${host}|${repo.fullName.toLowerCase()}`, { sourcePath: repo.fullName, url: repo.url, private: repo.private, host });
          if (!res.hasMore) break;
        }
      } catch (e) {
        error = e instanceof ProviderHttpError ? `${GIT_PROVIDER_META[view.provider].label} refused the connection (${e.message})` : 'The source could not be listed right now';
      }
    }
    const existing = await this.rules.find({ where: { workspaceId: caller.workspaceId, provider: query.provider } });
    const names = new Map(
      (await this.ds.getRepository(ProjectEntity).find({ where: { workspaceId: caller.workspaceId }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
    );
    const mark = (sourcePath: string, host: string): Pick<RoutingSourceSuggestion, 'status' | 'projectId' | 'projectName'> => {
      const hit = existing
        .filter((r) => r.host.toLowerCase() === host && sourcesOverlap(r.sourcePath, sourcePath))
        .sort((a, b) => specificity(b) - specificity(a))[0];
      if (!hit) return { status: 'available' };
      if (hit.projectId === projectId) return { status: 'this_project', projectId };
      const hidden = projectHidden(caller.access, hit.projectId);
      return { status: 'other_project', projectId: hit.projectId, ...(hidden ? {} : { projectName: names.get(hit.projectId) }) };
    };
    const items: RoutingSourceSuggestion[] = [...found.values()].slice(0, 200).map((r) => ({
      sourcePath: r.sourcePath,
      ...(r.url ? { url: r.url } : {}),
      ...(r.private !== undefined ? { private: r.private } : {}),
      ...mark(r.sourcePath, r.host),
    }));
    // Whole owners / groups of what was found, when the person is typing an owner.
    const groups = new Map<string, string>();
    for (const r of found.values()) {
      const owner = r.sourcePath.slice(0, r.sourcePath.lastIndexOf('/'));
      if (owner && (!needle || `${owner}/`.toLowerCase().includes(needle))) groups.set(`${r.host}|${owner.toLowerCase()}`, `${owner}/*`);
    }
    for (const [key, sourcePath] of groups)
      items.push({ sourcePath, ...mark(sourcePath, key.slice(0, key.indexOf('|'))) });
    // Free ones first, then the ones that go somewhere already.
    const rank = { available: 0, this_project: 1, other_project: 2 } as const;
    items.sort((a, b) => rank[a.status] - rank[b.status]);
    return { items: items.slice(0, SUGGESTION_LIMIT), ...(error ? { error } : {}) };
  }

  // ───────────────────────────── routing (used by ingestion) ─────────────────────────────

  /**
   * The rule that takes an item arriving through this connection: a rule whose source contains the repository
   * and whose filters match. A repository beats a group, more filters beat fewer.
   */
  async resolveForConnection(
    connectionId: string,
    provider: GitProvider,
    repository: string,
    item: ItemAttributes,
  ): Promise<RoutingRuleEntity | null> {
    const candidates = await this.rules.find({ where: { connectionId, provider } });
    const hits = candidates
      .filter((r) => sourceIncludes(r.sourcePath, repository) && filtersMatch(r.filters ?? {}, item))
      .sort((a, b) => specificity(b) - specificity(a) || a.createdAt.getTime() - b.createdAt.getTime());
    return hits[0] ?? null;
  }

  /** The project a whole repository goes to (importers): the most specific rule of the workspace with no filters. */
  async projectForRepository(workspaceId: string, provider: GitProvider, host: string, repository: string): Promise<string | null> {
    const candidates = await this.rules.find({ where: { workspaceId, provider } });
    const hits = candidates
      .filter((r) => r.host.toLowerCase() === host.toLowerCase() && !r.filterKey && sourceIncludes(r.sourcePath, repository))
      .sort((a, b) => specificity(b) - specificity(a));
    return hits[0]?.projectId ?? null;
  }

  /** GitHub sources (on github.com, without filters) and the project each goes to: what an import suggests as a project mapping. */
  async routedRepositories(workspaceId: string): Promise<{ sourcePath: string; projectId: string }[]> {
    const rows = await this.rules.find({ where: { workspaceId, provider: 'github', host: 'github.com' } });
    return rows.filter((r) => !r.filterKey).map((r) => ({ sourcePath: r.sourcePath, projectId: r.projectId }));
  }

  async recordSuccess(ruleId: string): Promise<void> {
    await this.rules.update({ id: ruleId }, { lastSyncAt: new Date(), lastError: null });
  }

  async recordError(ruleId: string, message: string): Promise<void> {
    await this.rules.update({ id: ruleId }, { lastError: message.slice(0, 500) });
  }
}
