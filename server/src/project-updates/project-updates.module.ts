import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ProjectEntity,
  ProjectUpdateEntity,
} from '../database/entities/index.js';
import { ProjectUpdatesController } from './project-updates.controller.js';
import { ProjectUpdatesService } from './project-updates.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ProjectEntity, ProjectUpdateEntity])],
  controllers: [ProjectUpdatesController],
  providers: [ProjectUpdatesService],
  exports: [ProjectUpdatesService],
})
export class ProjectUpdatesModule {}
