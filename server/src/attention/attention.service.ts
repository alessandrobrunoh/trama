import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { hasRole, type WorkspaceContext } from '../auth/request-context.js';
import type { AttentionItem } from '../contracts/domain.js';
import {
  AgentEntity,
  ArtifactEntity,
  AttentionStateEntity,
  DecisionEntity,
  DependencyEntity,
  InputRequestEntity,
  IssueEntity,
  MembershipEntity,
  TeamEntity,
  UserEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { computeAttention, itemState, sortItems, type AttentionData, type RawAttentionItem } from './attention-rules.js';

export interface AttentionOptions {
  scope?: 'mine' | 'all';
  state?: 'open' | 'snoozed' | 'dismissed' | 'active';
}

/** Event-log timestamps for "since": when the underlying condition started. */
const SINCE_SQL = `
  SELECT 'review_requested:' || (subject->>'id') AS id, max(at) AS at FROM domain_events
    WHERE "workspaceId" = $1 AND type = 'review.requested' GROUP BY 1
  UNION ALL
  SELECT 'ci_failed:' || (subject->>'id'), max(at) FROM domain_events
    WHERE "workspaceId" = $1 AND type = 'artifact.updated' AND data->'changes'->'ci'->>1 = 'failing' GROUP BY 1
  UNION ALL
  SELECT 'conflict:' || (subject->>'id'), max(at) FROM domain_events
    WHERE "workspaceId" = $1 AND type = 'artifact.updated' AND data->'changes'->'hasConflicts'->>1 = 'true' GROUP BY 1
  UNION ALL
  SELECT 'ready_to_land:' || (subject->>'id'), max(at) FROM domain_events
    WHERE "workspaceId" = $1 AND type = 'artifact.updated' AND data->'changes'->'review'->>1 = 'approved' GROUP BY 1
  UNION ALL
  SELECT 'blocked:' || (subject->>'id'), max(at) FROM domain_events
    WHERE "workspaceId" = $1 AND type = 'execution.state_changed' AND data->>'to' IN ('blocked', 'failed') GROUP BY 1
  UNION ALL
  SELECT 'ready_to_ship:' || "workstreamId", max(at) FROM domain_events
    WHERE "workspaceId" = $1 AND "workstreamId" IS NOT NULL AND (
      (type = 'criterion.updated' AND data->>'state' = 'met')
      OR (type = 'artifact.updated' AND data->'changes'->'state'->>1 = 'merged')) GROUP BY 1`;

@Injectable()
export class AttentionService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
  ) {}

  /**
   * AttentionItems for the caller (PLAN.md §3). Agents have none (human attention).
   * `scope: 'all'` (admin+) returns every item of the workspace.
   */
  async forUser(ctx: WorkspaceContext, opts: AttentionOptions = {}): Promise<AttentionItem[]> {
    if (!ctx.userId) return [];
    if (opts.scope === 'all' && !hasRole(ctx.role, 'admin'))
      throw new ForbiddenException('scope=all requires the admin role');
    const raw = await this.compute(ctx.workspace.id);
    const mine = opts.scope === 'all' ? raw : raw.filter((i) => i.audience.has(ctx.userId!));
    return this.merge(ctx, mine, opts.state);
  }

  private async merge(ctx: WorkspaceContext, raw: RawAttentionItem[], filter?: AttentionOptions['state']): Promise<AttentionItem[]> {
    const rows = await this.ds
      .getRepository(AttentionStateEntity)
      .find({ where: { userId: ctx.userId, workspaceId: ctx.workspace.id } });
    const byId = new Map(rows.map((r) => [r.itemId, r]));
    const now = new Date();
    const out = sortItems(raw).map((i): AttentionItem => {
      const s = itemState(i, byId.get(i.id), now);
      const { audience: _audience, since, ...rest } = i;
      return {
        ...rest,
        since: since.toISOString(),
        state: s.state,
        ...(s.snoozedUntil ? { snoozedUntil: s.snoozedUntil.toISOString() } : {}),
      };
    });
    if (!filter) return out;
    return out.filter((i) => (filter === 'active' ? i.state !== 'dismissed' : i.state === filter));
  }

  private async find(ctx: WorkspaceContext, id: string): Promise<AttentionItem> {
    if (!ctx.userId) throw new ForbiddenException('Attention is for people, not agents');
    let item = (await this.forUser(ctx)).find((i) => i.id === id);
    if (!item && hasRole(ctx.role, 'admin')) item = (await this.forUser(ctx, { scope: 'all' })).find((i) => i.id === id);
    if (!item) throw new NotFoundException(`Attention item "${id}" not found`);
    return item;
  }

  private notify(ctx: WorkspaceContext, item: AttentionItem): void {
    this.events.publish(ctx.workspace.id, { type: 'attention', entity: 'workstream', id: item.workstreamId ?? item.id });
  }

  async dismiss(ctx: WorkspaceContext, id: string): Promise<AttentionItem> {
    const item = await this.find(ctx, id);
    await this.ds.getRepository(AttentionStateEntity).save({
      userId: ctx.userId!,
      workspaceId: ctx.workspace.id,
      itemId: id,
      state: 'dismissed',
      snoozedUntil: null,
      since: new Date(item.since),
    });
    this.notify(ctx, item);
    return { ...item, state: 'dismissed', snoozedUntil: undefined };
  }

  async snooze(ctx: WorkspaceContext, id: string, until: string): Promise<AttentionItem> {
    const when = new Date(until);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now())
      throw new BadRequestException('`until` must be a date in the future');
    const item = await this.find(ctx, id);
    await this.ds.getRepository(AttentionStateEntity).save({
      userId: ctx.userId!,
      workspaceId: ctx.workspace.id,
      itemId: id,
      state: 'snoozed',
      snoozedUntil: when,
      since: new Date(item.since),
    });
    this.notify(ctx, item);
    return { ...item, state: 'snoozed', snoozedUntil: when.toISOString() };
  }

  async restore(ctx: WorkspaceContext, id: string): Promise<AttentionItem> {
    if (!ctx.userId) throw new ForbiddenException('Attention is for people, not agents');
    await this.ds
      .getRepository(AttentionStateEntity)
      .delete({ userId: ctx.userId, workspaceId: ctx.workspace.id, itemId: id });
    const item = await this.find(ctx, id);
    this.notify(ctx, item);
    return item;
  }

  /** Loads the workspace and derives every item (all audiences). */
  async compute(workspaceId: string): Promise<RawAttentionItem[]> {
    const where = { workspaceId };
    const db = this.ds;
    const [teams, agents, memberships, workstreams, inputRequests, artifacts, decisions, dependencies, issues, sinceRows] =
      await Promise.all([
        db.getRepository(TeamEntity).find({ where }),
        db.getRepository(AgentEntity).find({ where }),
        db.getRepository(MembershipEntity).find({ where }),
        db.getRepository(WorkstreamEntity).find({ where }),
        db.getRepository(InputRequestEntity).find({ where: { workspaceId, state: 'open' } }),
        db.getRepository(ArtifactEntity).find({ where }),
        db.getRepository(DecisionEntity).find({ where: { workspaceId, status: 'proposed' } }),
        db.getRepository(DependencyEntity).find({ where }),
        db.getRepository(IssueEntity).find({ where: { workspaceId, status: 'backlog' } }),
        db.query<{ id: string; at: Date }[]>(SINCE_SQL, [workspaceId]),
      ]);
    const userRows = await db.getRepository(UserEntity).find({ where: { id: In(memberships.map((m) => m.userId)) } });
    const names = new Map<string, string>();
    for (const u of userRows) names.set(u.id, u.name);
    for (const a of agents) names.set(a.id, a.name);
    const data: AttentionData = {
      now: new Date(),
      teams,
      names,
      adminIds: memberships.filter((m) => m.role === 'admin' || m.role === 'owner').map((m) => m.userId),
      workstreams,
      inputRequests,
      artifacts,
      decisions,
      dependencies,
      issues,
      since: new Map(sinceRows.map((r) => [r.id, new Date(r.at)])),
    };
    return computeAttention(data);
  }
}
