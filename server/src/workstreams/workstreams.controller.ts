import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Actor, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, CriterionState, Priority, WorkstreamStatus } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { WorkstreamsService } from './workstreams.service.js';

export const PRIORITIES: Priority[] = ['none', 'urgent', 'high', 'medium', 'low'];
export const STATUSES: WorkstreamStatus[] = ['draft', 'planned', 'working', 'needs_input', 'in_review', 'blocked', 'ready_to_land', 'shipped', 'canceled'];
const CRITERION_STATES: CriterionState[] = ['pending', 'in_progress', 'met'];

export class CriterionDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @MinLength(1) @MaxLength(500) text: string;
  @IsOptional() @IsIn(CRITERION_STATES) state?: CriterionState;
}

class UpdateCriterionDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(500) text?: string;
  @OptionalNotNull() @IsIn(CRITERION_STATES) state?: CriterionState;
}

export class CreateWorkstreamDto {
  @IsString() @MinLength(1) @MaxLength(200) title: string;
  @IsString() ownerTeamId: string;
  @IsString() @MinLength(1) @MaxLength(500) deltaThreadUrl: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @IsString() @MaxLength(20000) objective?: string;
  @IsOptional() @IsString() @MaxLength(20000) context?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) participatingTeamIds?: string[];
  @IsOptional() @IsString() accountableUserId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CriterionDto) acceptanceCriteria?: CriterionDto[];
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsArray() @IsString({ each: true }) labels?: string[];
  @IsOptional() @IsIn(['draft', 'canceled']) statusOverride?: 'draft' | 'canceled';
  @IsOptional() @IsISO8601() targetDate?: string;
}

class UpdateWorkstreamDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(500) deltaThreadUrl?: string;
  @Clearable() @IsString() @MaxLength(20000) description?: string | null;
  @OptionalNotNull() @IsString() @MaxLength(20000) objective?: string;
  @Clearable() @IsString() @MaxLength(20000) context?: string | null;
  @OptionalNotNull() @IsString() ownerTeamId?: string;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) participatingTeamIds?: string[];
  @Clearable() @IsString() accountableUserId?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
  @OptionalNotNull() @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => CriterionDto) acceptanceCriteria?: CriterionDto[];
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) labels?: string[];
  @Clearable() @IsIn(['draft', 'canceled']) statusOverride?: 'draft' | 'canceled' | null;
  @Clearable() @IsISO8601() targetDate?: string | null;
}

class ListWorkstreamsQuery {
  @IsOptional() @IsIn(STATUSES) status?: WorkstreamStatus;
  @IsOptional() @IsString() ownerTeamId?: string;
  /** owner or participating team */
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() accountableUserId?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsString() repositoryId?: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() q?: string;
}

@Controller('w/:slug/workstreams')
export class WorkstreamsController {
  constructor(private readonly service: WorkstreamsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListWorkstreamsQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':idOrKey')
  get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.get(ctx.workspace.id, idOrKey);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateWorkstreamDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':idOrKey')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: UpdateWorkstreamDto) {
    return this.service.update(ctx.workspace.id, actor, idOrKey, dto);
  }

  @Delete(':idOrKey')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    return this.service.remove(ctx.workspace.id, actor, idOrKey);
  }

  // Acceptance criteria — each returns the updated Workstream.

  @Post(':idOrKey/criteria')
  addCriterion(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: CriterionDto) {
    return this.service.addCriterion(ctx.workspace.id, actor, idOrKey, dto);
  }

  @Patch(':idOrKey/criteria/:criterionId')
  updateCriterion(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Param('criterionId') criterionId: string, @Body() dto: UpdateCriterionDto) {
    return this.service.updateCriterion(ctx.workspace.id, actor, idOrKey, criterionId, dto);
  }

  @Delete(':idOrKey/criteria/:criterionId')
  removeCriterion(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Param('criterionId') criterionId: string) {
    return this.service.removeCriterion(ctx.workspace.id, actor, idOrKey, criterionId);
  }
}
