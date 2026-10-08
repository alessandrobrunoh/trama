import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { GIT_PROVIDER_META, type ActorRef, type GitProvider } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, uid, unique } from '../common/util.js';
import { ProjectEntity, RepositoryEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { LabelsService } from '../workspaces/labels.service.js';

export interface RepositoryInput {
  provider?: GitProvider;
  fullName?: string;
  url?: string;
  defaultBranch?: string;
  teamIds?: string[];
  labels?: string[];
}

@Injectable()
export class RepositoriesService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    private readonly labels: LabelsService,
    @InjectRepository(RepositoryEntity) private readonly repo: Repository<RepositoryEntity>,
  ) {}

  list(workspaceId: string) {
    return this.repo.find({ where: { workspaceId }, order: { fullName: 'ASC' } });
  }

  async get(workspaceId: string, id: string) {
    const r = await this.repo.findOneBy({ workspaceId, id });
    if (!r) throw notFound('Repository', id);
    return r;
  }

  async create(workspaceId: string, actor: ActorRef, input: RepositoryInput & { provider: GitProvider; fullName: string }) {
    await this.refs.teams(workspaceId, input.teamIds);
    if (await this.repo.existsBy({ workspaceId, provider: input.provider, fullName: input.fullName }))
      throw new ConflictException(`Repository ${input.fullName} already exists`);
    const host = GIT_PROVIDER_META[input.provider].host;
    const row = await this.repo.save(
      this.repo.create({
        id: uid('rp'),
        workspaceId,
        provider: input.provider,
        fullName: input.fullName,
        url: input.url ?? `https://${host}/${input.fullName}`,
        defaultBranch: input.defaultBranch ?? 'main',
        teamIds: unique(input.teamIds),
        labels: (await this.labels.assign(workspaceId, input.labels)) ?? [],
      }),
    );
    await this.events.record({ workspaceId, actor, type: 'repository.created', subject: { type: 'repository', id: row.id }, data: { fullName: row.fullName } });
    return row;
  }

  async update(workspaceId: string, actor: ActorRef, id: string, patch: RepositoryInput) {
    const row = await this.get(workspaceId, id);
    await this.refs.teams(workspaceId, patch.teamIds);
    if (patch.url !== undefined) row.url = patch.url;
    if (patch.defaultBranch !== undefined) row.defaultBranch = patch.defaultBranch;
    if (patch.teamIds !== undefined) row.teamIds = unique(patch.teamIds);
    if (patch.labels !== undefined) row.labels = (await this.labels.assign(workspaceId, patch.labels)) ?? [];
    await this.repo.save(row);
    await this.events.record({ workspaceId, actor, type: 'repository.updated', subject: { type: 'repository', id }, data: { fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) } });
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    await this.ds.transaction(async (m) => {
      const streams = await m.getRepository(WorkstreamEntity).findBy({ workspaceId });
      for (const w of streams)
        if (w.repositoryIds.includes(id))
          await m.update(WorkstreamEntity, { id: w.id }, { repositoryIds: w.repositoryIds.filter((r) => r !== id) });
      const projects = await m.getRepository(ProjectEntity).findBy({ workspaceId });
      for (const p of projects)
        if (p.repositoryIds.includes(id))
          await m.update(ProjectEntity, { id: p.id }, { repositoryIds: p.repositoryIds.filter((r) => r !== id) });
      await m.delete(RepositoryEntity, { id });
    });
    await this.events.record({ workspaceId, actor, type: 'repository.deleted', subject: { type: 'repository', id }, data: { fullName: row.fullName } });
  }
}
