import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import type { Role } from '../contracts/domain.js';
import { AttentionService } from '../attention/attention.service.js';
import {
  AgentEntity,
  ArtifactEntity,
  CommentEntity,
  DecisionEntity,
  DependencyEntity,
  DomainEventEntity,
  ExecutionEntity,
  InputRequestEntity,
  IntakeItemEntity,
  IntegrationConnectionEntity,
  MembershipEntity,
  RepositoryEntity,
  TeamEntity,
  UserEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { ExecutionsService } from '../executions/executions.service.js';
import { ViewsService } from '../views/views.service.js';

export const SNAPSHOT_EVENTS = 500;

@Injectable()
export class SnapshotService {
  constructor(
    private readonly ds: DataSource,
    private readonly executions: ExecutionsService,
    private readonly views: ViewsService,
    private readonly attention: AttentionService,
  ) {}

  /** Everything the client needs to boot a workspace (see WorkspaceSnapshot in contracts/domain.ts). */
  async build(ctx: WorkspaceContext, me: UserEntity, myRole: Role) {
    const workspaceId = ctx.workspace.id;
    const where = { workspaceId };
    const all = <T extends object>(e: new () => T, order?: Record<string, 'ASC' | 'DESC'>) =>
      this.ds.getRepository(e).find({ where: where as never, order: order as never });
    const memberships = await all(MembershipEntity, { createdAt: 'ASC' });
    const [users, agents, teams, repositories, workstreams, executions, inputRequests, intake, artifacts, decisions, dependencies, comments, events, views, integrations, attention] =
      await Promise.all([
        this.ds.getRepository(UserEntity).findBy({ id: In(memberships.map((m) => m.userId)) }),
        all(AgentEntity, { createdAt: 'ASC' }),
        all(TeamEntity, { name: 'ASC' }),
        all(RepositoryEntity, { fullName: 'ASC' }),
        all(WorkstreamEntity, { createdAt: 'ASC' }),
        all(ExecutionEntity, { createdAt: 'ASC' }).then((rows) => this.executions.attach(workspaceId, rows)),
        all(InputRequestEntity, { createdAt: 'ASC' }),
        all(IntakeItemEntity, { createdAt: 'ASC' }),
        all(ArtifactEntity, { createdAt: 'ASC' }),
        all(DecisionEntity, { number: 'ASC' }),
        all(DependencyEntity, { createdAt: 'ASC' }),
        all(CommentEntity, { createdAt: 'ASC' }),
        this.ds.getRepository(DomainEventEntity).find({ where, order: { at: 'DESC', id: 'DESC' }, take: SNAPSHOT_EVENTS }),
        this.views.list(workspaceId, ctx.userId),
        this.ds.getRepository(IntegrationConnectionEntity).find({ where, order: { createdAt: 'ASC' } }),
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
      workstreams,
      executions,
      inputRequests,
      intake,
      artifacts,
      decisions,
      dependencies,
      comments,
      events,
      attention,
      views,
      integrations,
    };
  }
}
