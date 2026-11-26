import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { uid } from '../common/util.js';
import { resolveStatusEntry, type GitProvider, type IssueKind, type IssueSource } from '../contracts/domain.js';
import { IntegrationConnectionEntity, IssueEntity } from '../database/entities/index.js';
import type { ArtifactCandidate, IssueCandidate, ItemMeta, RepoMeta } from '../integrations/candidates.js';
import { ArtifactLinkerService, SYSTEM_ACTOR } from '../integrations/artifact-linker.service.js';
import { IssuesService } from '../issues/issues.service.js';
import { loadStatusCatalog } from '../status/status-catalog.js';
import { connectionView } from './connection-access.js';
import { RoutingRuleEntity, RoutingRuleItemEntity, type RoutedItemKind } from './entities.js';
import { RoutingRulesService } from './routing-rules.service.js';

export interface IssueRouteResult {
  status: 'created' | 'updated' | 'unchanged' | 'ignored';
  /** Key of the task, when there is one. */
  key?: string;
  reason?: string;
}

export interface PullRequestRouteResult {
  /** A new task was created for the pull request. */
  placed: boolean;
  /** Key of the task the pull request belongs to through a rule. */
  key?: string;
}

const ABANDONED_CLAIM_MS = 5 * 60_000;
const BODY_MAX = 20_000;
const TITLE_MAX = 300;
const noAuthorization = () => Promise.resolve();

/** Labels people give bugs and features, to pick the kind of a new task. */
function kindFor(labels: readonly string[]): IssueKind {
  const has = (...names: string[]) => labels.some((l) => names.includes(l.toLowerCase()));
  if (has('security')) return 'security';
  if (has('bug', 'defect', 'regression')) return 'bug';
  if (has('feature', 'enhancement', 'feature request')) return 'feature';
  if (has('tech debt', 'tech-debt', 'chore', 'refactor')) return 'tech_debt';
  return 'feedback';
}

const sourceOf = (provider: GitProvider): IssueSource => (provider === 'bitbucket' ? 'api' : provider);

/**
 * Where external issues and pull requests that no task key explains go: into the project of the routing
 * rule that takes their repository. Pull requests that name a task (WEB-142) keep going to that task; a
 * rule only places the ones that do not. Everything it creates is remembered in `routing_rule_items`, so a
 * redelivered webhook never creates a second task.
 */
@Injectable()
export class InboundRoutingService {
  constructor(
    private readonly ds: DataSource,
    private readonly issues: IssuesService,
    private readonly linker: ArtifactLinkerService,
    private readonly routing: RoutingRulesService,
    @InjectRepository(RoutingRuleItemEntity) private readonly items: Repository<RoutingRuleItemEntity>,
  ) {}

  // ───────────────────────────── issues ─────────────────────────────

  /** An issue event from a webhook: creates the task through a matching rule, or follows the state of one it already created. */
  async routeIssue(conn: IntegrationConnectionEntity, repo: RepoMeta, issue: IssueCandidate): Promise<IssueRouteResult> {
    const view = connectionView(conn);
    if (!view) return { status: 'ignored', reason: 'not a git connection' };
    const host = view.host;
    const repository = repo.fullName.toLowerCase();
    const known = await this.itemOf(conn.id, view.provider, host, repository, 'issue', issue.externalId);
    if (known) return this.follow(known, issue);

    const rule = await this.routing.resolveForConnection(conn.id, view.provider, repo.fullName, { labels: issue.labels, milestone: issue.milestone });
    if (!rule) return { status: 'ignored', reason: 'no routing rule takes this issue' };
    if (issue.state === 'closed') return { status: 'ignored', reason: 'it was closed before a rule took it' };

    const itemId = await this.claim(rule, view.provider, host, repository, 'issue', issue.externalId, issue.url, 'open');
    if (!itemId) return { status: 'unchanged' };
    try {
      const task = await this.issues.create(
        rule.workspaceId,
        SYSTEM_ACTOR,
        {
          kind: kindFor(issue.labels),
          title: issue.title.trim().slice(0, TITLE_MAX) || `${repo.fullName}${issue.externalId}`,
          body: this.bodyOf(issue.body, issue.url),
          source: sourceOf(view.provider),
          reporterName: issue.author ?? null,
          projectId: rule.projectId,
          externalUrl: issue.url ?? null,
        },
        noAuthorization,
      );
      await this.items.update({ id: itemId }, { issueId: task.id });
      await this.routing.recordSuccess(rule.id);
      return { status: 'created', key: task.key };
    } catch (e) {
      await this.items.delete({ id: itemId });
      await this.routing.recordError(rule.id, `Could not create a task for ${repo.fullName}${issue.externalId}: ${(e as Error).message}`);
      throw e;
    }
  }

  /** The external issue closed or reopened: the task follows. A task closed by a person is never reopened by a stale event. */
  private async follow(item: RoutingRuleItemEntity, issue: IssueCandidate): Promise<IssueRouteResult> {
    if (!item.issueId) return { status: 'unchanged' };
    const task = await this.ds.getRepository(IssueEntity).findOneBy({ id: item.issueId, workspaceId: item.workspaceId });
    if (!task) return { status: 'ignored', reason: 'the task was deleted' };
    const catalog = (await loadStatusCatalog(this.ds, item.workspaceId)).issue;
    const type = resolveStatusEntry(catalog, task.status)?.type;
    const finished = type === 'done' || type === 'canceled';
    await this.items.update({ id: item.id }, { externalState: issue.state });
    let status: IssueRouteResult['status'] = 'unchanged';
    if (issue.state === 'closed' && !finished) {
      await this.issues.update(item.workspaceId, SYSTEM_ACTOR, task.id, { status: issue.stateReason === 'not_planned' ? 'canceled' : 'done' }, noAuthorization);
      status = 'updated';
    } else if (issue.state === 'open' && finished) {
      await this.issues.update(item.workspaceId, SYSTEM_ACTOR, task.id, { status: 'todo' }, noAuthorization);
      status = 'updated';
    }
    if (item.ruleId) await this.routing.recordSuccess(item.ruleId);
    return { status, key: task.key };
  }

  // ───────────────────────────── pull requests ─────────────────────────────

  /**
   * A pull request or merge request that names no task. A rule that takes its repository creates a task for it
   * (once) and attaches the pull request to that task; later events of the same pull request keep the artifact
   * up to date.
   */
  async routePullRequest(
    conn: IntegrationConnectionEntity,
    repo: RepoMeta,
    candidate: ArtifactCandidate,
    meta: ItemMeta = { labels: [] },
  ): Promise<PullRequestRouteResult> {
    const view = connectionView(conn);
    if (!view) return { placed: false };
    const host = view.host;
    const repository = repo.fullName.toLowerCase();
    const known = await this.itemOf(conn.id, view.provider, host, repository, 'pull_request', candidate.externalId);
    if (known?.issueId) {
      const task = await this.ds.getRepository(IssueEntity).findOneBy({ id: known.issueId, workspaceId: known.workspaceId });
      if (!task) return { placed: false };
      await this.attach(known.workspaceId, repo, candidate, task.key);
      return { placed: false, key: task.key };
    }
    if (known) return { placed: false };

    const rule = await this.routing.resolveForConnection(conn.id, view.provider, repo.fullName, meta);
    if (!rule) return { placed: false };
    const itemId = await this.claim(rule, view.provider, host, repository, 'pull_request', candidate.externalId, candidate.url, null);
    if (!itemId) return { placed: false };
    try {
      const task = await this.issues.create(
        rule.workspaceId,
        SYSTEM_ACTOR,
        {
          kind: 'feature',
          title: candidate.title.trim().slice(0, TITLE_MAX) || `${repo.fullName}${candidate.externalId}`,
          body: this.bodyOf(undefined, candidate.url, candidate.texts[1]),
          source: sourceOf(view.provider),
          projectId: rule.projectId,
          status: candidate.state === 'merged' ? 'done' : candidate.state === 'closed' ? 'canceled' : candidate.state === 'draft' ? 'in_progress' : 'in_review',
          externalUrl: candidate.url ?? null,
        },
        noAuthorization,
      );
      await this.items.update({ id: itemId }, { issueId: task.id });
      await this.attach(rule.workspaceId, repo, candidate, task.key);
      await this.routing.recordSuccess(rule.id);
      return { placed: true, key: task.key };
    } catch (e) {
      await this.items.delete({ id: itemId });
      await this.routing.recordError(rule.id, `Could not place ${repo.fullName}${candidate.externalId}: ${(e as Error).message}`);
      throw e;
    }
  }

  /** Attaches the pull request to the task the rule made for it (found by key, like any other artifact). */
  private async attach(workspaceId: string, repo: RepoMeta, candidate: ArtifactCandidate, key: string): Promise<void> {
    await this.linker.upsert(workspaceId, { id: repo.fullName }, { ...candidate, texts: [...candidate.texts, key] });
  }

  // ───────────────────────────── items ─────────────────────────────

  /**
   * The item of this external issue or pull request, when it was placed by a rule that reads through this
   * connection. A claim that never got its task (the process stopped in between) is dropped after a while.
   */
  private async itemOf(
    connectionId: string,
    provider: GitProvider,
    host: string,
    repository: string,
    kind: RoutedItemKind,
    externalId: string,
  ): Promise<RoutingRuleItemEntity | null> {
    const item = await this.lookup(connectionId, provider, host, repository, kind, externalId);
    if (item && !item.issueId && Date.now() - item.createdAt.getTime() > ABANDONED_CLAIM_MS) {
      await this.items.delete({ id: item.id });
      return null;
    }
    return item;
  }

  private lookup(
    connectionId: string,
    provider: GitProvider,
    host: string,
    repository: string,
    kind: RoutedItemKind,
    externalId: string,
  ): Promise<RoutingRuleItemEntity | null> {
    return this.items
      .createQueryBuilder('i')
      .innerJoin(RoutingRuleEntity, 'r', 'r.id = i.ruleId')
      .where('r.connectionId = :connectionId', { connectionId })
      .andWhere('i.provider = :provider AND i.host = :host AND i.repository = :repository AND i.kind = :kind AND i.externalId = :externalId', {
        provider,
        host,
        repository,
        kind,
        externalId,
      })
      .getOne();
  }

  /** Records that the rule took this item. Null when it already had (two deliveries at once, or a redelivery). */
  private async claim(
    rule: RoutingRuleEntity,
    provider: GitProvider,
    host: string,
    repository: string,
    kind: RoutedItemKind,
    externalId: string,
    url: string | undefined,
    externalState: 'open' | 'closed' | null,
  ): Promise<string | null> {
    const id = uid('ri');
    const rows: unknown[] = await this.ds.query(
      `INSERT INTO "routing_rule_items" ("id", "workspaceId", "ruleId", "provider", "host", "repository", "kind", "externalId", "url", "externalState")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT ("workspaceId", "provider", "host", "repository", "kind", "externalId") DO NOTHING RETURNING "id"`,
      [id, rule.workspaceId, rule.id, provider, host, repository, kind, externalId, url ?? null, externalState],
    );
    return rows.length ? id : null;
  }

  private bodyOf(body: string | undefined, url: string | undefined, fallback?: string): string | null {
    const text = (body ?? fallback ?? '').trim();
    const parts = [text, url ? `Source: ${url}` : ''].filter(Boolean);
    return parts.length ? parts.join('\n\n').slice(0, BODY_MAX) : null;
  }
}
