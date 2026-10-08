import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, Priority, ProjectStatus } from '../contracts/domain.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, toDate, uid, unique } from '../common/util.js';
import { ProjectEntity, WorkstreamEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

export interface ProjectInput {
  name?: string;
  summary?: string | null;
  description?: string | null;
  color?: string;
  status?: ProjectStatus;
  priority?: Priority;
  leadId?: string | null;
  teamIds?: string[];
  repositoryIds?: string[];
  startDate?: string | null;
  targetDate?: string | null;
}

export interface ProjectFilter {
  status?: ProjectStatus;
  teamId?: string;
  leadId?: string;
  repositoryId?: string;
  q?: string;
}

const CLOSED: ProjectStatus[] = ['completed', 'canceled'];

@Injectable()
export class ProjectsService {
  constructor(
    private readonly ds: DataSource,
    private readonly refs: RefsService,
    private readonly events: EventsService,
    @InjectRepository(ProjectEntity) private readonly repo: Repository<ProjectEntity>,
  ) {}

  list(workspaceId: string, f: ProjectFilter = {}) {
    const qb = this.repo
      .createQueryBuilder('p')
      .where('p.workspaceId = :workspaceId', { workspaceId })
      .orderBy('p.updatedAt', 'DESC');
    if (f.status) qb.andWhere('p.status = :status', { status: f.status });
    if (f.leadId) qb.andWhere('p.leadId = :leadId', { leadId: f.leadId });
    if (f.teamId) qb.andWhere('p.teamIds @> :tid::jsonb', { tid: JSON.stringify([f.teamId]) });
    if (f.repositoryId) qb.andWhere('p.repositoryIds @> :rid::jsonb', { rid: JSON.stringify([f.repositoryId]) });
    if (f.q) qb.andWhere('p.name ILIKE :q', { q: `%${f.q}%` });
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row) throw notFound('Project', id);
    return row;
  }

  async create(workspaceId: string, actor: ActorRef, input: ProjectInput & { name: string }) {
    await this.validate(workspaceId, input);
    const status = input.status ?? 'backlog';
    const row = await this.repo.save(
      this.repo.create({
        id: uid('pj'),
        workspaceId,
        name: input.name.trim(),
        summary: input.summary?.trim() || null,
        description: input.description ?? null,
        color: input.color ?? '#6b7280',
        status,
        priority: input.priority ?? 'none',
        leadId: input.leadId ?? null,
        teamIds: unique(input.teamIds),
        repositoryIds: unique(input.repositoryIds),
        startDate: toDate(input.startDate) ?? null,
        targetDate: toDate(input.targetDate) ?? null,
        completedAt: CLOSED.includes(status) ? new Date() : null,
      }),
    );
    await this.events.record({ workspaceId, actor, type: 'project.created', subject: { type: 'project', id: row.id }, data: { name: row.name } });
    return row;
  }

  async update(workspaceId: string, actor: ActorRef, id: string, patch: ProjectInput) {
    const row = await this.get(workspaceId, id);
    await this.validate(workspaceId, patch);
    const before = row.status;
    if (patch.name !== undefined) row.name = patch.name.trim();
    if (patch.summary !== undefined) row.summary = patch.summary?.trim() || null;
    if (patch.description !== undefined) row.description = patch.description;
    if (patch.color !== undefined) row.color = patch.color;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.leadId !== undefined) row.leadId = patch.leadId;
    if (patch.teamIds !== undefined) row.teamIds = unique(patch.teamIds);
    if (patch.repositoryIds !== undefined) row.repositoryIds = unique(patch.repositoryIds);
    if (patch.startDate !== undefined) row.startDate = toDate(patch.startDate) ?? null;
    if (patch.targetDate !== undefined) row.targetDate = toDate(patch.targetDate) ?? null;
    if (patch.status !== undefined) {
      row.status = patch.status;
      row.completedAt = CLOSED.includes(patch.status) ? (row.completedAt ?? new Date()) : null;
    }
    row.updatedAt = new Date();
    await this.ds.transaction(async (m) => {
      await m.save(row);
      if (patch.repositoryIds === undefined) return;
      // Its workstreams may only use the project's repositories: drop the ones that left.
      const streams = await m.getRepository(WorkstreamEntity).findBy({ workspaceId, projectId: id });
      for (const w of streams) {
        const kept = w.repositoryIds.filter((r) => row.repositoryIds.includes(r));
        if (kept.length !== w.repositoryIds.length) await m.update(WorkstreamEntity, { id: w.id }, { repositoryIds: kept });
      }
    });
    await this.events.record({
      workspaceId,
      actor,
      type: 'project.updated',
      subject: { type: 'project', id },
      data: { fields: Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined) },
    });
    if (row.status !== before)
      await this.events.record({ workspaceId, actor, type: 'project.status_changed', subject: { type: 'project', id }, data: { from: before, to: row.status } });
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    const milestoneIds = (
      await this.ds.query<{ id: string }[]>(`SELECT "id" FROM "milestones" WHERE "projectId" = $1`, [id])
    ).map((r) => r.id);
    await this.ds.transaction(async (m) => {
      if (milestoneIds.length) {
        // milestones cascade with the project: drop their ids from issues, and their comments
        await m.query(
          `UPDATE "issues" SET "milestoneIds" = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text("milestoneIds") x WHERE x <> ALL($2)), '[]'::jsonb) WHERE "workspaceId" = $1 AND "milestoneIds" ?| $2`,
          [workspaceId, milestoneIds],
        );
        await m.query(`DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`, [workspaceId, milestoneIds]);
      }
      await m.delete(ProjectEntity, { id });
    });
    await this.events.record({ workspaceId, actor, type: 'project.deleted', subject: { type: 'project', id }, data: { name: row.name } });
  }

  private async validate(workspaceId: string, input: ProjectInput) {
    await this.refs.teams(workspaceId, input.teamIds);
    await this.refs.repositories(workspaceId, input.repositoryIds);
    await this.refs.users(workspaceId, [input.leadId]);
  }
}
