import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, TeamEditPolicy } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import { TeamEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

export interface TeamInput {
  name?: string;
  key?: string;
  color?: string;
  description?: string | null;
  memberIds?: string[];
  leadIds?: string[];
  editPolicy?: TeamEditPolicy;
}

const KEY_RE = /^[A-Z][A-Z0-9]{1,7}$/;

@Injectable()
export class TeamsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    @InjectRepository(TeamEntity) private readonly repo: Repository<TeamEntity>,
  ) {}

  list(workspaceId: string) {
    return this.repo.find({ where: { workspaceId }, order: { name: 'ASC' } });
  }

  async get(workspaceId: string, idOrKey: string): Promise<TeamEntity> {
    const team = await this.repo.findOne({
      where: KEY_RE.test(idOrKey.toUpperCase()) && !idOrKey.startsWith('tm_')
        ? { workspaceId, key: idOrKey.toUpperCase() }
        : { workspaceId, id: idOrKey },
    });
    if (!team) throw notFound('Team', idOrKey);
    return team;
  }

  async create(workspaceId: string, actor: ActorRef, input: TeamInput & { name: string; key: string }) {
    await this.refs.users(workspaceId, input.memberIds);
    const memberIds = unique(input.memberIds);
    const leadIds = unique(input.leadIds);
    if (leadIds.some((id) => !memberIds.includes(id))) throw new BadRequestException('leadIds must be members of the team');
    if (await this.repo.existsBy({ workspaceId, key: input.key }))
      throw new ConflictException(`Team key "${input.key}" is already used`);
    const team = await this.repo.save(
      this.repo.create({
        id: uid('tm'),
        workspaceId,
        name: input.name.trim(),
        key: input.key,
        color: input.color ?? '#6b7280',
        description: input.description ?? null,
        memberIds,
        leadIds,
        editPolicy: input.editPolicy ?? 'workspace',
      }),
    );
    await this.events.record({ workspaceId, actor, type: 'team.created', subject: { type: 'team', id: team.id }, data: { key: team.key } });
    return team;
  }

  async update(workspaceId: string, actor: ActorRef, idOrKey: string, patch: TeamInput) {
    const team = await this.get(workspaceId, idOrKey);
    await this.refs.users(workspaceId, patch.memberIds);
    if (patch.name !== undefined) team.name = patch.name.trim();
    if (patch.color !== undefined) team.color = patch.color;
    if (patch.description !== undefined) team.description = patch.description;
    if (patch.memberIds !== undefined) team.memberIds = unique(patch.memberIds);
    if (patch.leadIds !== undefined) {
      const leads = unique(patch.leadIds);
      if (leads.some((id) => !team.memberIds.includes(id))) throw new BadRequestException('leadIds must be members of the team');
      team.leadIds = leads;
    } else if (patch.memberIds !== undefined) {
      team.leadIds = team.leadIds.filter((id) => team.memberIds.includes(id));
    }
    if (patch.editPolicy !== undefined) team.editPolicy = patch.editPolicy;
    await this.repo.save(team);
    await this.events.record({ workspaceId, actor, type: 'team.updated', subject: { type: 'team', id: team.id }, data: { fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) } });
    return team;
  }

  /** 409 while the team still owns workstreams; otherwise detaches it from everything else. */
  async remove(workspaceId: string, actor: ActorRef, idOrKey: string) {
    const team = await this.get(workspaceId, idOrKey);
    const owned = await this.ds.getRepository(WorkstreamEntity).countBy({ workspaceId, ownerTeamId: team.id });
    if (owned > 0) throw new ConflictException(`Team owns ${owned} workstream(s); reassign them first`);
    await this.ds.transaction(async (m) => {
      const streams = await m.getRepository(WorkstreamEntity).findBy({ workspaceId });
      for (const w of streams)
        if (w.participatingTeamIds.includes(team.id))
          await m.update(WorkstreamEntity, { id: w.id }, { participatingTeamIds: w.participatingTeamIds.filter((t) => t !== team.id) });
      await m.query(`UPDATE "issues" SET "teamId" = NULL WHERE "teamId" = $1`, [team.id]);
      await m.delete(TeamEntity, { id: team.id });
    });
    await this.events.record({ workspaceId, actor, type: 'team.deleted', subject: { type: 'team', id: team.id }, data: { key: team.key } });
  }
}
