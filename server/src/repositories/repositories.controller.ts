import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Actor, Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { GIT_PROVIDERS, type ActorRef, type GitProvider } from '../contracts/domain.js';
import { OptionalNotNull } from '../common/validation.js';
import { RepositoriesService } from './repositories.service.js';

class CreateRepositoryDto {
  @IsIn(GIT_PROVIDERS) provider: GitProvider;
  /** e.g. "acme/api" */
  @Matches(/^[\w.-]+(\/[\w.-]+)+$/, { message: 'fullName must look like "owner/name"' }) fullName: string;
  @IsOptional() @IsString() @MaxLength(300) url?: string;
  @IsOptional() @IsString() @MaxLength(100) defaultBranch?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) teamIds?: string[];
}

class UpdateRepositoryDto {
  @OptionalNotNull() @IsString() @MaxLength(300) url?: string;
  @OptionalNotNull() @IsString() @MaxLength(100) defaultBranch?: string;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) teamIds?: string[];
}

@Controller('w/:slug/repositories')
export class RepositoriesController {
  constructor(private readonly service: RepositoriesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post()
  @Can('manageRepositories')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateRepositoryDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  @Can('manageRepositories')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: UpdateRepositoryDto) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @Can('manageRepositories')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }
}
