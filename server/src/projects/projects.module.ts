import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectEntity } from '../database/entities/index.js';
import { ProjectContextController } from './project-context.controller.js';
import { ProjectContextService } from './project-context.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ProjectEntity])],
  controllers: [ProjectsController, ProjectContextController],
  providers: [ProjectsService, ProjectContextService],
  exports: [ProjectsService, ProjectContextService],
})
export class ProjectsModule {}
