import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IssueEntity } from '../database/entities/index.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import {
  LunaGestConnectionEntity,
  LunaGestIssueLinkEntity,
  LunaGestProjectLinkEntity,
} from './entities.js';
import {
  LunaGestConnectionController,
  LunaGestIssueController,
  LunaGestProjectController,
} from './lunagest.controller.js';
import { LunagestService } from './lunagest.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      LunaGestConnectionEntity,
      LunaGestProjectLinkEntity,
      LunaGestIssueLinkEntity,
      IssueEntity,
    ]),
    IntegrationsModule,
    ProjectsModule,
  ],
  controllers: [
    LunaGestConnectionController,
    LunaGestProjectController,
    LunaGestIssueController,
  ],
  providers: [LunagestService],
  exports: [LunagestService],
})
export class LunagestModule {}
