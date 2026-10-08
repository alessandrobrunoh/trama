import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { PROJECT_HEALTHS, type ProjectHealth } from '../contracts/domain.js';
import { OptionalNotNull } from '../common/validation.js';
import { ProjectUpdatesService } from './project-updates.service.js';

/** Trim before validating so a whitespace-only body is rejected instead of stored empty. */
const trimmed = Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

class CreateProjectUpdateDto {
  @IsIn(PROJECT_HEALTHS) health: ProjectHealth;
  @trimmed @IsString() @MinLength(1) @MaxLength(20000) body: string;
  @IsOptional() @IsBoolean() aiDrafted?: boolean;
}

class UpdateProjectUpdateDto {
  @OptionalNotNull() @IsIn(PROJECT_HEALTHS) health?: ProjectHealth;
  @trimmed @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(20000) body?: string;
}

/**
 * Who may do what is decided in the service (creating needs `manageProjects` or being the project's lead;
 * editing/deleting needs `manageProjects` or being the author), so the routes only require a workspace member.
 */
@Controller('w/:slug/projects/:projectId/updates')
export class ProjectUpdatesController {
  constructor(private readonly service: ProjectUpdatesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Param('projectId') projectId: string) {
    return this.service.list(ctx.workspace.id, projectId);
  }

  @Get(':id')
  get(
    @Ctx() ctx: WorkspaceContext,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.get(ctx.workspace.id, projectId, id);
  }

  @Post()
  create(
    @Ctx() ctx: WorkspaceContext,
    @Param('projectId') projectId: string,
    @Body() dto: CreateProjectUpdateDto,
  ) {
    return this.service.create(ctx, projectId, dto);
  }

  @Patch(':id')
  update(
    @Ctx() ctx: WorkspaceContext,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProjectUpdateDto,
  ) {
    return this.service.update(ctx, projectId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Ctx() ctx: WorkspaceContext,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ) {
    return this.service.remove(ctx, projectId, id);
  }
}
