import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { IsDateString } from 'class-validator';
import {
  Ctx,
  RequireUser,
  type WorkspaceContext,
} from '../auth/request-context.js';
import { AttentionService } from './attention.service.js';

class SnoozeAttentionDto {
  @IsDateString() until: string;
}

@Controller('w/:slug/attention')
@RequireUser()
export class AttentionController {
  constructor(private readonly service: AttentionService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id, ctx.userId!);
  }

  @Delete(':id')
  dismiss(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.dismiss(ctx.workspace.id, ctx.userId!, id);
  }

  @Post(':id/dismiss')
  dismissPost(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.dismiss(ctx.workspace.id, ctx.userId!, id);
  }

  @Post(':id/snooze')
  snooze(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() dto: SnoozeAttentionDto,
  ) {
    return this.service.snooze(ctx.workspace.id, ctx.userId!, id, dto.until);
  }

  @Post(':id/restore')
  restore(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.restore(ctx.workspace.id, ctx.userId!, id);
  }
}
