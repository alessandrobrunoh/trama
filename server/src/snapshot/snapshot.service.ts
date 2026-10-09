import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { canDo, type WorkspaceContext } from '../auth/request-context.js';
import type { Role, SnapshotCommentsMode } from '../contracts/domain.js';
import { CommentsService } from '../comments/comments.service.js';
import { AttentionService } from '../attention/attention.service.js';
import { CustomersService } from '../customers/customers.service.js';
import {
  AgentEntity,
  ArtifactEntity,
  CustomerEntity,
  CustomerRequestEntity,
  DecisionEntity,
  DependencyEntity,
  DomainEventEntity,
  InputRequestEntity,
  IssueEntity,
  IntegrationConnectionEntity,
  MembershipEntity,
  MilestoneEntity,
  ProjectEntity,
  RepositoryEntity,
  TeamEntity,
  UserEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { ViewsService } from '../views/views.service.js';

export const SNAPSHOT_EVENTS = 500;

@Injectable()
export class SnapshotService {
  constructor(
    private readonly ds: DataSource,
    private readonly views: ViewsService,
    private readonly attention: AttentionService,
    private readonly customers: CustomersService,
    private readonly comments: CommentsService,
  ) {}

  /** Everything the client needs to boot a workspace (see WorkspaceSnapshot in contracts/domain.ts). */
  async build(ctx: WorkspaceContext, me: UserEntity, myRole: Role, opts: { comments?: SnapshotCommentsMode } = {}) {
    const slimComments = opts.comments === 'index';
    const workspaceId = ctx.workspace.id;
    const where = { workspaceId };
    const all = <T extends object>(e: new () => T, order?: Record<string, 'ASC' | 'DESC'>) =>
      this.ds.getRepository(e).find({ where: where as never, order: order as never });
    const memberships = await all(MembershipEntity, { createdAt: 'ASC' });
    const [users, agents, teams, repositories, projects, workstreams, milestones, inputRequests, issues, customers, customerRequests, artifacts, decisions, dependencies, comments, commentIndex, events, views, integrations, attention] =
      await Promise.all([
        this.ds.getRepository(UserEntity).findBy({ id: In(memberships.map((m) => m.userId)) }),
        all(AgentEntity, { createdAt: 'ASC' }),
        all(TeamEntity, { name: 'ASC' }),
        all(RepositoryEntity, { fullName: 'ASC' }),
        all(ProjectEntity, { name: 'ASC' }),
        all(WorkstreamEntity, { createdAt: 'ASC' }),
        all(MilestoneEntity, { sortOrder: 'ASC', createdAt: 'ASC' }),
        all(InputRequestEntity, { createdAt: 'ASC' }),
        all(IssueEntity, { createdAt: 'ASC' }),
        all(CustomerEntity, { name: 'ASC' }),
        all(CustomerRequestEntity, { createdAt: 'ASC' }),
        all(ArtifactEntity, { createdAt: 'ASC' }),
        all(DecisionEntity, { number: 'ASC' }),
        all(DependencyEntity, { createdAt: 'ASC' }),
        slimComments ? Promise.resolve([]) : this.comments.listAll(workspaceId),
        slimComments ? this.comments.index(workspaceId) : Promise.resolve(undefined),
        this.ds.getRepository(DomainEventEntity).find({ where, order: { at: 'DESC', id: 'DESC' }, take: SNAPSHOT_EVENTS }),
        this.views.list(ctx),
        // account, baseUrl, status and lastError of the git connections are for whoever manages them
        // (same gate as GET /integrations); everyone else gets an empty list
        canDo(ctx, 'manageIntegrations')
          ? this.ds.getRepository(IntegrationConnectionEntity).find({ where, order: { createdAt: 'ASC' } })
          : Promise.resolve([]),
        this.attention.forUser(ctx),
      ]);
    return {
      workspace: ctx.workspace,
      me,
      myRole,
      users,
      memberships,
      agents,
      teams,
      repositories,
      projects: await this.customers.attachProjectCounts(workspaceId, projects),
      workstreams,
      milestones,
      inputRequests,
      issues: await this.customers.attachCounts(workspaceId, issues),
      customers,
      customerRequests,
      artifacts,
      decisions,
      dependencies,
      comments,
      ...(commentIndex ? { commentIndex } : {}),
      events,
      attention,
      views,
      integrations,
    };
  }
}
