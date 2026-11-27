import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProjectEntity, ProjectUpdateEntity } from '../database/entities/index.js';
import { UploadsModule } from '../uploads/uploads.module.js';
import { ProjectUpdatesController } from './project-updates.controller.js';
import { ProjectUpdatesService } from './project-updates.service.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([ProjectEntity, ProjectUpdateEntity]),
    UploadsModule,
  ],
  controllers: [ProjectsController, ProjectUpdatesController],
  providers: [ProjectsService, ProjectUpdatesService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
