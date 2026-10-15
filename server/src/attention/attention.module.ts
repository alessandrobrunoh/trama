import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ArtifactEntity,
  AttentionStateEntity,
  DecisionEntity,
  InputRequestEntity,
  IssueEntity,
} from '../database/entities/index.js';
import { AttentionController } from './attention.controller.js';
import { AttentionService } from './attention.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IssueEntity,
      InputRequestEntity,
      DecisionEntity,
      ArtifactEntity,
      AttentionStateEntity,
    ]),
  ],
  controllers: [AttentionController],
  providers: [AttentionService],
  exports: [AttentionService],
})
export class AttentionModule {}
