import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
import { Ctx, RequireUser, Roles, type WorkspaceContext } from '../auth/request-context.js';
import { TimeEntriesService } from './time-entries.service.js';

class TimeEntryTargetDto {
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(100) projectId?: string | null;
  @IsOptional() @IsString() @MaxLength(100) issueId?: string | null;
}

class ManualTimeEntryDto extends TimeEntryTargetDto {
  @IsISO8601() startedAt: string;
  @IsISO8601() endedAt: string;
}

/** The signed-in person's timer. Entries of other people are not listed or changed. */
@Controller('w/:slug/time-entries')
@RequireUser()
@Roles('viewer')
export class TimeEntriesController {
  constructor(private readonly service: TimeEntriesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id, ctx.userId!);
  }

  @Post('start')
  start(@Ctx() ctx: WorkspaceContext, @Body() dto: TimeEntryTargetDto) {
    return this.service.start(ctx.workspace.id, ctx.userId!, dto);
  }

  @Post('stop')
  stop(@Ctx() ctx: WorkspaceContext) {
    return this.service.stop(ctx.workspace.id, ctx.userId!);
  }

  @Post()
  add(@Ctx() ctx: WorkspaceContext, @Body() dto: ManualTimeEntryDto) {
    return this.service.add(ctx.workspace.id, ctx.userId!, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, ctx.userId!, id);
  }
}
