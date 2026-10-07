var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var SeedService_1;
import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';
import { AgentEntity, ArtifactEntity, CommentEntity, DecisionEntity, DependencyEntity, DomainEventEntity, ENTITIES, ExecutionEntity, InputRequestEntity, IntakeItemEntity, IntegrationConnectionEntity, MembershipEntity, RepositoryEntity, SavedViewEntity, TeamEntity, UserEntity, WorkspaceCounterEntity, WorkspaceEntity, WorkstreamEntity, } from '../entities/index.js';
import { WorkstreamBus } from '../../events/workstream-bus.js';
import { DEMO_PASSWORD, createSeed } from './seed-data.js';
let SeedService = SeedService_1 = class SeedService {
    ds;
    bus;
    logger = new Logger(SeedService_1.name);
    constructor(ds, bus) {
        this.ds = ds;
        this.bus = bus;
    }
    async onApplicationBootstrap() {
        if (process.env.NODE_ENV === 'production' || process.env.SEED_DEMO === 'false')
            return;
        if ((await this.ds.getRepository(UserEntity).count()) > 0)
            return;
        await this.reset();
        this.logger.log('Empty database: seeded demo workspace "Acme" (demo@nabla.dev / nabla-demo)');
    }
    async reset() {
        const passwordHash = await argon2.hash(DEMO_PASSWORD);
        const data = createSeed(Date.now(), passwordHash);
        await this.ds.transaction(async (m) => {
            const tables = ENTITIES.map((e) => `"${this.ds.getMetadata(e).tableName}"`);
            await m.query(`TRUNCATE ${tables.join(', ')} CASCADE`);
            await insert(m, UserEntity, data.users);
            await insert(m, WorkspaceEntity, [data.workspace]);
            await insert(m, MembershipEntity, data.memberships);
            await insert(m, AgentEntity, data.agents);
            await insert(m, TeamEntity, data.teams);
            await insert(m, RepositoryEntity, data.repositories);
            await insert(m, WorkstreamEntity, data.workstreams);
            await insert(m, ExecutionEntity, data.executions);
            await insert(m, InputRequestEntity, data.inputRequests);
            await insert(m, IntakeItemEntity, data.intake);
            await insert(m, ArtifactEntity, data.artifacts);
            await insert(m, DecisionEntity, data.decisions);
            await insert(m, DependencyEntity, data.dependencies);
            await insert(m, CommentEntity, data.comments);
            await insert(m, DomainEventEntity, data.events);
            await insert(m, SavedViewEntity, data.views);
            await insert(m, IntegrationConnectionEntity, data.integrations);
            await insert(m, WorkspaceCounterEntity, Object.entries(data.counters).map(([name, value]) => ({ workspaceId: data.workspace.id, name, value })));
        });
        await this.bus.touchMany(data.workspace.id, data.workstreams.map((w) => w.id), 'seed.reset');
    }
};
SeedService = SeedService_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource,
        WorkstreamBus])
], SeedService);
export { SeedService };
async function insert(m, target, rows) {
    for (let i = 0; i < rows.length; i += 200)
        await m.insert(target, rows.slice(i, i + 200));
}
//# sourceMappingURL=seed.service.js.map