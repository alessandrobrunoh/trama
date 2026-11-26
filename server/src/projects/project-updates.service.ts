import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { canDo, type WorkspaceContext } from '../auth/request-context.js';
import {
  PROJECT_UPDATE_BODY_MAX,
  type CreateProjectUpdateInput,
  type UpdateProjectUpdateInput,
} from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import { ProjectUpdateEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { sameActor } from '../uploads/upload-rules.js';
import { ProjectsService } from './projects.service.js';

/** How many updates `GET /projects/:id/updates` returns (the newest ones). */
export const PROJECT_UPDATES_LIST_MAX = 200;

/** Trimmed, 1 to PROJECT_UPDATE_BODY_MAX characters. */
function cleanBody(value: string): string {
  const body = value.trim();
  if (!body) throw new BadRequestException('An update needs some text');
  if (body.length > PROJECT_UPDATE_BODY_MAX)
    throw new BadRequestException(
      `An update can have at most ${PROJECT_UPDATE_BODY_MAX} characters`,
    );
  return body;
}

@Injectable()
export class ProjectUpdatesService {
  constructor(
    @InjectRepository(ProjectUpdateEntity)
    private readonly repo: Repository<ProjectUpdateEntity>,
    private readonly projects: ProjectsService,
    private readonly events: EventsService,
  ) {}

  /** The updates of one project, newest first. A project the caller cannot see is a 404. */
  async list(workspaceId: string, projectId: string): Promise<ProjectUpdateEntity[]> {
    await this.projects.get(workspaceId, projectId);
    return this.repo.find({
      where: { workspaceId, projectId },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: PROJECT_UPDATES_LIST_MAX,
    });
  }

  /** Posts an update. Reporting a health also sets the project's health (through ProjectsService.update). */
  async create(
    ctx: WorkspaceContext,
    projectId: string,
    input: CreateProjectUpdateInput,
  ): Promise<ProjectUpdateEntity> {
    const workspaceId = ctx.workspace.id;
    const project = await this.projects.get(workspaceId, projectId);
    const body = cleanBody(input.body);
    const health =
      input.health == null ? null : await this.projects.resolveHealth(workspaceId, input.health);
    const row = await this.repo.save(
      this.repo.create({
        id: uid('pu'),
        workspaceId,
        projectId,
        author: ctx.actor,
        body,
        health,
        editedAt: null,
      }),
    );
    if (health && health !== project.health)
      await this.projects.update(workspaceId, ctx.actor, projectId, { health });
    await this.events.record(
      {
        workspaceId,
        actor: ctx.actor,
        type: 'project.update_posted',
        subject: { type: 'project', id: projectId },
        data: { updateId: row.id, excerpt: body.slice(0, 200), health },
      },
      { type: 'created', entity: 'project_update', id: row.id },
    );
    return row;
  }

  /**
   * Edits the text and/or the reported health of an update. Only its author may. The project's own
   * health is not touched: only posting an update sets it.
   */
  async update(
    ctx: WorkspaceContext,
    projectId: string,
    updateId: string,
    patch: UpdateProjectUpdateInput,
  ): Promise<ProjectUpdateEntity> {
    const workspaceId = ctx.workspace.id;
    await this.projects.get(workspaceId, projectId);
    const row = await this.find(workspaceId, projectId, updateId);
    if (!sameActor(row.author, ctx.actor))
      throw new ForbiddenException('Only the author can edit an update');
    let changed = false;
    if (patch.body !== undefined) {
      const body = cleanBody(patch.body);
      if (body !== row.body) {
        row.body = body;
        changed = true;
      }
    }
    if (patch.health !== undefined) {
      const health =
        patch.health === null
          ? null
          : await this.projects.resolveHealth(workspaceId, patch.health);
      if (health !== row.health) {
        row.health = health;
        changed = true;
      }
    }
    if (!changed) return row;
    row.editedAt = new Date();
    await this.repo.save(row);
    this.events.publish(
      workspaceId,
      { type: 'updated', entity: 'project_update', id: row.id },
      undefined,
      { type: 'project', id: projectId },
    );
    return row;
  }

  /** The author, or anyone who can manage projects, removes an update. */
  async remove(ctx: WorkspaceContext, projectId: string, updateId: string): Promise<void> {
    const workspaceId = ctx.workspace.id;
    await this.projects.get(workspaceId, projectId);
    const row = await this.find(workspaceId, projectId, updateId);
    if (!sameActor(row.author, ctx.actor) && !canDo(ctx, 'manageProjects'))
      throw new ForbiddenException('Only the author or someone who manages projects can delete an update');
    await this.repo.delete({ id: row.id });
    this.events.publish(
      workspaceId,
      { type: 'deleted', entity: 'project_update', id: row.id },
      undefined,
      { type: 'project', id: projectId },
    );
  }

  private async find(
    workspaceId: string,
    projectId: string,
    updateId: string,
  ): Promise<ProjectUpdateEntity> {
    const row = await this.repo.findOneBy({ workspaceId, projectId, id: updateId });
    if (!row) throw notFound('Project update', updateId);
    return row;
  }
}
