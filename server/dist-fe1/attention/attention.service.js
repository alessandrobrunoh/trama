var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { hasRole } from '../auth/request-context.js';
import { AgentEntity, ArtifactEntity, AttentionStateEntity, DecisionEntity, DependencyEntity, ExecutionEntity, InputRequestEntity, IntakeItemEntity, MembershipEntity, TeamEntity, UserEntity, WorkstreamEntity, } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { computeAttention, itemState, sortItems } from './attention-rules.js';
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
let AttentionService = class AttentionService {
    ds;
    events;
    constructor(ds, events) {
        this.ds = ds;
        this.events = events;
    }
    async forUser(ctx, opts = {}) {
        if (!ctx.userId)
            return [];
        if (opts.scope === 'all' && !hasRole(ctx.role, 'admin'))
            throw new ForbiddenException('scope=all requires the admin role');
        const raw = await this.compute(ctx.workspace.id);
        const mine = opts.scope === 'all' ? raw : raw.filter((i) => i.audience.has(ctx.userId));
        return this.merge(ctx, mine, opts.state);
    }
    async merge(ctx, raw, filter) {
        const rows = await this.ds
            .getRepository(AttentionStateEntity)
            .find({ where: { userId: ctx.userId, workspaceId: ctx.workspace.id } });
        const byId = new Map(rows.map((r) => [r.itemId, r]));
        const now = new Date();
        const out = sortItems(raw).map((i) => {
            const s = itemState(i, byId.get(i.id), now);
            const { audience: _audience, since, ...rest } = i;
            return {
                ...rest,
                since: since.toISOString(),
                state: s.state,
                ...(s.snoozedUntil ? { snoozedUntil: s.snoozedUntil.toISOString() } : {}),
            };
        });
        if (!filter)
            return out;
        return out.filter((i) => (filter === 'active' ? i.state !== 'dismissed' : i.state === filter));
    }
    async find(ctx, id) {
        if (!ctx.userId)
            throw new ForbiddenException('Attention is for people, not agents');
        let item = (await this.forUser(ctx)).find((i) => i.id === id);
        if (!item && hasRole(ctx.role, 'admin'))
            item = (await this.forUser(ctx, { scope: 'all' })).find((i) => i.id === id);
        if (!item)
            throw new NotFoundException(`Attention item "${id}" not found`);
        return item;
    }
    notify(ctx, item) {
        this.events.publish(ctx.workspace.id, { type: 'attention', entity: 'workstream', id: item.workstreamId ?? item.id });
    }
    async dismiss(ctx, id) {
        const item = await this.find(ctx, id);
        await this.ds.getRepository(AttentionStateEntity).save({
            userId: ctx.userId,
            workspaceId: ctx.workspace.id,
            itemId: id,
            state: 'dismissed',
            snoozedUntil: null,
            since: new Date(item.since),
        });
        this.notify(ctx, item);
        return { ...item, state: 'dismissed', snoozedUntil: undefined };
    }
    async snooze(ctx, id, until) {
        const when = new Date(until);
        if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now())
            throw new BadRequestException('`until` must be a date in the future');
        const item = await this.find(ctx, id);
        await this.ds.getRepository(AttentionStateEntity).save({
            userId: ctx.userId,
            workspaceId: ctx.workspace.id,
            itemId: id,
            state: 'snoozed',
            snoozedUntil: when,
            since: new Date(item.since),
        });
        this.notify(ctx, item);
        return { ...item, state: 'snoozed', snoozedUntil: when.toISOString() };
    }
    async restore(ctx, id) {
        if (!ctx.userId)
            throw new ForbiddenException('Attention is for people, not agents');
        await this.ds
            .getRepository(AttentionStateEntity)
            .delete({ userId: ctx.userId, workspaceId: ctx.workspace.id, itemId: id });
        const item = await this.find(ctx, id);
        this.notify(ctx, item);
        return item;
    }
    async compute(workspaceId) {
        const where = { workspaceId };
        const db = this.ds;
        const [teams, agents, memberships, workstreams, executions, inputRequests, artifacts, decisions, dependencies, intake, sinceRows] = await Promise.all([
            db.getRepository(TeamEntity).find({ where }),
            db.getRepository(AgentEntity).find({ where }),
            db.getRepository(MembershipEntity).find({ where }),
            db.getRepository(WorkstreamEntity).find({ where }),
            db.getRepository(ExecutionEntity).find({ where }),
            db.getRepository(InputRequestEntity).find({ where: { workspaceId, state: 'open' } }),
            db.getRepository(ArtifactEntity).find({ where }),
            db.getRepository(DecisionEntity).find({ where: { workspaceId, status: 'proposed' } }),
            db.getRepository(DependencyEntity).find({ where }),
            db.getRepository(IntakeItemEntity).find({ where: { workspaceId, state: 'new' } }),
            db.query(SINCE_SQL, [workspaceId]),
        ]);
        const userRows = await db.getRepository(UserEntity).find({ where: { id: In(memberships.map((m) => m.userId)) } });
        const names = new Map();
        for (const u of userRows)
            names.set(u.id, u.name);
        for (const a of agents)
            names.set(a.id, a.name);
        const data = {
            now: new Date(),
            teams,
            names,
            adminIds: memberships.filter((m) => m.role === 'admin' || m.role === 'owner').map((m) => m.userId),
            workstreams,
            executions,
            inputRequests,
            artifacts,
            decisions,
            dependencies,
            intake,
            since: new Map(sinceRows.map((r) => [r.id, new Date(r.at)])),
        };
        return computeAttention(data);
    }
};
AttentionService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource,
        EventsService])
], AttentionService);
export { AttentionService };
//# sourceMappingURL=attention.service.js.map