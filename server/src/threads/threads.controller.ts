import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  Actor,
  Auth,
  Ctx,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import {
  DECISION_PATHS_MAX,
  DECISION_TEXT_MAX,
  DECISIONS_PER_SYNC_MAX,
  THREAD_FILES_MAX,
  THREAD_PATH_MAX,
  THREAD_SUGGESTED_MINUTES_MAX,
  THREAD_SUMMARY_MAX,
  type ActorRef,
  type ThreadSyncInput,
} from '../contracts/domain.js';
import { IsThreadUrl } from '../common/validation.js';
import { DECISIONS_MAX_LIMIT, ThreadsService } from './threads.service.js';

/** Custom tokens may attach a PR only with the artifacts write permission. */
function canWriteArtifacts(auth: AuthInfo): boolean {
  return (
    auth.token?.scope !== 'custom' ||
    auth.token.permissions?.includes('artifacts:write') === true
  );
}

class SyncDecisionDto {
  @IsString() @MaxLength(DECISION_TEXT_MAX) text: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DECISION_PATHS_MAX)
  @IsString({ each: true })
  @MaxLength(THREAD_PATH_MAX, { each: true })
  paths?: string[];
}

class ThreadSyncDto implements ThreadSyncInput {
  /** Links this thread when the task has none; 409 when it links a different one. */
  @IsOptional() @IsString() @IsThreadUrl() threadUrl?: string;
  @IsOptional() @IsString() @MaxLength(THREAD_SUMMARY_MAX) summary?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DECISIONS_PER_SYNC_MAX)
  @ValidateNested({ each: true })
  @Type(() => SyncDecisionDto)
  decisions?: SyncDecisionDto[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(THREAD_FILES_MAX)
  @IsString({ each: true })
  @MaxLength(THREAD_PATH_MAX, { each: true })
  files?: string[];
  @IsOptional() @IsString() @IsThreadUrl() pullRequestUrl?: string;
  @IsOptional() @IsInt() @Min(1) @Max(THREAD_SUGGESTED_MINUTES_MAX) activeMinutes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1_000_000) turns?: number;
}

class ListDecisionsQuery {
  /** A repository file: matches decisions on that file, on a directory above it, or on a glob. */
  @IsOptional() @IsString() @MaxLength(1024) path?: string;
  /** Id or key of a task: only its decisions (and the ones without paths, when `path` is given). */
  @IsOptional() @IsString() @MaxLength(100) issue?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(DECISIONS_MAX_LIMIT) limit?: number;
}

/**
 * What the agent working in a task's thread keeps in Trama. Permissions follow the task routes:
 * `thread/sync` edits the task, the rest reads it.
 */
@Controller('w/:slug/tasks')
export class ThreadsController {
  constructor(private readonly service: ThreadsService) {}

  /** `trama sync`: summary, files, decisions, PR and suggested time, in one call. */
  @Post(':idOrKey/thread/sync')
  @HttpCode(200)
  sync(
    @Ctx() ctx: WorkspaceContext,
    @Auth() auth: AuthInfo,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
    @Body() dto: ThreadSyncDto,
  ) {
    return this.service.sync(
      ctx.workspace.id,
      { actor, userId: ctx.userId, canWriteArtifacts: canWriteArtifacts(auth) },
      idOrKey,
      dto,
    );
  }

  @Get(':idOrKey/thread')
  record(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.getRecord(ctx.workspace.id, idOrKey);
  }

  @Get(':idOrKey/estimate-suggestion')
  estimate(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.estimateSuggestion(ctx.workspace, idOrKey);
  }
}

/** Decisions of the workspace, read back before an agent touches a file. */
@Controller('w/:slug/decisions')
export class DecisionsController {
  constructor(private readonly service: ThreadsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListDecisionsQuery) {
    return this.service.listDecisions(ctx.workspace.id, q);
  }
}
