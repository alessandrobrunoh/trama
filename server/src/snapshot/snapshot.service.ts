import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { AttentionService } from '../attention/attention.service.js';
import { canDo, type WorkspaceContext } from '../auth/request-context.js';
import { projectHidden, scopeSnapshot } from '../auth/member-access.js';
import { isProjectLimited, type Role, type SnapshotCommentsMode } from '../contracts/domain.js';
import { visibleMemberships } from '../workspaces/people-scope.js';
import { CommentsService } from '../comments/comments.service.js';
import {
  AgentEntity,
  ArtifactEntity,
  DomainEventEntity,
  IssueEntity,
  IntegrationConnectionEntity,
  MembershipEntity,
  MilestoneEntity,
  ProjectEntity,
  UserEntity,
} from '../database/entities/index.js';
import { ViewsService } from '../views/views.service.js';
import { EventVisibilityService } from '../events/event-visibility.service.js';

export const SNAPSHOT_EVENTS = 500;

@Injectable()
export class SnapshotService {
  constructor(
    private readonly ds: DataSource,
    private readonly views: ViewsService,
    private readonly comments: CommentsService,
    private readonly attention: AttentionService,
    private readonly eventVisibility: EventVisibilityService,
  ) {}

  /** Everything the client needs to boot a workspace (see WorkspaceSnapshot in contracts/domain.ts). */
  async build(
    ctx: WorkspaceContext,
    me: UserEntity,
    myRole: Role,
    opts: { comments?: SnapshotCommentsMode } = {},
  ) {
    const slimComments = opts.comments === 'index';
    const workspaceId = ctx.workspace.id;
    const where = { workspaceId };
    const all = <T extends object>(
      e: new () => T,
      order?: Record<string, 'ASC' | 'DESC'>,
    ) =>
      this.ds
        .getRepository(e)
        .find({ where: where as never, order: order as never });
    const memberships = await all(MembershipEntity, { createdAt: 'ASC' });
    const [
      users,
      agents,
      projects,
      milestones,
      issues,
      artifacts,
      comments,
      commentIndex,
      events,
      views,
      integrations,
    ] = await Promise.all([
      this.ds
        .getRepository(UserEntity)
        .findBy({ id: In(memberships.map((m) => m.userId)) }),
      all(AgentEntity, { createdAt: 'ASC' }),
      all(ProjectEntity, { name: 'ASC' }),
      all(MilestoneEntity, { sortOrder: 'ASC', createdAt: 'ASC' }),
      all(IssueEntity, { createdAt: 'ASC' }),
      all(ArtifactEntity, { createdAt: 'ASC' }),
      slimComments ? Promise.resolve([]) : this.comments.listAll(workspaceId),
      slimComments
        ? this.comments.index(workspaceId)
        : Promise.resolve(undefined),
      this.ds.getRepository(DomainEventEntity).find({
        where,
        order: { at: 'DESC', id: 'DESC' },
        take: SNAPSHOT_EVENTS,
      }),
      this.views.list(ctx),
      // account, baseUrl, status and lastError of the git connections are for whoever manages them
      // (same gate as GET /integrations); everyone else gets an empty list
      canDo(ctx, 'manageIntegrations')
        ? this.ds
            .getRepository(IntegrationConnectionEntity)
            .find({ where, order: { createdAt: 'ASC' } })
        : Promise.resolve([]),
    ]);
    const attention = await this.attention.list(workspaceId, me.id, {
      issues,
      artifacts,
    });
    const visibleEvents = await this.eventVisibility.filterEvents(
      workspaceId,
      events,
      ctx.access,
    );
    // A guest, or a member limited to some projects, only meets the people and agents of those projects.
    const limited = isProjectLimited(ctx.access);
    const visibleMembers = visibleMemberships(
      memberships,
      ctx.workspace.resolved().roles,
      ctx.access,
      ctx.userId,
    );
    const visibleUserIds = new Set(visibleMembers.map((m) => m.userId));
    const assignedIds = limited
      ? new Set(
          issues
            .filter((issue) => !projectHidden(ctx.access, issue.projectId))
            .map((issue) => issue.assigneeId),
        )
      : null;
    const built = {
      workspace: ctx.workspace,
      me,
      myRole,
      users: limited ? users.filter((user) => visibleUserIds.has(user.id)) : users,
      memberships: visibleMembers,
      agents: assignedIds ? agents.filter((agent) => assignedIds.has(agent.id)) : agents,
      projects,
      milestones,
      issues,
      artifacts,
      comments,
      ...(commentIndex ? { commentIndex } : {}),
      events: visibleEvents,
      attention,
      views,
      integrations,
    };
    return scopeSnapshot(built, ctx.access ?? null);
  }
}
