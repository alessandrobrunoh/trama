var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
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
import { ExecutionsModule } from './executions/executions.module.js';
import { GraphModule } from './graph/graph.module.js';
import { HealthController } from './health/health.controller.js';
import { InputRequestsModule } from './input-requests/input-requests.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { IntakeModule } from './intake/intake.module.js';
import { RepositoriesModule } from './repositories/repositories.module.js';
import { SearchModule } from './search/search.module.js';
import { SnapshotModule } from './snapshot/snapshot.module.js';
import { StatusModule } from './status/status.module.js';
import { TeamsModule } from './teams/teams.module.js';
import { ViewsModule } from './views/views.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { WorkstreamsModule } from './workstreams/workstreams.module.js';
let AppModule = class AppModule {
    configure(consumer) {
        consumer.apply(requestStoreMiddleware).forRoutes('*path');
    }
};
AppModule = __decorate([
    Module({
        imports: [
            DatabaseModule,
            CommonModule,
            EventsModule,
            AuthModule,
            WorkspacesModule,
            TeamsModule,
            RepositoriesModule,
            WorkstreamsModule,
            ExecutionsModule,
            InputRequestsModule,
            IntakeModule,
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
], AppModule);
export { AppModule };
//# sourceMappingURL=app.module.js.map