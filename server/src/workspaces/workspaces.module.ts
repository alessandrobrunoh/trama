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
  TeamEntity,
  UserEntity,
  WorkspaceEntity,
  WorkstreamEntity,
} from '../database/entities/index.js';
import { AccessGuard } from './access.guard.js';
import { CustomerTiersController } from './customer-tiers.controller.js';
import { CustomerTiersService } from './customer-tiers.service.js';
import { LabelsController } from './labels.controller.js';
import { LabelsService } from './labels.service.js';
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
    LabelsController,
    CustomerTiersController,
  ],
  providers: [
    WorkspacesService,
    LabelsService,
    CustomerTiersService,
    PermissionsService,
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: MemberAccessInterceptor },
  ],
  exports: [WorkspacesService, LabelsService, PermissionsService],
})
export class WorkspacesModule {}
