import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { PROJECT_UPDATE_BODY_MAX } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { ProjectUpdatesService } from './project-updates.service.js';

class CreateProjectUpdateDto {
  @IsString() @MaxLength(PROJECT_UPDATE_BODY_MAX) body: string;
  /** A project health catalog id. */
  @IsOptional() @IsString() @MaxLength(80) health?: string;
}

class UpdateProjectUpdateDto {
  @OptionalNotNull() @IsString() @MaxLength(PROJECT_UPDATE_BODY_MAX) body?: string;
  /** `null` clears the health reported with the update. */
  @Clearable() @IsString() @MaxLength(80) health?: string | null;
}

/**
 * Written status updates of a project. Visibility follows the project (a project the caller cannot
 * see is a 404); the token scope rules are the ones of `/projects` (GET is read, the rest writes).
 */
@Controller('w/:slug/projects/:id/updates')
export class ProjectUpdatesController {
  constructor(private readonly service: ProjectUpdatesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.list(ctx.workspace.id, id);
  }

  @Post()
  @Can('manageProjects')
  create(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() dto: CreateProjectUpdateDto,
  ) {
    return this.service.create(ctx, id, dto);
  }

  /** Author only. */
  @Patch(':updateId')
  @Can('manageProjects')
  update(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Param('updateId') updateId: string,
    @Body() dto: UpdateProjectUpdateDto,
  ) {
    return this.service.update(ctx, id, updateId, dto);
  }

  /** The author, or anyone with `manageProjects`. */
  @Delete(':updateId')
  @HttpCode(204)
  remove(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Param('updateId') updateId: string,
  ) {
    return this.service.remove(ctx, id, updateId);
  }
}
