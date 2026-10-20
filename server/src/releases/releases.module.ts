import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ReleaseEntity,
  ReleasePipelineEntity,
} from '../database/entities/index.js';
import { IssuesModule } from '../issues/issues.module.js';
import {
  ReleasePipelinesController,
  ReleasesController,
} from './releases.controller.js';
import { ReleasesService } from './releases.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ReleasePipelineEntity, ReleaseEntity]),
    IssuesModule,
  ],
  controllers: [ReleasePipelinesController, ReleasesController],
  providers: [ReleasesService],
  exports: [ReleasesService],
})
export class ReleasesModule {}
