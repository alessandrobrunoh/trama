import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ArtifactsModule } from '../artifacts/artifacts.module.js';
import { IssuesModule } from '../issues/issues.module.js';
import { DecisionsController, ThreadsController } from './threads.controller.js';
import { ThreadsService } from './threads.service.js';
import { THREAD_ENTITIES } from './thread.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature(THREAD_ENTITIES), IssuesModule, ArtifactsModule],
  controllers: [ThreadsController, DecisionsController],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
