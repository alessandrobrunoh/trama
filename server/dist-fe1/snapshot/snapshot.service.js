var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AttentionService } from '../attention/attention.service.js';
import { AgentEntity, ArtifactEntity, CommentEntity, DecisionEntity, DependencyEntity, DomainEventEntity, ExecutionEntity, InputRequestEntity, IntakeItemEntity, IntegrationConnectionEntity, MembershipEntity, RepositoryEntity, TeamEntity, UserEntity, WorkstreamEntity, } from '../database/entities/index.js';
import { ExecutionsService } from '../executions/executions.service.js';
import { ViewsService } from '../views/views.service.js';
export const SNAPSHOT_EVENTS = 500;
let SnapshotService = class SnapshotService {
    ds;
    executions;
    views;
    attention;
    constructor(ds, executions, views, attention) {
        this.ds = ds;
        this.executions = executions;
        this.views = views;
        this.attention = attention;
    }
    async build(ctx, me, myRole) {
        const workspaceId = ctx.workspace.id;
        const where = { workspaceId };
        const all = (e, order) => this.ds.getRepository(e).find({ where: where, order: order });
        const memberships = await all(MembershipEntity, { createdAt: 'ASC' });
        const [users, agents, teams, repositories, workstreams, executions, inputRequests, intake, artifacts, decisions, dependencies, comments, events, views, integrations, attention] = await Promise.all([
            this.ds.getRepository(UserEntity).findBy({ id: In(memberships.map((m) => m.userId)) }),
            all(AgentEntity, { createdAt: 'ASC' }),
            all(TeamEntity, { name: 'ASC' }),
            all(RepositoryEntity, { fullName: 'ASC' }),
            all(WorkstreamEntity, { createdAt: 'ASC' }),
            all(ExecutionEntity, { createdAt: 'ASC' }).then((rows) => this.executions.attach(workspaceId, rows)),
            all(InputRequestEntity, { createdAt: 'ASC' }),
            all(IntakeItemEntity, { createdAt: 'ASC' }),
            all(ArtifactEntity, { createdAt: 'ASC' }),
            all(DecisionEntity, { number: 'ASC' }),
            all(DependencyEntity, { createdAt: 'ASC' }),
            all(CommentEntity, { createdAt: 'ASC' }),
            this.ds.getRepository(DomainEventEntity).find({ where, order: { at: 'DESC', id: 'DESC' }, take: SNAPSHOT_EVENTS }),
            this.views.list(workspaceId, ctx.userId),
            this.ds.getRepository(IntegrationConnectionEntity).find({ where, order: { createdAt: 'ASC' } }),
            this.attention.forUser(ctx),
        ]);
        return {
            workspace: ctx.workspace,
            me,
            myRole,
            users,
            memberships,
            agents,
            teams,
            repositories,
            workstreams,
            executions,
            inputRequests,
            intake,
            artifacts,
            decisions,
            dependencies,
            comments,
            events,
            attention,
            views,
            integrations,
        };
    }
};
SnapshotService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource,
        ExecutionsService,
        ViewsService,
        AttentionService])
], SnapshotService);
export { SnapshotService };
//# sourceMappingURL=snapshot.service.js.map