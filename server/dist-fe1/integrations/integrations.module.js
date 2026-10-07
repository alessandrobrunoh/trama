var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
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
let IntegrationsModule = class IntegrationsModule {
};
IntegrationsModule = __decorate([
    Module({
        imports: [TypeOrmModule.forFeature([IntegrationConnectionEntity, RepositoryEntity]), ArtifactsModule, RepositoriesModule],
        controllers: [IntegrationsController],
        providers: [{ provide: HttpClient, useClass: FetchHttpClient }, SecretsService, IntegrationsService, ArtifactLinkerService],
        exports: [HttpClient, SecretsService, IntegrationsService, ArtifactLinkerService],
    })
], IntegrationsModule);
export { IntegrationsModule };
//# sourceMappingURL=integrations.module.js.map