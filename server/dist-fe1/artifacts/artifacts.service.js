var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid } from '../common/util.js';
import { ArtifactEntity, ExecutionEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { WorkstreamBus } from '../events/workstream-bus.js';
const DEFAULT_STATE = {
    pull_request: 'open',
    merge_request: 'open',
    commit: 'merged',
    branch: 'open',
    document: 'published',
    design: 'published',
    build: 'pending',
    test_report: 'succeeded',
    deployment: 'pending',
    release: 'published',
};
let ArtifactsService = class ArtifactsService {
    ds;
    refs;
    events;
    bus;
    repo;
    constructor(ds, refs, events, bus, repo) {
        this.ds = ds;
        this.refs = refs;
        this.events = events;
        this.bus = bus;
        this.repo = repo;
    }
    list(workspaceId, f = {}) {
        const qb = this.repo.createQueryBuilder('a').where('a.workspaceId = :workspaceId', { workspaceId }).orderBy('a.createdAt', 'DESC');
        if (f.workstreamId)
            qb.andWhere('a.workstreamId = :w', { w: f.workstreamId });
        if (f.executionId)
            qb.andWhere('a.executionId = :e', { e: f.executionId });
        if (f.repositoryId)
            qb.andWhere('a.repositoryId = :r', { r: f.repositoryId });
        if (f.kind)
            qb.andWhere('a.kind = :k', { k: f.kind });
        if (f.state)
            qb.andWhere('a.state = :s', { s: f.state });
        return qb.getMany();
    }
    async get(workspaceId, id) {
        const row = await this.repo.findOneBy({ workspaceId, id });
        if (!row)
            throw notFound('Artifact', id);
        return row;
    }
    async validate(workspaceId, workstreamId, input) {
        if (input.repositoryId)
            await this.refs.repositories(workspaceId, [input.repositoryId]);
        if (input.executionId) {
            const ex = await this.ds.getRepository(ExecutionEntity).findOneBy({ id: input.executionId, workspaceId });
            if (!ex)
                throw new BadRequestException(`Unknown execution "${input.executionId}"`);
            if (workstreamId && ex.workstreamId !== workstreamId)
                throw new BadRequestException('executionId belongs to a different workstream');
        }
    }
    async create(workspaceId, actor, input) {
        if (!(await this.ds.getRepository(WorkstreamEntity).existsBy({ id: input.workstreamId, workspaceId })))
            throw new BadRequestException(`Unknown workstream "${input.workstreamId}"`);
        await this.validate(workspaceId, input.workstreamId, input);
        const isPr = input.kind === 'pull_request' || input.kind === 'merge_request';
        const row = await this.repo.save(this.repo.create({
            id: uid('ar'),
            workspaceId,
            workstreamId: input.workstreamId,
            executionId: input.executionId ?? null,
            repositoryId: input.repositoryId ?? null,
            kind: input.kind,
            provider: input.provider ?? (input.kind === 'merge_request' ? 'gitlab' : input.kind === 'pull_request' ? 'github' : 'other'),
            title: input.title.trim(),
            url: input.url ?? null,
            externalId: input.externalId ?? null,
            state: input.state ?? DEFAULT_STATE[input.kind],
            ci: input.ci ?? (isPr ? 'pending' : null),
            review: input.review ?? (isPr ? 'none' : null),
            hasConflicts: input.hasConflicts ?? (isPr ? false : null),
            environment: input.environment ?? null,
            authorRef: actor,
        }));
        await this.events.record({
            workspaceId,
            actor,
            type: 'artifact.attached',
            subject: { type: 'artifact', id: row.id },
            workstreamId: row.workstreamId,
            data: { kind: row.kind, title: row.title, externalId: row.externalId, state: row.state },
        });
        if (row.review === 'requested')
            await this.reviewRequested(row, actor);
        await this.bus.touch(workspaceId, row.workstreamId, 'artifact.attached');
        return row;
    }
    reviewRequested(row, actor) {
        return this.events.record({
            workspaceId: row.workspaceId,
            actor,
            type: 'review.requested',
            subject: { type: 'artifact', id: row.id },
            workstreamId: row.workstreamId,
            data: { title: row.title, externalId: row.externalId },
        }, false);
    }
    async update(workspaceId, actor, id, patch) {
        const row = await this.get(workspaceId, id);
        await this.validate(workspaceId, row.workstreamId, patch);
        const fields = [];
        const changes = {};
        const set = (k, v) => {
            if (v !== undefined && JSON.stringify(row[k]) !== JSON.stringify(v)) {
                changes[k] = [row[k], v];
                row[k] = v;
                fields.push(k);
            }
        };
        if (patch.title !== undefined)
            set('title', patch.title.trim());
        for (const k of ['executionId', 'repositoryId', 'provider', 'url', 'externalId', 'state', 'ci', 'review', 'hasConflicts', 'environment'])
            set(k, patch[k]);
        if (!fields.length)
            return row;
        row.updatedAt = new Date();
        await this.repo.save(row);
        await this.events.record({
            workspaceId,
            actor,
            type: 'artifact.updated',
            subject: { type: 'artifact', id },
            workstreamId: row.workstreamId,
            data: { title: row.title, externalId: row.externalId, changes },
        });
        if (changes.review && row.review === 'requested')
            await this.reviewRequested(row, actor);
        await this.bus.touch(workspaceId, row.workstreamId, 'artifact.updated');
        return row;
    }
    async remove(workspaceId, actor, id) {
        const row = await this.get(workspaceId, id);
        await this.ds.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`, [workspaceId, id]);
        await this.repo.delete({ id });
        await this.events.record({
            workspaceId,
            actor,
            type: 'artifact.deleted',
            subject: { type: 'artifact', id },
            workstreamId: row.workstreamId,
            data: { title: row.title },
        });
        await this.bus.touch(workspaceId, row.workstreamId, 'artifact.deleted');
    }
};
ArtifactsService = __decorate([
    Injectable(),
    __param(4, InjectRepository(ArtifactEntity)),
    __metadata("design:paramtypes", [DataSource,
        RefsService,
        EventsService,
        WorkstreamBus, Function])
], ArtifactsService);
export { ArtifactsService };
//# sourceMappingURL=artifacts.service.js.map