import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Actor, Can, Ctx, EditsTeamWork, type WorkspaceContext } from '../auth/request-context.js';
import { EXTERNAL_PROVIDERS, type ActorRef, type ExternalProvider } from '../contracts/domain.js';
import { CredentialsService } from './credentials.service.js';
import { ExternalLinksService } from './external-links.service.js';
import { ImportsService } from './imports.service.js';

class SourceDto {
  /** GitHub: `owner/name` (a GitHub URL is accepted too). */
  @IsOptional() @IsString() @MaxLength(300) repository?: string;
  /** Linear: team ids; empty or missing = every team. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(100, { each: true }) teamIds?: string[];
}

class ImportTargetDto {
  @IsIn(EXTERNAL_PROVIDERS) provider: ExternalProvider;
  @IsOptional() @IsString() @MaxLength(100) credentialId?: string;
  @IsOptional() @IsString() @MaxLength(100) connectionId?: string;
  @ValidateNested() @Type(() => SourceDto) source: SourceDto;
}

class StartImportDto extends ImportTargetDto {
  /** Editable mapping from the preview; validated in depth by the service. Omit to use the suggestions. */
  @IsOptional() @IsObject() mapping?: Record<string, unknown>;
  @IsOptional() @IsObject() options?: Record<string, unknown>;
}

class CreateCredentialDto {
  @IsIn(EXTERNAL_PROVIDERS) provider: ExternalProvider;
  @IsString() @MinLength(8) @MaxLength(500) token: string;
  /** GitHub Enterprise only. */
  @IsOptional() @IsString() @MaxLength(500) baseUrl?: string;
}

class LinkExternalDto {
  @IsString() @MinLength(8) @MaxLength(500) url: string;
}

/**
 * Import from GitHub Issues and Linear. Admin and above (`manageIntegrations`). Tokens are stored
 * encrypted, used server-side only, and never returned.
 */
@Controller('w/:slug/imports')
@Can('manageIntegrations')
export class ImportsController {
  constructor(
    private readonly service: ImportsService,
    private readonly credentials: CredentialsService,
  ) {}

  @Get('credentials')
  listCredentials(@Ctx() ctx: WorkspaceContext) {
    return this.credentials.list(ctx.workspace.id);
  }

  /** Validates the token against the tracker, then stores it encrypted. */
  @Post('credentials')
  createCredential(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateCredentialDto) {
    return this.credentials.create(ctx.workspace.id, actor, dto);
  }

  @Delete('credentials/:id')
  @HttpCode(204)
  removeCredential(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.credentials.remove(ctx.workspace.id, id);
  }

  /** Reads the source and answers with counts plus the suggested mapping. Writes nothing. */
  @Post('preview')
  @HttpCode(200)
  preview(@Ctx() ctx: WorkspaceContext, @Body() dto: ImportTargetDto) {
    return this.service.preview(ctx.workspace.id, dto);
  }

  /** Queues the import and returns the job (202); poll `GET /imports/:id` for progress. */
  @Post()
  @HttpCode(202)
  start(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: StartImportDto) {
    return this.service.start(ctx.workspace.id, actor, dto);
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.cancel(ctx.workspace.id, id);
  }

  /** Continues a failed import from where it stopped. Already imported issues are skipped. */
  @Post(':id/retry')
  @HttpCode(200)
  retry(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.retry(ctx.workspace.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, id);
  }
}

/** Link an existing issue to GitHub / Linear. Same permission as editing the issue. */
@Controller('w/:slug/issues')
@EditsTeamWork('issue')
export class IssueExternalRefController {
  constructor(private readonly links: ExternalLinksService) {}

  @Put(':idOrKey/external-ref')
  link(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: LinkExternalDto) {
    return this.links.link(ctx.workspace.id, actor, idOrKey, dto.url);
  }

  /** Re-reads the external status (read-only: the Trama status does not change). */
  @Post(':idOrKey/external-ref/refresh')
  @HttpCode(200)
  refresh(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.links.refresh(ctx.workspace.id, idOrKey);
  }

  @Delete(':idOrKey/external-ref')
  @HttpCode(200)
  unlink(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    return this.links.unlink(ctx.workspace.id, actor, idOrKey);
  }
}
