import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsISO8601, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { Actor, Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { MilestonesService } from './milestones.service.js';

class CreateMilestoneDto {
  @IsString() projectId: string;
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @IsISO8601() targetDate?: string;
  @IsOptional() @IsNumber() @Min(0) sortOrder?: number;
}

class UpdateMilestoneDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @Clearable() @IsString() @MaxLength(20000) description?: string | null;
  @Clearable() @IsISO8601() targetDate?: string | null;
  @OptionalNotNull() @IsNumber() @Min(0) sortOrder?: number;
}

class ReorderMilestonesDto {
  @IsString() projectId: string;
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) ids: string[];
}

class ListMilestonesQuery {
  @IsOptional() @IsString() projectId?: string;
}

@Controller('w/:slug/milestones')
export class MilestonesController {
  constructor(private readonly service: MilestonesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListMilestonesQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post()
  @Can('manageProjects')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateMilestoneDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  /** Re-numbers sortOrder (0..n-1) of a project's milestones following `ids`. Returns the ordered list. */
  @Post('reorder')
  @Can('manageProjects')
  @HttpCode(200)
  reorder(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: ReorderMilestonesDto) {
    return this.service.reorder(ctx.workspace.id, actor, dto.projectId, dto.ids);
  }

  @Patch(':id')
  @Can('manageProjects')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: UpdateMilestoneDto) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @Can('manageProjects')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }
}
