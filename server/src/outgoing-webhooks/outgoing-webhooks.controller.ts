import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { outboundUrlProblem } from '../common/safe-fetch.js';
import { OptionalNotNull } from '../common/validation.js';
import { EventsService } from '../events/events.service.js';
import { MAX_WEBHOOKS_PER_WORKSPACE, OutgoingWebhooksService } from './outgoing-webhooks.service.js';

const EVENT_PATTERN = /^(\*|[a-z_]+\.(\*|[a-z_]+))$/;
const EVENT_MESSAGE = 'events must be "*", "<entity>.*" or an event type like "issue.created"';

class CreateWebhookDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsString() @MaxLength(500) url: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60) @Matches(EVENT_PATTERN, { each: true, message: EVENT_MESSAGE }) events: string[];
  @IsOptional() @IsBoolean() enabled?: boolean;
}

class UpdateWebhookDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @OptionalNotNull() @IsString() @MaxLength(500) url?: string;
  @OptionalNotNull() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(60) @Matches(EVENT_PATTERN, { each: true, message: EVENT_MESSAGE }) events?: string[];
  @OptionalNotNull() @IsBoolean() enabled?: boolean;
}

class DeliveriesQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}

async function assertUrl(url: string): Promise<void> {
  const problem = await outboundUrlProblem(url);
  if (problem) throw new BadRequestException(problem);
}

/**
 * Custom integrations: signed JSON POSTs to your own URL for domain events.
 * Gated by the `manageIntegrations` capability. The signing secret is returned once (create / rotate).
 */
@Controller('w/:slug/outgoing-webhooks')
@Can('manageIntegrations')
export class OutgoingWebhooksController {
  constructor(
    private readonly service: OutgoingWebhooksService,
    private readonly events: EventsService,
  ) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id);
  }

  @Post()
  async create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateWebhookDto) {
    await assertUrl(dto.url);
    if ((await this.service.list(ctx.workspace.id)).length >= MAX_WEBHOOKS_PER_WORKSPACE)
      throw new ConflictException(`A workspace can have at most ${MAX_WEBHOOKS_PER_WORKSPACE} outgoing webhooks`);
    const res = await this.service.create(ctx.workspace.id, dto);
    this.events.publish(ctx.workspace.id, { type: 'created', entity: 'webhook', id: res.webhook.id });
    return res;
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Patch(':id')
  async update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateWebhookDto) {
    if (dto.url !== undefined) await assertUrl(dto.url);
    const row = await this.service.update(ctx.workspace.id, id, dto);
    this.events.publish(ctx.workspace.id, { type: 'updated', entity: 'webhook', id });
    return row;
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    await this.service.remove(ctx.workspace.id, id);
    this.events.publish(ctx.workspace.id, { type: 'deleted', entity: 'webhook', id });
  }

  /** New signing secret (returned once); the old one stops working immediately. */
  @Post(':id/rotate-secret')
  @HttpCode(200)
  async rotate(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.rotateSecret(ctx.workspace.id, id);
  }

  /** Sends a `ping` event now and answers with the delivery result (status, duration, error). */
  @Post(':id/test')
  @HttpCode(200)
  test(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.ping(ctx.workspace.id, id);
  }

  @Get(':id/deliveries')
  deliveries(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Query() q: DeliveriesQuery) {
    return this.service.recentDeliveries(ctx.workspace.id, id, q.limit ?? 20);
  }
}
