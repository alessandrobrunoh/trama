import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Actor, Auth, Can, Ctx, RequireUser, SessionOnly, type AuthInfo, type WorkspaceContext } from '../auth/request-context.js';
import { GIT_PROVIDERS, type ActorRef } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { IntegrationsService, type ConnectionProvider, type ConnectionScope } from './integrations.service.js';

class CreateIntegrationDto {
  @IsIn([...GIT_PROVIDERS, 'delta']) provider: ConnectionProvider;
  @IsString() @MinLength(1) @MaxLength(500) token: string;
  @IsOptional() @IsString() @MaxLength(500) baseUrl?: string;
  /** Display name; defaults to "<Provider> · <account>". */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) label?: string;
}

class UpdateIntegrationDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(500) token?: string;
  @Clearable() @IsString() @MaxLength(500) baseUrl?: string | null;
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(80) label?: string;
}

class RemoteReposQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) perPage?: number;
}

/**
 * Connections of a workspace to a git host (GitHub, GitLab, Bitbucket) or Delta, several per
 * provider. Needs the integrations permission; secrets are never returned. Personal connections
 * live under `/me/connections` and never show up here.
 */
@Controller('w/:slug/integrations')
@Can('manageIntegrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  private scope(ctx: WorkspaceContext): ConnectionScope {
    return { type: 'workspace', workspaceId: ctx.workspace.id };
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Req() req: Request) {
    return this.service.list(this.scope(ctx), IntegrationsService.publicUrl(req));
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Req() req: Request) {
    return this.service.get(this.scope(ctx), id, IntegrationsService.publicUrl(req));
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateIntegrationDto, @Req() req: Request) {
    return this.service.create(this.scope(ctx), actor, dto, IntegrationsService.publicUrl(req));
  }

  @Patch(':id')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateIntegrationDto, @Req() req: Request) {
    return this.service.update(this.scope(ctx), id, dto, IntegrationsService.publicUrl(req));
  }

  /** Withdraws the credential: status `revoked`, token wiped. A new token via PATCH reconnects it. */
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Req() req: Request) {
    return this.service.revoke(this.scope(ctx), id, IntegrationsService.publicUrl(req));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(this.scope(ctx), id);
  }

  @Post(':id/rotate-webhook-secret')
  @HttpCode(200)
  rotate(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Req() req: Request) {
    return this.service.rotateWebhookSecret(this.scope(ctx), id, IntegrationsService.publicUrl(req));
  }

  @Get(':id/remote-repositories')
  remote(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Query() q: RemoteReposQuery) {
    return this.service.remoteRepositories(this.scope(ctx), id, q.page ?? 1, q.perPage ?? 30);
  }
}

/**
 * The signed-in person's own connections (a personal GitHub, a client's GitLab), the same in every
 * workspace. Only the owner sees or changes them: another person gets a 404, never the row. Browser
 * sessions only, since an API token belongs to one workspace.
 */
@Controller('me/connections')
@RequireUser()
@SessionOnly()
export class MyConnectionsController {
  constructor(private readonly service: IntegrationsService) {}

  private scope(auth: AuthInfo): ConnectionScope {
    return { type: 'user', userId: auth.user!.id };
  }

  @Get()
  list(@Auth() auth: AuthInfo, @Req() req: Request) {
    return this.service.list(this.scope(auth), IntegrationsService.publicUrl(req));
  }

  @Get(':id')
  get(@Auth() auth: AuthInfo, @Param('id') id: string, @Req() req: Request) {
    return this.service.get(this.scope(auth), id, IntegrationsService.publicUrl(req));
  }

  @Post()
  create(@Auth() auth: AuthInfo, @Body() dto: CreateIntegrationDto, @Req() req: Request) {
    return this.service.create(this.scope(auth), auth.actor, dto, IntegrationsService.publicUrl(req));
  }

  @Patch(':id')
  update(@Auth() auth: AuthInfo, @Param('id') id: string, @Body() dto: UpdateIntegrationDto, @Req() req: Request) {
    return this.service.update(this.scope(auth), id, dto, IntegrationsService.publicUrl(req));
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@Auth() auth: AuthInfo, @Param('id') id: string, @Req() req: Request) {
    return this.service.revoke(this.scope(auth), id, IntegrationsService.publicUrl(req));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Auth() auth: AuthInfo, @Param('id') id: string) {
    return this.service.remove(this.scope(auth), id);
  }

  @Post(':id/rotate-webhook-secret')
  @HttpCode(200)
  rotate(@Auth() auth: AuthInfo, @Param('id') id: string, @Req() req: Request) {
    return this.service.rotateWebhookSecret(this.scope(auth), id, IntegrationsService.publicUrl(req));
  }

  @Get(':id/remote-repositories')
  remote(@Auth() auth: AuthInfo, @Param('id') id: string, @Query() q: RemoteReposQuery) {
    return this.service.remoteRepositories(this.scope(auth), id, q.page ?? 1, q.perPage ?? 30);
  }
}
