import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { ArtifactsModule } from './artifacts/artifacts.module.js';
import { AttentionModule } from './attention/attention.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CommentsModule } from './comments/comments.module.js';
import { CommonModule } from './common/common.module.js';
import { DatabaseModule } from './database/database.module.js';
import { EventsModule } from './events/events.module.js';
import { requestStoreMiddleware } from './events/request-store.js';
import { FavoritesModule } from './favorites/favorites.module.js';
import { HealthController } from './health/health.controller.js';
import { PublicConfigController } from './public-config.controller.js';
import { ImportersModule } from './importers/importers.module.js';
import { LunagestModule } from './lunagest/lunagest.module.js';
import { InsightsModule } from './insights/insights.module.js';
import { InvitesModule } from './invites/invites.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { IssuesModule } from './issues/issues.module.js';
import { MailModule } from './mail/mail.module.js';
import { MilestonesModule } from './milestones/milestones.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { SearchModule } from './search/search.module.js';
import { SnapshotModule } from './snapshot/snapshot.module.js';
import { TimeEntriesModule } from './time-entries/time-entries.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { ViewsModule } from './views/views.module.js';
import { OutgoingWebhooksModule } from './outgoing-webhooks/outgoing-webhooks.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';

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
    TimeEntriesModule,
    ProjectsModule,
    IssuesModule,
    MilestonesModule,
    ArtifactsModule,
    UploadsModule,
    CommentsModule,
    ViewsModule,
    AttentionModule,
    InsightsModule,
    SearchModule,
    AiModule,
    SnapshotModule,
    IntegrationsModule,
    ImportersModule,
    LunagestModule,
    WebhooksModule,
    OutgoingWebhooksModule,
  ],
  controllers: [HealthController, PublicConfigController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestStoreMiddleware).forRoutes('*path');
  }
}
