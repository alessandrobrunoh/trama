import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MembershipEntity, ProjectEntity, WorkspaceEntity } from '../database/entities/index.js';
import { ProjectTransferController } from './project-transfer.controller.js';
import { ProjectTransferService } from './project-transfer.service.js';
import { ProjectPlacementEntity } from './project-placement.entity.js';
import { SharingController } from './sharing.controller.js';
import { SharingService } from './sharing.service.js';

/** Shared with me, "Show in" placements, and moving a project between workspaces. */
@Module({
  imports: [TypeOrmModule.forFeature([ProjectPlacementEntity, MembershipEntity, ProjectEntity, WorkspaceEntity])],
  controllers: [SharingController, ProjectTransferController],
  providers: [SharingService, ProjectTransferService],
  exports: [SharingService],
})
export class SharingModule {}
