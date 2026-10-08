import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  InviteEntity,
  MembershipEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { InviteLinksController, WorkspaceInvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([InviteEntity, WorkspaceEntity, UserEntity, MembershipEntity])],
  controllers: [WorkspaceInvitesController, InviteLinksController],
  providers: [InvitesService],
})
export class InvitesModule {}
