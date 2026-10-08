import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { hasRole, type AppRequest, type WorkspaceContext } from '../auth/request-context.js';
import { AgentEntity, IssueEntity, TeamEntity, WorkstreamEntity } from '../database/entities/index.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Team-level edit policy (`Team.editPolicy`): who may change the workstreams / issues a team owns.
 *  - `workspace`: anyone who passed the workspace role check;
 *  - `members`: workspace admins/owners, the team's members and leads (an agent counts when its owner is on the team).
 */
@Injectable()
export class PermissionsService {
  constructor(
    @InjectRepository(TeamEntity) private readonly teams: Repository<TeamEntity>,
    @InjectRepository(AgentEntity) private readonly agents: Repository<AgentEntity>,
    @InjectRepository(WorkstreamEntity) private readonly workstreams: Repository<WorkstreamEntity>,
    @InjectRepository(IssueEntity) private readonly issues: Repository<IssueEntity>,
  ) {}

  /** Is the caller on the team (member or lead)? Agents count through their owner. */
  async isOnTeam(ctx: WorkspaceContext, team: Pick<TeamEntity, 'memberIds' | 'leadIds'>): Promise<boolean> {
    let userId = ctx.userId;
    if (!userId && ctx.actor.type === 'agent' && ctx.actor.id) {
      userId = (await this.agents.findOneBy({ id: ctx.actor.id, workspaceId: ctx.workspace.id }))?.ownerUserId ?? undefined;
    }
    return !!userId && (team.memberIds.includes(userId) || team.leadIds.includes(userId));
  }

  async isLead(ctx: WorkspaceContext, team: Pick<TeamEntity, 'leadIds'>): Promise<boolean> {
    return !!ctx.userId && team.leadIds.includes(ctx.userId);
  }

  async canEditTeamWork(ctx: WorkspaceContext, team: TeamEntity): Promise<boolean> {
    if (team.editPolicy !== 'members') return true;
    if (hasRole(ctx.role, 'admin')) return true;
    return this.isOnTeam(ctx, team);
  }

  /** 403 when the team restricts editing to its members and the caller is not one. Unknown / null team ids pass. */
  async assertTeamEdit(ctx: WorkspaceContext, teamId: string | null | undefined): Promise<void> {
    if (!teamId) return;
    const team = await this.teams.findOneBy({ id: teamId, workspaceId: ctx.workspace.id });
    if (!team) return;
    if (!(await this.canEditTeamWork(ctx, team)))
      throw new ForbiddenException(`Team ${team.key} only lets its members and leads edit its work`);
  }

  /**
   * Called by AccessGuard for routes marked `@EditsTeamWork(kind)`: resolves the team(s) the request
   * touches (the current owner team and the one it moves to) and enforces their edit policy.
   */
  async enforceTeamScope(kind: 'workstream' | 'issue', req: AppRequest, ctx: WorkspaceContext): Promise<void> {
    if (SAFE_METHODS.has(req.method)) return;
    const params = req.params as Record<string, string | undefined>;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ids = new Set<string>();
    const idOrKey = str(params.idOrKey);
    if (kind === 'workstream') {
      if (idOrKey) {
        const ws = await this.workstreams.findOne({
          where: [
            { workspaceId: ctx.workspace.id, id: idOrKey },
            { workspaceId: ctx.workspace.id, key: idOrKey.toUpperCase() },
          ],
        });
        if (ws) ids.add(ws.ownerTeamId);
      }
      const next = str(body.ownerTeamId);
      if (next) ids.add(next);
    } else {
      if (idOrKey) {
        const issue = await this.issues
          .createQueryBuilder('i')
          .where('i.workspaceId = :w AND (i.id = :k OR i.key = :ku OR i.aliases @> :alias::jsonb)', {
            w: ctx.workspace.id,
            k: idOrKey,
            ku: idOrKey.toUpperCase(),
            alias: JSON.stringify([idOrKey.toUpperCase()]),
          })
          .getOne();
        if (issue?.teamId) ids.add(issue.teamId);
      }
      const next = str(body.teamId);
      if (next) ids.add(next);
      const create = body.createWorkstream as Record<string, unknown> | undefined;
      const created = create && typeof create === 'object' ? str(create.ownerTeamId) : undefined;
      if (created) ids.add(created);
    }
    for (const id of ids) await this.assertTeamEdit(ctx, id);
  }
}
