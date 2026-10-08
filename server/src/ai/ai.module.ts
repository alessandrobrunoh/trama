import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DecisionEntity,
  DomainEventEntity,
  InputRequestEntity,
  IssueEntity,
  MilestoneEntity,
  ProjectEntity,
  RepositoryEntity,
  UserEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { AiConfig } from './ai.config.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AiProvider, ChatCompletionsProvider } from './ai-provider.js';
import { AiContextService } from './ai-context.service.js';
import { GrokBuildService } from './grok-build.service.js';
import { AssistantToolsService } from './assistant-tools.service.js';
import { ProjectAiController } from './project-ai.controller.js';
import { ProjectAiFactsService } from './project-ai-facts.service.js';
import { ProjectAiService } from './project-ai.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      IssueEntity,
      WorkstreamEntity,
      RepositoryEntity,
      DecisionEntity,
      ProjectEntity,
      MilestoneEntity,
      InputRequestEntity,
      DomainEventEntity,
      UserEntity,
    ]),
  ],
  controllers: [AiController, ProjectAiController],
  providers: [
    AiConfig,
    AiService,
    AiContextService,
    GrokBuildService,
    AssistantToolsService,
    ProjectAiFactsService,
    ProjectAiService,
    { provide: AiProvider, useClass: ChatCompletionsProvider },
  ],
})
export class AiModule {}
