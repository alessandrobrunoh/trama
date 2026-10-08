import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AgentContextModule } from './agent-context/agent-context.module.js';
import { ArtifactsModule } from './artifacts/artifacts.module.js';
import { AttentionModule } from './attention/attention.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommentsModule } from './comments/comments.module.js';
import { CommonModule } from './common/common.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DecisionsModule } from './decisions/decisions.module.js';
import { DependenciesModule } from './dependencies/dependencies.module.js';
import { EventsModule } from './events/events.module.js';
import { requestStoreMiddleware } from './events/request-store.js';
import { GraphModule } from './graph/graph.module.js';
import { HealthController } from './health/health.controller.js';
import { InputRequestsModule } from './input-requests/input-requests.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { IssuesModule } from './issues/issues.module.js';
import { RepositoriesModule } from './repositories/repositories.module.js';
import { SearchModule } from './search/search.module.js';
import { SnapshotModule } from './snapshot/snapshot.module.js';
import { StatusModule } from './status/status.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { ViewsModule } from './views/views.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { WorkstreamsModule } from './workstreams/workstreams.module.js';

@Module({
  imports: [
    DatabaseModule,
    CommonModule,
    EventsModule,
    AuthModule,
    WorkspacesModule,
    TeamsModule,
    RepositoriesModule,
    WorkstreamsModule,
    InputRequestsModule,
    IssuesModule,
    ArtifactsModule,
    DecisionsModule,
    DependenciesModule,
    CommentsModule,
    ViewsModule,
    StatusModule,
    AttentionModule,
    GraphModule,
    SearchModule,
    AgentContextModule,
    SnapshotModule,
    IntegrationsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestStoreMiddleware).forRoutes('*path');
  }
}
