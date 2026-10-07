import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Actor, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, ExecutionProvider, ExecutionState } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { ExecutionsService } from './executions.service.js';

const PROVIDERS: ExecutionProvider[] = ['human', 'delta', 'claude_code', 'codex', 'cursor', 'other'];
const STATES: ExecutionState[] = ['queued', 'running', 'needs_input', 'in_review', 'blocked', 'failed', 'completed', 'canceled'];

class ActorRefDto {
  @IsIn(['user', 'agent', 'team']) type: 'user' | 'agent' | 'team';
  @IsString() id: string;
}

class CreateExecutionDto {
  @IsString() workstreamId: string;
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsOptional() @IsString() parentExecutionId?: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => ActorRefDto) performers?: ActorRefDto[];
  @IsOptional() @IsIn(PROVIDERS) provider?: ExecutionProvider;
  @IsOptional() @IsIn(STATES) state?: ExecutionState;
  @IsOptional() @IsArray() @IsString({ each: true }) dependsOnExecutionIds?: string[];
  @IsOptional() @IsString() @MaxLength(500) sessionUrl?: string;
  @IsOptional() @IsString() @MaxLength(200) branch?: string;
  @IsOptional() @IsString() @MaxLength(5000) progressNote?: string;
}

class UpdateExecutionDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @Clearable() @IsString() parentExecutionId?: string | null;
  @Clearable() @IsString() @MaxLength(10000) description?: string | null;
  @Clearable() @IsString() teamId?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
  @OptionalNotNull() @IsArray() @ValidateNested({ each: true }) @Type(() => ActorRefDto) performers?: ActorRefDto[];
  @OptionalNotNull() @IsIn(PROVIDERS) provider?: ExecutionProvider;
  @OptionalNotNull() @IsIn(STATES) state?: ExecutionState;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) dependsOnExecutionIds?: string[];
  @Clearable() @IsString() @MaxLength(500) sessionUrl?: string | null;
  @Clearable() @IsString() @MaxLength(200) branch?: string | null;
  @Clearable() @IsString() @MaxLength(5000) progressNote?: string | null;
}

class ProgressDto {
  @IsString() @MinLength(1) @MaxLength(5000) note: string;
  @IsOptional() @IsIn(STATES) state?: ExecutionState;
}

class CompleteDto {
  @IsOptional() @IsString() @MaxLength(5000) note?: string;
}

class ListExecutionsQuery {
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsIn(STATES) state?: ExecutionState;
  @IsOptional() @IsString() parentExecutionId?: string;
  @IsOptional() @IsString() teamId?: string;
}

@Controller('w/:slug/executions')
export class ExecutionsController {
  constructor(private readonly service: ExecutionsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListExecutionsQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateExecutionDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: UpdateExecutionDto) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  /** Report a progress note, optionally moving the state (agents call this). */
  @Post(':id/progress')
  @HttpCode(200)
  progress(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: ProgressDto) {
    return this.service.progress(ctx.workspace.id, actor, id, dto);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: CompleteDto) {
    return this.service.complete(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }
}
