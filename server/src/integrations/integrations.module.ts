import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { IntegrationConnectionEntity, MembershipEntity, UserEntity, WorkspaceEntity } from '../database/entities/index.js';
import { ExternalIdentitiesModule } from '../external-identities/external-identities.module.js';
import { ArtifactLinkerService } from './artifact-linker.service.js';
import { ConnectionsService } from './connections.service.js';
import { FetchHttpClient, HttpClient } from './http-client.js';
import { IntegrationsController, MyConnectionsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { SecretsService } from './secrets.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([IntegrationConnectionEntity, MembershipEntity, UserEntity, WorkspaceEntity]),
    ArtifactsModule,
    ExternalIdentitiesModule,
  ],
  controllers: [IntegrationsController, MyConnectionsController],
  providers: [{ provide: HttpClient, useClass: FetchHttpClient }, SecretsService, IntegrationsService, ConnectionsService, ArtifactLinkerService],
  exports: [HttpClient, SecretsService, IntegrationsService, ConnectionsService, ArtifactLinkerService],
})
export class IntegrationsModule {}
