import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, type Repository } from 'typeorm';
import type { ProjectPlacement, SharedProject } from '../contracts/domain.js';
import { notFound, uid } from '../common/util.js';
import {
  MembershipEntity,
  ProjectEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
import { ProjectPlacementEntity } from './project-placement.entity.js';
import { limitedProjectIds } from './project-transfer-plan.js';

/**
 * "Shared with me" and "Show in". A project is shared with a person when they belong to its workspace through
 * a membership limited to some projects (a guest). The project never leaves its workspace: a placement is a
 * per-person link, it grants nobody anything, and every read of the project still goes through the original
 * workspace's permission checks. A placement whose person lost their access stops being listed.
 */
@Injectable()
export class SharingService {
  constructor(
    private readonly events: EventsService,
    @InjectRepository(ProjectPlacementEntity)
    private readonly placements: Repository<ProjectPlacementEntity>,
    @InjectRepository(MembershipEntity)
    private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projects: Repository<ProjectEntity>,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaces: Repository<WorkspaceEntity>,
  ) {}

  /** Every project the person reaches as a guest, with where (if anywhere) they chose to show it. */
  async list(userId: string): Promise<SharedProject[]> {
    const rows = await this.guestRows(userId);
    if (!rows.length) return [];
    const placements = new Map(
      (await this.placements.findBy({ userId })).map((row) => [row.projectId, row]),
    );
    const out: SharedProject[] = [];
    for (const { workspace, membership, projects } of rows) {
      for (const project of projects) {
        const placement = placements.get(project.id);
        out.push({
          id: project.id,
          name: project.name,
          key: project.key,
          color: project.color,
          ...(project.icon ? { icon: project.icon } : {}),
          workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
          role: membership.role,
          ...(placement ? { placement: toPlacement(placement) } : {}),
        });
      }
    }
    return out;
  }

  /** Show a shared project in one of the person's own workspaces (or move it between them). */
  async place(
    userId: string,
    projectId: string,
    workspaceId: string,
    position?: number,
  ): Promise<ProjectPlacement> {
    const shared = await this.sharedProject(userId, projectId);
    if (shared.workspace.id === workspaceId)
      throw new BadRequestException('The project already lives in that workspace');
    // a person can only place it in a workspace they belong to; anything else looks like it does not exist
    if (!(await this.memberships.existsBy({ workspaceId, userId }))) throw notFound('Workspace', workspaceId);
    const next = position ?? (await this.nextPosition(userId, workspaceId));
    return this.save(userId, projectId, workspaceId, next);
  }

  /** "Hide from Shared with me": the project is listed nowhere until the placement is cleared. */
  async hide(userId: string, projectId: string): Promise<ProjectPlacement> {
    await this.sharedProject(userId, projectId);
    return this.save(userId, projectId, null, 0);
  }

  /** Back to Shared with me. Only ever touches the caller's own row. */
  async clear(userId: string, projectId: string): Promise<void> {
    await this.placements.delete({ userId, projectId });
  }

  /**
   * Leave the project: the person's guest access to it is removed from the workspace's membership. A guest
   * left with nothing loses the membership altogether. Their own placement goes with it.
   */
  async leave(userId: string, projectId: string): Promise<void> {
    const shared = await this.sharedProject(userId, projectId);
    const membership = await this.memberships.findOneBy({ workspaceId: shared.workspace.id, userId });
    if (!membership) throw notFound('Project', projectId);
    const access = membership.access;
    const remaining = (access?.projects.projectIds ?? []).filter((id) => id !== projectId);
    if (membership.role === 'guest' && !remaining.length && !access?.includeUnassigned) {
      await this.memberships.delete({ id: membership.id });
      this.events.publish(shared.workspace.id, { type: 'deleted', entity: 'membership', id: membership.id });
    } else if (access) {
      membership.access = { ...access, projects: { all: false, projectIds: remaining } };
      await this.memberships.save(membership);
      this.events.publish(shared.workspace.id, { type: 'updated', entity: 'membership', id: membership.id });
    }
    await this.placements.delete({ userId, projectId });
  }

  // ───────── internals

  private async sharedProject(userId: string, projectId: string): Promise<SharedProject> {
    const found = (await this.list(userId)).find((project) => project.id === projectId);
    // not shared with this person: indistinguishable from a project that does not exist
    if (!found) throw notFound('Project', projectId);
    return found;
  }

  /** Workspaces where the person is limited to some projects, with the projects they can really see. */
  private async guestRows(userId: string): Promise<
    { workspace: WorkspaceEntity; membership: MembershipEntity; projects: ProjectEntity[] }[]
  > {
    const memberships = await this.memberships.findBy({ userId });
    if (!memberships.length) return [];
    const workspaces = new Map(
      (await this.workspaces.findBy({ id: In(memberships.map((m) => m.workspaceId)) })).map((ws) => [ws.id, ws]),
    );
    const rows: { workspace: WorkspaceEntity; membership: MembershipEntity; projects: ProjectEntity[] }[] = [];
    for (const membership of memberships) {
      const workspace = workspaces.get(membership.workspaceId);
      if (!workspace) continue;
      const ids = limitedProjectIds(workspace.resolved().roles, membership);
      if (!ids?.length) continue;
      const projects = await this.projects.find({
        where: { workspaceId: workspace.id, id: In(ids) },
        order: { name: 'ASC' },
      });
      if (projects.length) rows.push({ workspace, membership, projects });
    }
    rows.sort((a, b) => a.workspace.name.localeCompare(b.workspace.name));
    return rows;
  }

  private async nextPosition(userId: string, workspaceId: string): Promise<number> {
    const row = await this.placements
      .createQueryBuilder('p')
      .select('MAX(p.position)', 'max')
      .where('p.userId = :userId AND p.workspaceId = :workspaceId', { userId, workspaceId })
      .getRawOne<{ max: number | null }>();
    return (row?.max ?? -1) + 1;
  }

  private async save(
    userId: string,
    projectId: string,
    workspaceId: string | null,
    position: number,
  ): Promise<ProjectPlacement> {
    // one row per person and project: a repeated or racing request replaces it instead of failing
    await this.placements.upsert(
      { id: uid('pp'), userId, projectId, workspaceId, position },
      { conflictPaths: ['userId', 'projectId'], skipUpdateIfNoValuesChanged: false },
    );
    return { projectId, workspaceId, position };
  }
}

function toPlacement(row: ProjectPlacementEntity): ProjectPlacement {
  return { projectId: row.projectId, workspaceId: row.workspaceId, position: row.position };
}
