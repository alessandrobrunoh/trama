import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import {
  AgentEntity,
  ApiTokenEntity,
  IssueEntity,
  MembershipEntity,
  TeamEntity,
  UserEntity,
  WorkspaceEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { AccessGuard } from './access.guard.js';
import { PermissionsService } from './permissions.service.js';
import {
  AgentsController,
  MembersController,
  TokensController,
  WorkspaceController,
  WorkspacesController,
} from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

@Global()
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      WorkspaceEntity,
      MembershipEntity,
      UserEntity,
      AgentEntity,
      ApiTokenEntity,
      TeamEntity,
      WorkstreamEntity,
      IssueEntity,
    ]),
  ],
  controllers: [
    WorkspacesController,
    WorkspaceController,
    MembersController,
    AgentsController,
    TokensController,
  ],
  providers: [
    WorkspacesService,
    PermissionsService,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [WorkspacesService, PermissionsService],
})
export class WorkspacesModule {}
