import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import {
  AgentEntity,
  ApiTokenEntity,
  MembershipEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { AccessGuard } from './access.guard.js';
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
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [WorkspacesService],
})
export class WorkspacesModule {}
