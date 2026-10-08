import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AgentContextModule } from './agent-context/agent-context.module.js';
import { AiModule } from './ai/ai.module.js';
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
import { FavoritesModule } from './favorites/favorites.module.js';
import { GraphModule } from './graph/graph.module.js';
import { HealthController } from './health/health.controller.js';
import { InputRequestsModule } from './input-requests/input-requests.module.js';
import { InvitesModule } from './invites/invites.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { IssuesModule } from './issues/issues.module.js';
import { MailModule } from './mail/mail.module.js';
import { MilestonesModule } from './milestones/milestones.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RepositoriesModule } from './repositories/repositories.module.js';
import { SearchModule } from './search/search.module.js';
import { SnapshotModule } from './snapshot/snapshot.module.js';
import { StatusModule } from './status/status.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { ViewsModule } from './views/views.module.js';
import { OutgoingWebhooksModule } from './outgoing-webhooks/outgoing-webhooks.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { WorkstreamsModule } from './workstreams/workstreams.module.js';

@Module({
  imports: [
    DatabaseModule,
    CommonModule,
    MailModule,
    EventsModule,
    AuthModule,
    WorkspacesModule,
    InvitesModule,
    FavoritesModule,
    NotificationsModule,
    TeamsModule,
    RepositoriesModule,
    WorkstreamsModule,
    InputRequestsModule,
    IssuesModule,
    MilestonesModule,
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
    AiModule,
    SnapshotModule,
    IntegrationsModule,
    WebhooksModule,
    OutgoingWebhooksModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestStoreMiddleware).forRoutes('*path');
  }
}
