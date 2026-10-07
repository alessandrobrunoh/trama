import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, DecisionStatus } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { DecisionsService } from './decisions.service.js';

const STATUSES: DecisionStatus[] = ['proposed', 'accepted', 'superseded', 'rejected'];

class CreateDecisionDto {
  @IsString() @MinLength(1) @MaxLength(300) title: string;
  @IsString() @MinLength(1) @MaxLength(20000) statement: string;
  @IsOptional() @IsString() @MaxLength(20000) rationale?: string;
  /** `proposed` (default) or, for people only, `accepted` / `rejected`. */
  @IsOptional() @IsIn(['proposed', 'accepted', 'rejected']) status?: DecisionStatus;
  @IsOptional() @IsString() originWorkstreamId?: string;
  @IsOptional() @IsString() originExecutionId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) relatedWorkstreamIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) tags?: string[];
}

class UpdateDecisionDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(20000) statement?: string;
  @Clearable() @IsString() @MaxLength(20000) rationale?: string | null;
  @Clearable() @IsString() originWorkstreamId?: string | null;
  @Clearable() @IsString() originExecutionId?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) relatedWorkstreamIds?: string[];
  @OptionalNotNull() @IsArray() @IsString({ each: true }) tags?: string[];
}

class SupersedeDto {
  /** Id or key (ADR-n) of the decision that replaces this one. */
  @IsString() byId: string;
}

class ListDecisionsQuery {
  @IsOptional() @IsIn(STATUSES) status?: DecisionStatus;
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsString() tag?: string;
  @IsOptional() @IsString() q?: string;
}

@Controller('w/:slug/decisions')
export class DecisionsController {
  constructor(private readonly service: DecisionsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListDecisionsQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':idOrKey')
  get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.get(ctx.workspace.id, idOrKey);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateDecisionDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':idOrKey')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: UpdateDecisionDto) {
    return this.service.update(ctx.workspace.id, actor, idOrKey, dto);
  }

  @Post(':idOrKey/accept')
  @HttpCode(200)
  accept(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    return this.service.accept(ctx.workspace.id, actor, idOrKey);
  }

  @Post(':idOrKey/reject')
  @HttpCode(200)
  reject(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    return this.service.reject(ctx.workspace.id, actor, idOrKey);
  }

  @Post(':idOrKey/supersede')
  @HttpCode(200)
  supersede(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: SupersedeDto) {
    return this.service.supersede(ctx.workspace.id, actor, idOrKey, dto.byId);
  }

  @Delete(':idOrKey')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    return this.service.remove(ctx.workspace.id, actor, idOrKey);
  }
}
