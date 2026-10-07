import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Actor, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, IntakeKind, IntakeSource, IntakeState, Priority } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { CreateWorkstreamDto, PRIORITIES } from '../workstreams/workstreams.controller.js';
import { IntakeService } from './intake.service.js';

const KINDS: IntakeKind[] = ['bug', 'feature', 'incident', 'tech_debt', 'feedback', 'idea', 'security'];
const STATES: IntakeState[] = ['new', 'triaged', 'accepted', 'declined', 'duplicate'];
const SOURCES: IntakeSource[] = ['manual', 'github', 'gitlab', 'email', 'api', 'agent'];

class CreateIntakeDto {
  @IsIn(KINDS) kind: IntakeKind;
  @IsString() @MinLength(1) @MaxLength(300) title: string;
  @IsOptional() @IsString() @MaxLength(20000) body?: string;
  @IsOptional() @IsIn(SOURCES) source?: IntakeSource;
  @IsOptional() @IsString() @MaxLength(200) reporterName?: string;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsString() @MaxLength(500) externalUrl?: string;
}

class UpdateIntakeDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  @Clearable() @IsString() @MaxLength(20000) body?: string | null;
  @Clearable() @IsString() @MaxLength(200) reporterName?: string | null;
  @Clearable() @IsString() teamId?: string | null;
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @Clearable() @IsString() @MaxLength(500) externalUrl?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) workstreamIds?: string[];
}

class TriageDto {
  @IsIn(STATES) state: IntakeState;
  @IsOptional() @IsArray() @IsString({ each: true }) workstreamIds?: string[];
  @IsOptional() @ValidateNested() @Type(() => CreateWorkstreamDto) createWorkstream?: CreateWorkstreamDto;
  /** Id or key of the item this duplicates (required when state = duplicate). */
  @IsOptional() @IsString() duplicateOfId?: string;
  @Clearable() @IsString() teamId?: string | null;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
}

class ListIntakeQuery {
  @IsOptional() @IsIn(KINDS) kind?: IntakeKind;
  @IsOptional() @IsIn(STATES) state?: IntakeState;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsString() q?: string;
}

@Controller('w/:slug/intake')
export class IntakeController {
  constructor(private readonly service: IntakeService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListIntakeQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':idOrKey')
  get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.get(ctx.workspace.id, idOrKey);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateIntakeDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':idOrKey')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: UpdateIntakeDto) {
    return this.service.update(ctx.workspace.id, actor, idOrKey, dto);
  }

  /** Triage: `{ state, workstreamIds?, createWorkstream?: { title, objective, ownerTeamId, … }, duplicateOfId? }`. */
  @Post(':idOrKey/triage')
  @HttpCode(200)
  triage(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: TriageDto) {
    return this.service.triage(ctx.workspace.id, actor, idOrKey, dto);
  }

  @Delete(':idOrKey')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    return this.service.remove(ctx.workspace.id, actor, idOrKey);
  }
}
