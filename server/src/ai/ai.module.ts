import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DecisionEntity,
  IssueEntity,
  RepositoryEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { AiConfig } from './ai.config.js';
import { AiController } from './ai.controller.js';
import { AiService } from './ai.service.js';
import { AiProvider, ChatCompletionsProvider } from './ai-provider.js';
import { AiContextService } from './ai-context.service.js';
import { GrokBuildService } from './grok-build.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IssueEntity,
      WorkstreamEntity,
      RepositoryEntity,
      DecisionEntity,
    ]),
  ],
  controllers: [AiController],
  providers: [
    AiConfig,
    AiService,
    AiContextService,
    GrokBuildService,
    { provide: AiProvider, useClass: ChatCompletionsProvider },
  ],
})
export class AiModule {}
