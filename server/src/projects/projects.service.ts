import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import type { ActorRef, Priority, ProjectStatus } from '../contracts/domain.js';
import {
  loadStatusCatalog,
  requireStatus,
  statusFilterIds,
} from '../status/status-catalog.js';
import { RefsService } from '../common/refs.service.js';
import { notFound, toDate, uid, unique } from '../common/util.js';
import { ProjectEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import {
  demandConditions,
  type DemandFilter,
} from '../customers/demand-filter.js';
import { LabelsService } from '../workspaces/labels.service.js';
import { isProjectIcon } from './project-icon.js';
import {
  applyProjectScope,
  currentAccess,
  projectHidden,
} from '../auth/member-access.js';
import { UploadsService } from '../uploads/uploads.service.js';

export interface ProjectInput {
  name?: string;
  summary?: string | null;
  description?: string | null;
  color?: string;
  /** Lucide icon name (kebab-case) or an emoji; null clears it. */
  icon?: string | null;
  /** Catalog id, or a legacy enum (the seeded status of that type). */
  status?: string;
  priority?: Priority;
  leadId?: string | null;
  teamIds?: string[];
  repositoryIds?: string[];
  labels?: string[];
  startDate?: string | null;
  targetDate?: string | null;
}

export interface ProjectFilter extends DemandFilter {
  /** Catalog id, or a legacy enum (the seeded status of that type). */
  status?: string;
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
    private readonly labels: LabelsService,
    @InjectRepository(ProjectEntity)
    private readonly repo: Repository<ProjectEntity>,
    @Optional()
    @Inject(UploadsService)
    private readonly uploads?: UploadsService,
  ) {}

  private async projectStatus(workspaceId: string, stored: string) {
    return requireStatus(
      (await loadStatusCatalog(this.ds, workspaceId)).project,
      stored,
      'status',
    );
  }

  async list(workspaceId: string, f: ProjectFilter = {}) {
    const qb = this.repo
      .createQueryBuilder('p')
      .where('p.workspaceId = :workspaceId', { workspaceId })
      .orderBy('p.updatedAt', 'DESC');
    if (f.status) {
      const catalog = (await loadStatusCatalog(this.ds, workspaceId)).project;
      qb.andWhere('p.status IN (:...st)', {
        st: statusFilterIds(catalog, f.status),
      });
    }
    if (f.leadId) qb.andWhere('p.leadId = :leadId', { leadId: f.leadId });
    if (f.teamId)
      qb.andWhere('p.teamIds @> :tid::jsonb', {
        tid: JSON.stringify([f.teamId]),
      });
    if (f.repositoryId)
      qb.andWhere('p.repositoryIds @> :rid::jsonb', {
        rid: JSON.stringify([f.repositoryId]),
      });
    for (const c of demandConditions('p', 'projectId', f))
      qb.andWhere(c.sql, c.params);
    if (f.q) qb.andWhere('p.name ILIKE :q', { q: `%${f.q}%` });
    applyProjectScope(qb, 'p', 'id');
    return qb.getMany();
  }

  async get(workspaceId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, id });
    if (!row || projectHidden(currentAccess(), row.id))
      throw notFound('Project', id);
    return row;
  }

  async create(
    workspaceId: string,
    actor: ActorRef,
    input: ProjectInput & { name: string },
  ) {
    const access = currentAccess();
    if (access && !access.projects.all)
      throw new ForbiddenException(
        'Your access cannot add projects outside its list',
      );
    await this.validate(workspaceId, input);
    const entry = await this.projectStatus(
      workspaceId,
      input.status ?? 'backlog',
    );
    const status = entry.id as ProjectStatus;
    const row = await this.repo.save(
      this.repo.create({
        id: uid('pj'),
        workspaceId,
        name: input.name.trim(),
        summary: input.summary?.trim() || null,
        description: input.description ?? null,
        color: input.color ?? '#6b7280',
        icon: input.icon ?? null,
        status,
        priority: input.priority ?? 'none',
        leadId: input.leadId ?? null,
        teamIds: unique(input.teamIds),
        repositoryIds: unique(input.repositoryIds),
        labels:
          (await this.labels.assign(workspaceId, input.labels, 'project')) ??
          [],
        startDate: toDate(input.startDate) ?? null,
        targetDate: toDate(input.targetDate) ?? null,
        completedAt: CLOSED.includes(entry.type) ? new Date() : null,
      }),
    );
    await this.events.record({
      workspaceId,
      actor,
      type: 'project.created',
      subject: { type: 'project', id: row.id },
      data: { name: row.name },
    });
    return row;
  }

  async update(
    workspaceId: string,
    actor: ActorRef,
    id: string,
    patch: ProjectInput,
  ) {
    const row = await this.get(workspaceId, id);
    await this.validate(workspaceId, patch);
    const before = row.status;
    const previousDescription = row.description;
    if (patch.name !== undefined) row.name = patch.name.trim();
    if (patch.summary !== undefined)
      row.summary = patch.summary?.trim() || null;
    if (patch.description !== undefined) {
      await this.uploads?.assertAttachable(workspaceId, patch.description);
      row.description = patch.description;
    }
    if (patch.color !== undefined) row.color = patch.color;
    if (patch.icon !== undefined) row.icon = patch.icon;
    if (patch.priority !== undefined) row.priority = patch.priority;
    if (patch.leadId !== undefined) row.leadId = patch.leadId;
    if (patch.teamIds !== undefined) row.teamIds = unique(patch.teamIds);
    if (patch.repositoryIds !== undefined)
      row.repositoryIds = unique(patch.repositoryIds);
    if (patch.labels !== undefined)
      row.labels =
        (await this.labels.assign(
          workspaceId,
          patch.labels,
          'project',
          row.labels,
        )) ?? [];
    if (patch.startDate !== undefined)
      row.startDate = toDate(patch.startDate) ?? null;
    if (patch.targetDate !== undefined)
      row.targetDate = toDate(patch.targetDate) ?? null;
    if (patch.status !== undefined) {
      const entry = await this.projectStatus(workspaceId, patch.status);
      row.status = entry.id as ProjectStatus;
      row.completedAt = CLOSED.includes(entry.type)
        ? (row.completedAt ?? new Date())
        : null;
    }
    row.updatedAt = new Date();
    await this.repo.save(row);
    await this.events.record({
      workspaceId,
      actor,
      type: 'project.updated',
      subject: { type: 'project', id },
      data: {
        fields: Object.keys(patch).filter(
          (k) => (patch as Record<string, unknown>)[k] !== undefined,
        ),
      },
    });
    if (patch.description !== undefined)
      await this.uploads?.retained(
        workspaceId,
        previousDescription,
        row.description,
      );
    if (row.status !== before)
      await this.events.record({
        workspaceId,
        actor,
        type: 'project.status_changed',
        subject: { type: 'project', id },
        data: { from: before, to: row.status },
      });
    return row;
  }

  async remove(workspaceId: string, actor: ActorRef, id: string) {
    const row = await this.get(workspaceId, id);
    const lost =
      (await this.uploads?.idsLostWith(workspaceId, { projectId: id }, [
        row.description,
      ])) ?? [];
    const milestoneIds = (
      await this.ds.query<{ id: string }[]>(
        `SELECT "id" FROM "milestones" WHERE "projectId" = $1`,
        [id],
      )
    ).map((r) => r.id);
    const updateIds = (
      await this.ds.query<{ id: string }[]>(
        `SELECT "id" FROM "project_updates" WHERE "projectId" = $1`,
        [id],
      )
    ).map((r) => r.id);
    await this.ds.transaction(async (m) => {
      // project updates cascade with the project: drop their comments
      if (updateIds.length)
        await m.query(
          `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`,
          [workspaceId, updateIds],
        );
      if (milestoneIds.length) {
        // milestones cascade with the project: drop their ids from issues, and their comments
        await m.query(
          `UPDATE "issues" SET "milestoneIds" = COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text("milestoneIds") x WHERE x <> ALL($2)), '[]'::jsonb) WHERE "workspaceId" = $1 AND "milestoneIds" ?| $2`,
          [workspaceId, milestoneIds],
        );
        await m.query(
          `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = ANY($2)`,
          [workspaceId, milestoneIds],
        );
      }
      await m.delete(ProjectEntity, { id });
    });
    await this.uploads?.releaseIds(workspaceId, lost);
    await this.events.record({
      workspaceId,
      actor,
      type: 'project.deleted',
      subject: { type: 'project', id },
      data: { name: row.name },
    });
  }

  private async validate(workspaceId: string, input: ProjectInput) {
    if (input.icon != null && !isProjectIcon(input.icon))
      throw new BadRequestException(
        'icon must be a lucide icon name (kebab-case) or a single emoji',
      );
    await this.refs.teams(workspaceId, input.teamIds);
    await this.refs.repositories(workspaceId, input.repositoryIds);
    await this.refs.users(workspaceId, [input.leadId]);
  }
}
