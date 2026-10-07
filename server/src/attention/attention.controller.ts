import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsDateString, IsIn, IsOptional } from 'class-validator';
import { Ctx, RequireUser, type WorkspaceContext } from '../auth/request-context.js';
import { AttentionService } from './attention.service.js';

class AttentionQuery {
  @IsOptional() @IsIn(['mine', 'all']) scope?: 'mine' | 'all';
  @IsOptional() @IsIn(['open', 'snoozed', 'dismissed', 'active']) state?: 'open' | 'snoozed' | 'dismissed' | 'active';
}

class SnoozeDto {
  @IsDateString() until: string;
}

/** Attention is human attention: agent tokens get 403. */
@Controller('w/:slug/attention')
@RequireUser()
export class AttentionController {
  constructor(private readonly service: AttentionService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: AttentionQuery) {
    return this.service.forUser(ctx, q);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  dismiss(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.dismiss(ctx, id);
  }

  @Post(':id/snooze')
  @HttpCode(200)
  snooze(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: SnoozeDto) {
    return this.service.snooze(ctx, id, dto.until);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.restore(ctx, id);
  }
}
