import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { IntegrationConnectionEntity, RepositoryEntity } from '../database/entities/index.js';
import { RepositoriesModule } from '../repositories/repositories.module.js';
import { ArtifactLinkerService } from './artifact-linker.service.js';
import { FetchHttpClient, HttpClient } from './http-client.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { SecretsService } from './secrets.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([IntegrationConnectionEntity, RepositoryEntity]), ArtifactsModule, RepositoriesModule],
  controllers: [IntegrationsController],
  providers: [{ provide: HttpClient, useClass: FetchHttpClient }, SecretsService, IntegrationsService, ArtifactLinkerService],
  exports: [HttpClient, SecretsService, IntegrationsService, ArtifactLinkerService],
})
export class IntegrationsModule {}
