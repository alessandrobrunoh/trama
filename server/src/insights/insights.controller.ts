import { Controller, Get, Param, ParseEnumPipe, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { INSIGHT_RANGES, INSIGHT_SIGNAL_IDS, type InsightSignalId } from '../contracts/domain.js';
import { DEFAULT_QUERY, InsightsService, type InsightsQuery } from './insights.service.js';

export class InsightsQueryDto {
  /** Look-back window in days. */
  @IsOptional() @Type(() => Number) @IsIn(INSIGHT_RANGES) days?: number;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() projectId?: string;
  /** Days without activity before in-flight work counts as stale. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) staleDays?: number;
  /** Items kept per signal; counts always cover everything. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

const toQuery = (q: InsightsQueryDto): InsightsQuery => ({
  days: q.days ?? DEFAULT_QUERY.days,
  staleDays: q.staleDays ?? DEFAULT_QUERY.staleDays,
  limit: q.limit ?? DEFAULT_QUERY.limit,
  ...(q.teamId ? { teamId: q.teamId } : {}),
  ...(q.projectId ? { projectId: q.projectId } : {}),
});

/**
 * Where are the problems? Read-only and workspace-scoped (`insights:read` for custom tokens);
 * works for people and agents alike.
 */
@Controller('w/:slug/insights')
export class InsightsController {
  constructor(private readonly service: InsightsService) {}

  @Get()
  report(@Ctx() ctx: WorkspaceContext, @Query() q: InsightsQueryDto) {
    return this.service.report(ctx, toQuery(q));
  }

  /** One signal with its full item list (up to `limit`): what a tile drills into. */
  @Get('signals/:id')
  signal(
    @Ctx() ctx: WorkspaceContext,
    @Param('id', new ParseEnumPipe(INSIGHT_SIGNAL_IDS)) id: InsightSignalId,
    @Query() q: InsightsQueryDto,
  ) {
    return this.service.signal(ctx, id, { ...toQuery(q), limit: q.limit ?? 100 });
  }
}
