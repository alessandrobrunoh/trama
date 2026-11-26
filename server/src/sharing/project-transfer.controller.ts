import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import {
  Actor,
  Ctx,
  RequireUser,
  Roles,
  SessionOnly,
  type WorkspaceContext,
} from '../auth/request-context.js';
import type { ActorRef } from '../contracts/domain.js';
import { ProjectTransferService } from './project-transfer.service.js';

class TransferTargetQuery {
  /** Slug of the workspace the project would move to. */
  @IsString() @MinLength(1) @MaxLength(80) target: string;
}

class TransferProjectDto {
  /** Slug of the workspace to move the project to. */
  @IsString() @MinLength(1) @MaxLength(80) target: string;
}

/**
 * Moving a project to another workspace. Owner or admin of this workspace who is also owner or admin of the
 * target; a browser session only (an API token belongs to one workspace).
 */
@Controller('w/:slug/projects')
@RequireUser()
@SessionOnly()
export class ProjectTransferController {
  constructor(private readonly service: ProjectTransferService) {}

  /** What a transfer would do: status and label mapping, guests carried over, blockers. Changes nothing. */
  @Get(':id/transfer-preview')
  @Roles('admin')
  preview(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Query() q: TransferTargetQuery) {
    return this.service.preview(ctx, id, q.target);
  }

  @Post(':id/transfer')
  @Roles('admin')
  @HttpCode(200)
  transfer(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: TransferProjectDto,
  ) {
    return this.service.transfer(ctx, actor, id, dto.target);
  }
}
