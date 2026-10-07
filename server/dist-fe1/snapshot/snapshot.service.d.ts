import { DataSource } from 'typeorm';
import type { WorkspaceContext } from '../auth/request-context.js';
import type { Role } from '../contracts/domain.js';
import { AttentionService } from '../attention/attention.service.js';
import { AgentEntity, ArtifactEntity, CommentEntity, DecisionEntity, DependencyEntity, DomainEventEntity, ExecutionEntity, InputRequestEntity, IntakeItemEntity, IntegrationConnectionEntity, MembershipEntity, RepositoryEntity, TeamEntity, UserEntity, WorkstreamEntity } from '../database/entities/index.js';
import { ExecutionsService } from '../executions/executions.service.js';
import { ViewsService } from '../views/views.service.js';
export declare const SNAPSHOT_EVENTS = 500;
export declare class SnapshotService {
    private readonly ds;
    private readonly executions;
    private readonly views;
    private readonly attention;
    constructor(ds: DataSource, executions: ExecutionsService, views: ViewsService, attention: AttentionService);
    build(ctx: WorkspaceContext, me: UserEntity, myRole: Role): Promise<{
        workspace: import("../database/entities/index.js").WorkspaceEntity;
        me: UserEntity;
        myRole: Role;
        users: UserEntity[];
        memberships: MembershipEntity[];
        agents: AgentEntity[];
        teams: TeamEntity[];
        repositories: RepositoryEntity[];
        workstreams: WorkstreamEntity[];
        executions: ExecutionEntity[];
        inputRequests: InputRequestEntity[];
        intake: IntakeItemEntity[];
        artifacts: ArtifactEntity[];
        decisions: DecisionEntity[];
        dependencies: DependencyEntity[];
        comments: CommentEntity[];
        events: DomainEventEntity[];
        attention: import("../contracts/domain.js").AttentionItem[];
        views: import("../database/entities/index.js").SavedViewEntity[];
        integrations: IntegrationConnectionEntity[];
    }>;
}
