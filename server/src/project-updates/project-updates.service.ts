import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import { canDo, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, ProjectHealth } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import {
  ProjectEntity,
  ProjectUpdateEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';

export interface ProjectUpdateInput {
  health?: ProjectHealth;
  body?: string;
  aiDrafted?: boolean;
}

const sameActor = (a: ActorRef, b: ActorRef) =>
  a.type === b.type && a.id === b.id;

@Injectable()
export class ProjectUpdatesService {
  constructor(
    private readonly ds: DataSource,
    private readonly events: EventsService,
    @InjectRepository(ProjectUpdateEntity)
    private readonly repo: Repository<ProjectUpdateEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projects: Repository<ProjectEntity>,
  ) {}

  private async project(workspaceId: string, projectId: string) {
    const row = await this.projects.findOneBy({ workspaceId, id: projectId });
    if (!row) throw notFound('Project', projectId);
    return row;
  }

  /** Newest first. */
  async list(workspaceId: string, projectId: string) {
    await this.project(workspaceId, projectId);
    return this.repo.find({
      where: { workspaceId, projectId },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  async get(workspaceId: string, projectId: string, id: string) {
    const row = await this.repo.findOneBy({ workspaceId, projectId, id });
    if (!row) throw notFound('Project update', id);
    return row;
  }

  /** `manageProjects`, or the project's lead. */
  async create(
    ctx: WorkspaceContext,
    projectId: string,
    input: ProjectUpdateInput & { health: ProjectHealth; body: string },
  ) {
    const workspaceId = ctx.workspace.id;
    const project = await this.project(workspaceId, projectId);
    const isLead = !!ctx.userId && project.leadId === ctx.userId;
    if (!isLead && !canDo(ctx, 'manageProjects'))
      throw new ForbiddenException(
        'Only the project lead or a role with "Manage projects" can post project updates',
      );
    const row = await this.ds.transaction(async (m) => {
      const saved = await m.getRepository(ProjectUpdateEntity).save(
        m.getRepository(ProjectUpdateEntity).create({
          id: uid('pu'),
          workspaceId,
          projectId,
          health: input.health,
          body: input.body.trim(),
          author: ctx.actor,
          aiDrafted: input.aiDrafted ?? false,
          createdAt: new Date(),
          editedAt: null,
        }),
      );
      await this.syncProject(m, workspaceId, projectId);
      return saved;
    });
    await this.announce(
      ctx.workspace.id,
      ctx.actor,
      'project_update.created',
      row,
    );
    return row;
  }

  /** `manageProjects`, or the author. Changing the health or the body marks the update as edited. */
  async update(
    ctx: WorkspaceContext,
    projectId: string,
    id: string,
    patch: ProjectUpdateInput,
  ) {
    const workspaceId = ctx.workspace.id;
    const row = await this.get(workspaceId, projectId, id);
    this.assertCanChange(ctx, row);
    const fields: string[] = [];
    if (patch.health !== undefined && patch.health !== row.health) {
      row.health = patch.health;
      fields.push('health');
    }
    if (patch.body !== undefined && patch.body.trim() !== row.body) {
      row.body = patch.body.trim();
      fields.push('body');
    }
    if (!fields.length) return row;
    row.editedAt = new Date();
    await this.ds.transaction(async (m) => {
      await m.getRepository(ProjectUpdateEntity).save(row);
      await this.syncProject(m, workspaceId, projectId);
    });
    await this.announce(workspaceId, ctx.actor, 'project_update.updated', row, {
      fields,
    });
    return row;
  }

  /** `manageProjects`, or the author. The project falls back to the newest remaining update. */
  async remove(ctx: WorkspaceContext, projectId: string, id: string) {
    const workspaceId = ctx.workspace.id;
    const row = await this.get(workspaceId, projectId, id);
    this.assertCanChange(ctx, row);
    await this.ds.transaction(async (m) => {
      await m.query(
        `DELETE FROM "comments" WHERE "workspaceId" = $1 AND "subject"->>'id' = $2`,
        [workspaceId, id],
      );
      await m.getRepository(ProjectUpdateEntity).delete({ id });
      await this.syncProject(m, workspaceId, projectId);
    });
    await this.announce(workspaceId, ctx.actor, 'project_update.deleted', row);
  }

  private assertCanChange(ctx: WorkspaceContext, row: ProjectUpdateEntity) {
    if (!sameActor(row.author, ctx.actor) && !canDo(ctx, 'manageProjects'))
      throw new ForbiddenException(
        'Only the author or a role with "Manage projects" can change a project update',
      );
  }

  /** Project.health / lastUpdateAt always mirror the newest update (null when there is none). */
  private async syncProject(
    m: EntityManager,
    workspaceId: string,
    projectId: string,
  ) {
    const [latest] = await m.getRepository(ProjectUpdateEntity).find({
      where: { workspaceId, projectId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: 1,
    });
    await m.getRepository(ProjectEntity).update(
      { id: projectId, workspaceId },
      {
        health: latest?.health ?? null,
        lastUpdateAt: latest?.createdAt ?? null,
        updatedAt: new Date(),
      },
    );
  }

  private async announce(
    workspaceId: string,
    actor: ActorRef,
    type:
      | 'project_update.created'
      | 'project_update.updated'
      | 'project_update.deleted',
    row: ProjectUpdateEntity,
    extra: Record<string, unknown> = {},
  ) {
    await this.events.record({
      workspaceId,
      actor,
      type,
      subject: { type: 'project_update', id: row.id },
      data: { projectId: row.projectId, health: row.health, ...extra },
    });
    // the project's own health / lastUpdateAt changed: let other tabs refetch it
    this.events.publish(workspaceId, {
      type: 'updated',
      entity: 'project',
      id: row.projectId,
    });
  }
}
