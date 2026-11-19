import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { MemberAccessInterceptor } from '../auth/member-access.interceptor.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import {
  AgentEntity,
  ApiTokenEntity,
  IssueEntity,
  MembershipEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';
import { AccessGuard } from './access.guard.js';
import { LabelsController } from './labels.controller.js';
import { LabelsService } from './labels.service.js';
import { StatusesController } from './statuses.controller.js';
import { StatusesService } from './statuses.service.js';
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
      IssueEntity,
    ]),
  ],
  controllers: [
    WorkspacesController,
    WorkspaceController,
    MembersController,
    AgentsController,
    TokensController,
    LabelsController,
    StatusesController,
  ],
  providers: [
    WorkspacesService,
    LabelsService,
    StatusesService,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: MemberAccessInterceptor },
  ],
  exports: [
    WorkspacesService,
    LabelsService,
    StatusesService,
  ],
})
export class WorkspacesModule {}
