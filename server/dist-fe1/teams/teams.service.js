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
import { TeamEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
const KEY_RE = /^[A-Z][A-Z0-9]{1,7}$/;
let TeamsService = class TeamsService {
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
        return this.repo.find({ where: { workspaceId }, order: { name: 'ASC' } });
    }
    async get(workspaceId, idOrKey) {
        const team = await this.repo.findOne({
            where: KEY_RE.test(idOrKey.toUpperCase()) && !idOrKey.startsWith('tm_')
                ? { workspaceId, key: idOrKey.toUpperCase() }
                : { workspaceId, id: idOrKey },
        });
        if (!team)
            throw notFound('Team', idOrKey);
        return team;
    }
    async create(workspaceId, actor, input) {
        await this.refs.users(workspaceId, input.memberIds);
        if (await this.repo.existsBy({ workspaceId, key: input.key }))
            throw new ConflictException(`Team key "${input.key}" is already used`);
        const team = await this.repo.save(this.repo.create({
            id: uid('tm'),
            workspaceId,
            name: input.name.trim(),
            key: input.key,
            color: input.color ?? '#6b7280',
            description: input.description ?? null,
            memberIds: unique(input.memberIds),
        }));
        await this.events.record({ workspaceId, actor, type: 'team.created', subject: { type: 'team', id: team.id }, data: { key: team.key } });
        return team;
    }
    async update(workspaceId, actor, idOrKey, patch) {
        const team = await this.get(workspaceId, idOrKey);
        await this.refs.users(workspaceId, patch.memberIds);
        if (patch.name !== undefined)
            team.name = patch.name.trim();
        if (patch.color !== undefined)
            team.color = patch.color;
        if (patch.description !== undefined)
            team.description = patch.description;
        if (patch.memberIds !== undefined)
            team.memberIds = unique(patch.memberIds);
        await this.repo.save(team);
        await this.events.record({ workspaceId, actor, type: 'team.updated', subject: { type: 'team', id: team.id }, data: { fields: Object.keys(patch) } });
        return team;
    }
    async remove(workspaceId, actor, idOrKey) {
        const team = await this.get(workspaceId, idOrKey);
        const owned = await this.ds.getRepository(WorkstreamEntity).countBy({ workspaceId, ownerTeamId: team.id });
        if (owned > 0)
            throw new ConflictException(`Team owns ${owned} workstream(s); reassign them first`);
        await this.ds.transaction(async (m) => {
            const streams = await m.getRepository(WorkstreamEntity).findBy({ workspaceId });
            for (const w of streams)
                if (w.participatingTeamIds.includes(team.id))
                    await m.update(WorkstreamEntity, { id: w.id }, { participatingTeamIds: w.participatingTeamIds.filter((t) => t !== team.id) });
            await m.query(`UPDATE "intake_items" SET "teamId" = NULL WHERE "teamId" = $1`, [team.id]);
            await m.delete(TeamEntity, { id: team.id });
        });
        await this.events.record({ workspaceId, actor, type: 'team.deleted', subject: { type: 'team', id: team.id }, data: { key: team.key } });
    }
};
TeamsService = __decorate([
    Injectable(),
    __param(3, InjectRepository(TeamEntity)),
    __metadata("design:paramtypes", [DataSource,
        RefsService,
        EventsService, Function])
], TeamsService);
export { TeamsService };
//# sourceMappingURL=teams.service.js.map