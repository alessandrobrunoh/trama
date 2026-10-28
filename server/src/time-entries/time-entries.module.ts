import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IssueEntity } from '../database/entities/index.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { TimeEntriesController } from './time-entries.controller.js';
import { TimeEntriesService } from './time-entries.service.js';
import { TimeEntryEntity } from './time-entry.entity.js';

@Module({
  imports: [TypeOrmModule.forFeature([TimeEntryEntity, IssueEntity]), ProjectsModule],
  controllers: [TimeEntriesController],
  providers: [TimeEntriesService],
})
export class TimeEntriesModule {}
