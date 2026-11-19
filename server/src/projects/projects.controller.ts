import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, Max, Min, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Actor, Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import {
  PROJECT_KEY_MAX,
  PROJECT_REPOSITORY_MAX,
  type ActorRef,
  type Priority,
} from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { PROJECT_ICON_MAX, PROJECT_ICON_PATTERN } from './project-icon.js';
import { ProjectsService } from './projects.service.js';

const PRIORITIES: Priority[] = ['none', 'urgent', 'high', 'medium', 'low'];
const COLOR = /^#[0-9a-fA-F]{6}$/;
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9]{0,3}$/;

class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(PROJECT_KEY_MAX) @Matches(PROJECT_KEY) key?: string;
  @IsOptional() @IsString() @MaxLength(300) summary?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @Matches(COLOR) color?: string;
  @IsOptional() @IsString() @MaxLength(PROJECT_ICON_MAX) @Matches(PROJECT_ICON_PATTERN) icon?: string;
  @IsOptional() @IsString() @MaxLength(80) status?: string;
  /** Project health: a health catalog id or one of on_track, at_risk, off_track. */
  @IsOptional() @IsString() @MaxLength(80) health?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsString() leadId?: string;
  @Clearable() @IsString() @MaxLength(PROJECT_REPOSITORY_MAX) repository?: string | null;
  /** Workspace label ids. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) labels?: string[];
  @IsOptional() @IsISO8601() startDate?: string;
  @IsOptional() @IsISO8601() targetDate?: string;
}

class UpdateProjectDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @OptionalNotNull() @IsString() @MaxLength(PROJECT_KEY_MAX) @Matches(PROJECT_KEY) key?: string;
  @Clearable() @IsString() @MaxLength(300) summary?: string | null;
  @Clearable() @IsString() @MaxLength(20000) description?: string | null;
  @OptionalNotNull() @Matches(COLOR) color?: string;
  @Clearable() @IsString() @MaxLength(PROJECT_ICON_MAX) @Matches(PROJECT_ICON_PATTERN) icon?: string | null;
  @OptionalNotNull() @IsString() @MaxLength(80) status?: string;
  /** Project health. `null` clears it. */
  @Clearable() @IsString() @MaxLength(80) health?: string | null;
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @Clearable() @IsString() leadId?: string | null;
  @Clearable() @IsString() @MaxLength(PROJECT_REPOSITORY_MAX) repository?: string | null;
  /** Workspace label ids. Replaces the whole list. */
  @OptionalNotNull() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) labels?: string[];
  @Clearable() @IsISO8601() startDate?: string | null;
  @Clearable() @IsISO8601() targetDate?: string | null;
}

class ListProjectsQuery {
  @IsOptional() @IsString() @MaxLength(80) status?: string;
  @IsOptional() @IsString() @MaxLength(80) health?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() q?: string;
}

@Controller('w/:slug/projects')
export class ProjectsController {
  constructor(private readonly service: ProjectsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListProjectsQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post()
  @Can('manageProjects')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateProjectDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  @Can('manageProjects')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @Can('manageProjects')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }
}
