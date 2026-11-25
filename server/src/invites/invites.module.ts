import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  InviteEntity,
  MembershipEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { InviteLinksController, WorkspaceInvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';
import { ProjectSharingController } from './project-sharing.controller.js';
import { ProjectSharingService } from './project-sharing.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([InviteEntity, WorkspaceEntity, UserEntity, MembershipEntity]), ProjectsModule],
  controllers: [WorkspaceInvitesController, InviteLinksController, ProjectSharingController],
  providers: [InvitesService, ProjectSharingService],
})
export class InvitesModule {}
