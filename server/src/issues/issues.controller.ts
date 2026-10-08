import { Body, Controller, ForbiddenException, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Actor, Can, Ctx, EditsTeamWork, canDo, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, IssueKind, IssueSource, IssueStatus, Priority } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { CreateWorkstreamDto, PRIORITIES } from '../workstreams/workstreams.controller.js';
import { IssuesService } from './issues.service.js';

const KINDS: IssueKind[] = ['bug', 'feature', 'incident', 'tech_debt', 'feedback', 'idea', 'security'];
const STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'canceled'];
const SOURCES: IssueSource[] = ['manual', 'github', 'gitlab', 'email', 'api', 'agent'];

class CreateIssueDto {
  @IsIn(KINDS) kind: IssueKind;
  @IsString() @MinLength(1) @MaxLength(300) title: string;
  @IsOptional() @IsString() @MaxLength(20000) body?: string;
  @IsOptional() @IsIn(SOURCES) source?: IssueSource;
  @IsOptional() @IsString() @MaxLength(200) reporterName?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsIn(STATUSES) status?: IssueStatus;
  @IsOptional() @IsString() @MaxLength(500) externalUrl?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) estimate?: number;
}

class UpdateIssueDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  /** Changing the kind re-keys the issue (BUG-148 → FEAT-35); the old key stays valid as an alias. */
  @OptionalNotNull() @IsIn(KINDS) kind?: IssueKind;
  /** Story points: non-negative number, `null` clears. */
  @Clearable() @IsNumber() @Min(0) @Max(1000) estimate?: number | null;
  @Clearable() @IsString() @MaxLength(20000) body?: string | null;
  @Clearable() @IsString() @MaxLength(200) reporterName?: string | null;
  @Clearable() @IsString() assigneeId?: string | null;
  @Clearable() @IsString() teamId?: string | null;
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @OptionalNotNull() @IsIn(STATUSES) status?: IssueStatus;
  @Clearable() @IsString() @MaxLength(500) externalUrl?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) workstreamIds?: string[];
  /** At most one milestone per linked workstream. */
  @OptionalNotNull() @IsArray() @IsString({ each: true }) milestoneIds?: string[];
  /** Id or key of the issue this duplicates. `null` clears it. */
  @Clearable() @IsString() duplicateOfId?: string | null;
}

class LinkIssueDto {
  @IsOptional() @IsArray() @IsString({ each: true }) workstreamIds?: string[];
  @IsOptional() @ValidateNested() @Type(() => CreateWorkstreamDto) createWorkstream?: CreateWorkstreamDto;
  @IsOptional() @IsIn(STATUSES) status?: IssueStatus;
}

class ListIssueQuery {
  @IsOptional() @IsIn(KINDS) kind?: IssueKind;
  @IsOptional() @IsIn(STATUSES) status?: IssueStatus;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsString() milestoneId?: string;
  @IsOptional() @IsString() q?: string;
}

@Controller('w/:slug/issues')
@EditsTeamWork('issue')
export class IssuesController {
  constructor(private readonly service: IssuesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListIssueQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':idOrKey')
  get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.get(ctx.workspace.id, idOrKey);
  }

  @Post()
  @Can('createIssues')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateIssueDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':idOrKey')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: UpdateIssueDto) {
    return this.service.update(ctx.workspace.id, actor, idOrKey, dto);
  }

  /** Link to existing workstreams and/or create one. Moves backlog/todo issues to `in_progress`. */
  @Post(':idOrKey/link')
  @HttpCode(200)
  link(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: LinkIssueDto) {
    if (dto.createWorkstream && !canDo(ctx, 'createWorkstreams')) throw new ForbiddenException('You are not allowed to create workstreams');
    return this.service.link(ctx.workspace.id, actor, idOrKey, dto);
  }

  @Delete(':idOrKey')
  @Can('deleteIssues')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    return this.service.remove(ctx.workspace.id, actor, idOrKey);
  }
}
