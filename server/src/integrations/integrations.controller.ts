import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Actor, Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { GIT_PROVIDERS, type ActorRef } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { IntegrationsService, type ConnectionProvider } from './integrations.service.js';

class CreateIntegrationDto {
  @IsIn([...GIT_PROVIDERS, 'delta']) provider: ConnectionProvider;
  @IsString() @MinLength(1) @MaxLength(500) token: string;
  @IsOptional() @IsString() @MaxLength(500) baseUrl?: string;
}

class UpdateIntegrationDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(500) token?: string;
  @Clearable() @IsString() @MaxLength(500) baseUrl?: string | null;
}

class RemoteReposQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) perPage?: number;
}

class LinkRepositoryDto {
  @IsString() @MinLength(3) @MaxLength(300) fullName: string;
  @IsOptional() @IsArray() @IsString({ each: true }) teamIds?: string[];
}

/** Connections to a git host (GitHub, GitLab, Bitbucket) or Delta. Admin and above only; secrets are never returned. */
@Controller('w/:slug/integrations')
@Can('manageIntegrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Req() req: Request) {
    return this.service.list(ctx.workspace.id, IntegrationsService.publicUrl(req));
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Req() req: Request) {
    return this.service.get(ctx.workspace.id, id, IntegrationsService.publicUrl(req));
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateIntegrationDto, @Req() req: Request) {
    return this.service.create(ctx.workspace.id, actor, dto, IntegrationsService.publicUrl(req));
  }

  @Patch(':id')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateIntegrationDto, @Req() req: Request) {
    return this.service.update(ctx.workspace.id, id, dto, IntegrationsService.publicUrl(req));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, id);
  }

  @Post(':id/rotate-webhook-secret')
  @HttpCode(200)
  rotate(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Req() req: Request) {
    return this.service.rotateWebhookSecret(ctx.workspace.id, id, IntegrationsService.publicUrl(req));
  }

  @Get(':id/remote-repositories')
  remote(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Query() q: RemoteReposQuery) {
    return this.service.remoteRepositories(ctx.workspace.id, id, q.page ?? 1, q.perPage ?? 30);
  }

  @Post(':id/link-repository')
  async link(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: LinkRepositoryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { repository, created } = await this.service.linkRepository(ctx.workspace.id, actor, id, dto);
    res.status(created ? 201 : 200);
    return repository;
  }

  @Delete(':id/repositories/:repositoryId')
  @HttpCode(204)
  unlink(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Param('repositoryId') repositoryId: string) {
    return this.service.unlinkRepository(ctx.workspace.id, id, repositoryId);
  }
}
