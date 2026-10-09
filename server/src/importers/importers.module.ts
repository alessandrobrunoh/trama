import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationConnectionEntity } from '../database/entities/index.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { IssuesModule } from '../issues/issues.module.js';
import { MilestonesModule } from '../milestones/milestones.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { TeamsModule } from '../teams/teams.module.js';
import { CredentialsService } from './credentials.service.js';
import { ImportJobEntity, ImportLinkEntity, TrackerCredentialEntity } from './entities.js';
import { ExternalLinksService } from './external-links.service.js';
import { ImportRunnerService } from './import-runner.service.js';
import { ImportsController, IssueExternalRefController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ImportJobEntity, ImportLinkEntity, TrackerCredentialEntity, IntegrationConnectionEntity]),
    IntegrationsModule,
    IssuesModule,
    TeamsModule,
    ProjectsModule,
    MilestonesModule,
  ],
  controllers: [ImportsController, IssueExternalRefController],
  providers: [CredentialsService, ImportRunnerService, ImportsService, ExternalLinksService],
})
export class ImportersModule {}
