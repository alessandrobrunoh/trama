import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Actor, Can, Ctx, canDo, type WorkspaceContext } from '../auth/request-context.js';
import {
  GIT_PROVIDERS,
  ROUTING_DIRECTIONS,
  ROUTING_FILTER_LABELS_MAX,
  ROUTING_FILTER_VALUE_MAX,
  ROUTING_SOURCE_PATH_MAX,
  type ActorRef,
  type GitProvider,
  type RoutingDirection,
} from '../contracts/domain.js';
import { OptionalNotNull } from '../common/validation.js';
import { RoutingRulesService, type RoutingCaller } from './routing-rules.service.js';

class RoutingFiltersDto {
  @IsOptional() @IsArray() @ArrayMaxSize(ROUTING_FILTER_LABELS_MAX) @IsString({ each: true }) @MaxLength(ROUTING_FILTER_VALUE_MAX, { each: true }) labels?: string[];
  @IsOptional() @IsString() @MaxLength(ROUTING_FILTER_VALUE_MAX) milestone?: string;
}

class CreateRoutingRuleDto {
  @IsIn(GIT_PROVIDERS) provider: GitProvider;
  /** `owner/name`, `owner/*`, or the URL of a repository. */
  @IsString() @MinLength(1) @MaxLength(ROUTING_SOURCE_PATH_MAX) sourcePath: string;
  @IsString() @MinLength(1) @MaxLength(100) connectionId: string;
  @IsOptional() @ValidateNested() @Type(() => RoutingFiltersDto) filters?: RoutingFiltersDto;
  @IsOptional() @IsIn(ROUTING_DIRECTIONS) direction?: RoutingDirection;
}

class UpdateRoutingRuleDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(100) connectionId?: string;
  /** Replaces the whole filter set. `{}` clears it. */
  @OptionalNotNull() @ValidateNested() @Type(() => RoutingFiltersDto) filters?: RoutingFiltersDto;
  @OptionalNotNull() @IsIn(ROUTING_DIRECTIONS) direction?: RoutingDirection;
}

class ConnectionsQuery {
  @IsOptional() @IsIn(GIT_PROVIDERS) provider?: GitProvider;
}

class SuggestionsQuery {
  @IsIn(GIT_PROVIDERS) provider: GitProvider;
  @IsOptional() @IsString() @MaxLength(100) connectionId?: string;
  @IsOptional() @IsString() @MaxLength(200) q?: string;
}

/**
 * The sources of a project: where its tasks come from. Anyone who can see the project reads them; adding,
 * changing and removing needs the right to create tasks (so a guest on a shared project can add one only if their
 * role lets them create tasks there). Credentials are never part of a response.
 */
@Controller('w/:slug/projects/:projectId/routing-rules')
export class RoutingRulesController {
  constructor(private readonly service: RoutingRulesService) {}

  private caller(ctx: WorkspaceContext, actor: ActorRef): RoutingCaller {
    const access = ctx.access ?? null;
    return {
      workspaceId: ctx.workspace.id,
      userId: ctx.userId,
      actor,
      access,
      // A narrowed person needs the grant too; the role's capability alone is not enough.
      canWrite: canDo(ctx, 'createIssues') && (!access || access.grants.includes('issues:create')),
    };
  }

  @Get()
  overview(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('projectId') projectId: string) {
    return this.service.overview(this.caller(ctx, actor), projectId);
  }

  /** The connections this person may read through here, with the workspace one suggested. */
  @Get('connections')
  connections(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('projectId') projectId: string, @Query() q: ConnectionsQuery) {
    return this.service.connectionOptions(this.caller(ctx, actor), projectId, q.provider);
  }

  @Get('suggestions')
  suggestions(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('projectId') projectId: string, @Query() q: SuggestionsQuery) {
    return this.service.suggestions(this.caller(ctx, actor), projectId, q);
  }

  @Post()
  @Can('createIssues')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('projectId') projectId: string, @Body() dto: CreateRoutingRuleDto) {
    return this.service.create(this.caller(ctx, actor), projectId, dto);
  }

  @Patch(':ruleId')
  @Can('createIssues')
  update(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('projectId') projectId: string,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdateRoutingRuleDto,
  ) {
    return this.service.update(this.caller(ctx, actor), projectId, ruleId, dto);
  }

  @Delete(':ruleId')
  @Can('createIssues')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('projectId') projectId: string, @Param('ruleId') ruleId: string) {
    return this.service.remove(this.caller(ctx, actor), projectId, ruleId);
  }
}
