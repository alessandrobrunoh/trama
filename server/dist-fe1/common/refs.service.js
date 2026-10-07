var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { ArtifactEntity, DecisionEntity, ExecutionEntity, InputRequestEntity, IntakeItemEntity, MembershipEntity, RepositoryEntity, TeamEntity, WorkstreamEntity, } from '../database/entities/index.js';
let RefsService = class RefsService {
    ds;
    constructor(ds) {
        this.ds = ds;
    }
    async assertAll(target, workspaceId, ids, label) {
        const unique = [...new Set(ids ?? [])];
        if (!unique.length)
            return;
        const found = await this.ds
            .getRepository(target)
            .count({ where: { id: In(unique), workspaceId } });
        if (found !== unique.length)
            throw new BadRequestException(`Unknown ${label} in: ${unique.join(', ')}`);
    }
    teams(workspaceId, ids) {
        return this.assertAll(TeamEntity, workspaceId, ids, 'team');
    }
    repositories(workspaceId, ids) {
        return this.assertAll(RepositoryEntity, workspaceId, ids, 'repository');
    }
    workstreams(workspaceId, ids) {
        return this.assertAll(WorkstreamEntity, workspaceId, ids, 'workstream');
    }
    executions(workspaceId, ids) {
        return this.assertAll(ExecutionEntity, workspaceId, ids, 'execution');
    }
    async users(workspaceId, ids) {
        const unique = [...new Set((ids ?? []).filter((x) => !!x))];
        if (!unique.length)
            return;
        const found = await this.ds
            .getRepository(MembershipEntity)
            .count({ where: { workspaceId, userId: In(unique) } });
        if (found !== unique.length)
            throw new BadRequestException(`Not workspace members: ${unique.join(', ')}`);
    }
    async resolveSubject(workspaceId, subject) {
        const where = { id: subject.id, workspaceId };
        const db = this.ds;
        switch (subject.type) {
            case 'workstream': {
                const r = await db.getRepository(WorkstreamEntity).findOne({ where, select: { id: true } });
                return { exists: !!r, workstreamId: r?.id };
            }
            case 'execution': {
                const r = await db.getRepository(ExecutionEntity).findOne({ where, select: { id: true, workstreamId: true } });
                return { exists: !!r, workstreamId: r?.workstreamId };
            }
            case 'artifact': {
                const r = await db.getRepository(ArtifactEntity).findOne({ where, select: { id: true, workstreamId: true } });
                return { exists: !!r, workstreamId: r?.workstreamId };
            }
            case 'input_request': {
                const r = await db.getRepository(InputRequestEntity).findOne({ where, select: { id: true, workstreamId: true } });
                return { exists: !!r, workstreamId: r?.workstreamId };
            }
            case 'decision': {
                const r = await db.getRepository(DecisionEntity).findOne({ where });
                return { exists: !!r, workstreamId: r?.originWorkstreamId ?? undefined };
            }
            case 'intake':
                return { exists: await db.getRepository(IntakeItemEntity).existsBy(where) };
            case 'repository':
                return { exists: await db.getRepository(RepositoryEntity).existsBy(where) };
            case 'team':
                return { exists: await db.getRepository(TeamEntity).existsBy(where) };
        }
    }
};
RefsService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DataSource])
], RefsService);
export { RefsService };
//# sourceMappingURL=refs.service.js.map