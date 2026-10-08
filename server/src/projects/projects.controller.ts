import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsArray, IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Actor, Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { PROJECT_STATUSES, type ActorRef, type Priority, type ProjectStatus } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { PROJECT_ICON_MAX, PROJECT_ICON_PATTERN } from './project-icon.js';
import { ProjectsService } from './projects.service.js';

const PRIORITIES: Priority[] = ['none', 'urgent', 'high', 'medium', 'low'];
const COLOR = /^#[0-9a-fA-F]{6}$/;

class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(300) summary?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @Matches(COLOR) color?: string;
  @IsOptional() @IsString() @MaxLength(PROJECT_ICON_MAX) @Matches(PROJECT_ICON_PATTERN) icon?: string;
  @IsOptional() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) teamIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
  @IsOptional() @IsISO8601() startDate?: string;
  @IsOptional() @IsISO8601() targetDate?: string;
}

class UpdateProjectDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @Clearable() @IsString() @MaxLength(300) summary?: string | null;
  @Clearable() @IsString() @MaxLength(20000) description?: string | null;
  @OptionalNotNull() @Matches(COLOR) color?: string;
  @Clearable() @IsString() @MaxLength(PROJECT_ICON_MAX) @Matches(PROJECT_ICON_PATTERN) icon?: string | null;
  @OptionalNotNull() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @Clearable() @IsString() leadId?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) teamIds?: string[];
  @OptionalNotNull() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
  @Clearable() @IsISO8601() startDate?: string | null;
  @Clearable() @IsISO8601() targetDate?: string | null;
}

class ListProjectsQuery {
  @IsOptional() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() repositoryId?: string;
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
