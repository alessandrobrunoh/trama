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
import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import { RepositoryEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
let RepositoriesService = class RepositoriesService {
    ds;
    refs;
    events;
    repo;
    constructor(ds, refs, events, repo) {
        this.ds = ds;
        this.refs = refs;
        this.events = events;
        this.repo = repo;
    }
    list(workspaceId) {
        return this.repo.find({ where: { workspaceId }, order: { fullName: 'ASC' } });
    }
    async get(workspaceId, id) {
        const r = await this.repo.findOneBy({ workspaceId, id });
        if (!r)
            throw notFound('Repository', id);
        return r;
    }
    async create(workspaceId, actor, input) {
        await this.refs.teams(workspaceId, input.teamIds);
        if (await this.repo.existsBy({ workspaceId, provider: input.provider, fullName: input.fullName }))
            throw new ConflictException(`Repository ${input.fullName} already exists`);
        const host = input.provider === 'github' ? 'github.com' : 'gitlab.com';
        const row = await this.repo.save(this.repo.create({
            id: uid('rp'),
            workspaceId,
            provider: input.provider,
            fullName: input.fullName,
            url: input.url ?? `https://${host}/${input.fullName}`,
            defaultBranch: input.defaultBranch ?? 'main',
            teamIds: unique(input.teamIds),
        }));
        await this.events.record({ workspaceId, actor, type: 'repository.created', subject: { type: 'repository', id: row.id }, data: { fullName: row.fullName } });
        return row;
    }
    async update(workspaceId, actor, id, patch) {
        const row = await this.get(workspaceId, id);
        await this.refs.teams(workspaceId, patch.teamIds);
        if (patch.url !== undefined)
            row.url = patch.url;
        if (patch.defaultBranch !== undefined)
            row.defaultBranch = patch.defaultBranch;
        if (patch.teamIds !== undefined)
            row.teamIds = unique(patch.teamIds);
        await this.repo.save(row);
        await this.events.record({ workspaceId, actor, type: 'repository.updated', subject: { type: 'repository', id }, data: { fields: Object.keys(patch) } });
        return row;
    }
    async remove(workspaceId, actor, id) {
        const row = await this.get(workspaceId, id);
        await this.ds.transaction(async (m) => {
            const streams = await m.getRepository(WorkstreamEntity).findBy({ workspaceId });
            for (const w of streams)
                if (w.repositoryIds.includes(id))
                    await m.update(WorkstreamEntity, { id: w.id }, { repositoryIds: w.repositoryIds.filter((r) => r !== id) });
            await m.query(`UPDATE "executions" SET "repositoryIds" = "repositoryIds" - $2::text WHERE "workspaceId" = $1 AND "repositoryIds" ? $2::text`, [workspaceId, id]);
            await m.delete(RepositoryEntity, { id });
        });
        await this.events.record({ workspaceId, actor, type: 'repository.deleted', subject: { type: 'repository', id }, data: { fullName: row.fullName } });
    }
};
RepositoriesService = __decorate([
    Injectable(),
    __param(3, InjectRepository(RepositoryEntity)),
    __metadata("design:paramtypes", [DataSource,
        RefsService,
        EventsService, Function])
], RepositoriesService);
export { RepositoriesService };
//# sourceMappingURL=repositories.service.js.map