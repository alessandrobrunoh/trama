import { type AuthInfo, type WorkspaceContext } from '../auth/request-context.js';
import { SnapshotService } from './snapshot.service.js';
export declare class SnapshotController {
    private readonly service;
    constructor(service: SnapshotService);
    get(ctx: WorkspaceContext, auth: AuthInfo): Promise<{
        workspace: import("../database/entities/index.js").WorkspaceEntity;
        me: import("../database/entities/index.js").UserEntity;
        myRole: import("../contracts/domain.js").Role;
        users: import("../database/entities/index.js").UserEntity[];
        memberships: import("../database/entities/index.js").MembershipEntity[];
        agents: import("../database/entities/index.js").AgentEntity[];
        teams: import("../database/entities/index.js").TeamEntity[];
        repositories: import("../database/entities/index.js").RepositoryEntity[];
        workstreams: import("../database/entities/index.js").WorkstreamEntity[];
        executions: import("../database/entities/index.js").ExecutionEntity[];
        inputRequests: import("../database/entities/index.js").InputRequestEntity[];
        intake: import("../database/entities/index.js").IntakeItemEntity[];
        artifacts: import("../database/entities/index.js").ArtifactEntity[];
        decisions: import("../database/entities/index.js").DecisionEntity[];
        dependencies: import("../database/entities/index.js").DependencyEntity[];
        comments: import("../database/entities/index.js").CommentEntity[];
        events: import("../database/entities/index.js").DomainEventEntity[];
        attention: import("../contracts/domain.js").AttentionItem[];
        views: import("../database/entities/index.js").SavedViewEntity[];
        integrations: import("../database/entities/index.js").IntegrationConnectionEntity[];
    }>;
}
