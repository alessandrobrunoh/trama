import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Actor, Can, Ctx, Public, type WorkspaceContext } from '../auth/request-context.js';
import {
  INTAKE_ITEM_STATUSES,
  INTAKE_PROVIDERS,
  INTAKE_SOURCE_NAME_MAX,
  type ActorRef,
  type IntakeItemStatus,
  type IntakeProvider,
} from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import type { RawBodyRequest } from '../webhooks/raw-body.js';
import { CustomerIntakeService } from './customer-intake.service.js';

class CreateSourceDto {
  @IsIn(INTAKE_PROVIDERS) provider: IntakeProvider;
  @IsString() @MinLength(1) @MaxLength(INTAKE_SOURCE_NAME_MAX) name: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() autoCreateCustomers?: boolean;
  @IsOptional() @IsString() @MaxLength(100) targetProjectId?: string;
  @IsOptional() @IsString() @MaxLength(63) subdomain?: string;
  /** The provider's own signing secret (Intercom, Zendesk, Front, Slack). Can be added later. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(500) secret?: string;
}

class UpdateSourceDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(INTAKE_SOURCE_NAME_MAX) name?: string;
  @OptionalNotNull() @IsBoolean() enabled?: boolean;
  @OptionalNotNull() @IsBoolean() autoCreateCustomers?: boolean;
  @Clearable() @IsString() @MaxLength(100) targetProjectId?: string | null;
  @Clearable() @IsString() @MaxLength(63) subdomain?: string | null;
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(500) secret?: string;
}

class ListItemsQuery {
  @IsOptional() @IsIn([...INTAKE_ITEM_STATUSES, 'all']) status?: IntakeItemStatus | 'all';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

class LinkItemDto {
  /** Exactly one of `issueId` / `projectId`. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) issueId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) projectId?: string;
  /** Overrides the customer matched from the sender's domain. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) customerId?: string;
  /** No customer matched: create one from the sender's email domain. */
  @IsOptional() @IsBoolean() createCustomer?: boolean;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) customerName?: string;
  @IsOptional() @IsBoolean() important?: boolean;
}

/**
 * Sources of inbound customer requests (Intercom, Zendesk, Front, Slack, email, signed webhook).
 * `manageIntegrations`. The secret is returned once, when Trama generates it (create / rotate-secret).
 */
@Controller('w/:slug/intake-sources')
@Can('manageIntegrations')
export class IntakeSourcesController {
  constructor(private readonly service: CustomerIntakeService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Req() req: Request) {
    return this.service.listSources(ctx.workspace.id, IntegrationsService.publicUrl(req));
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Req() req: Request) {
    return this.service.getSourcePresented(ctx.workspace.id, id, IntegrationsService.publicUrl(req));
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateSourceDto, @Req() req: Request) {
    return this.service.createSource(ctx.workspace.id, actor, dto, IntegrationsService.publicUrl(req));
  }

  @Patch(':id')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateSourceDto, @Req() req: Request) {
    return this.service.updateSource(ctx.workspace.id, id, dto, IntegrationsService.publicUrl(req));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.removeSource(ctx.workspace.id, id);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  rotate(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Req() req: Request) {
    return this.service.rotateSecret(ctx.workspace.id, id, IntegrationsService.publicUrl(req));
  }

  /** Dry run: a sample delivery goes through signature check, parsing and customer matching; nothing is saved. */
  @Post(':id/test')
  @HttpCode(200)
  test(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.testSource(ctx.workspace.id, id);
  }
}

/** The triage inbox: requests that arrived through a source. Reading is for members; linking needs `manageCustomers`. */
@Controller('w/:slug/customer-intake')
export class CustomerIntakeController {
  constructor(private readonly service: CustomerIntakeService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListItemsQuery) {
    return this.service.listItems(ctx.workspace.id, q);
  }

  @Get('count')
  async count(@Ctx() ctx: WorkspaceContext) {
    return { pending: await this.service.pendingCount(ctx.workspace.id) };
  }

  @Post(':id/link')
  @Can('manageCustomers')
  @HttpCode(200)
  link(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: LinkItemDto) {
    return this.service.link(ctx.workspace.id, actor, id, dto);
  }

  @Post(':id/dismiss')
  @Can('manageCustomers')
  @HttpCode(200)
  dismiss(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.dismiss(ctx.workspace.id, id);
  }

  @Post(':id/restore')
  @Can('manageCustomers')
  @HttpCode(200)
  restore(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.restore(ctx.workspace.id, id);
  }
}

/**
 * Provider webhooks for the sources above. Public (no session / token): authenticity is the provider's
 * signature of the source's secret, checked in the service; the workspace is the source's.
 */
@Public()
@Controller('webhooks/intake')
export class IntakeWebhookController {
  constructor(private readonly service: CustomerIntakeService) {}

  @Post(':sourceId')
  @HttpCode(200)
  async receive(@Param('sourceId') sourceId: string, @Req() req: Request, @Res() res: Response) {
    const result = await this.service.receive({
      sourceId,
      rawBody: (req as unknown as RawBodyRequest).rawBody,
      payload: req.body as unknown,
      headers: req.headers,
    });
    res.status(result.httpStatus).json(result.body);
  }
}
