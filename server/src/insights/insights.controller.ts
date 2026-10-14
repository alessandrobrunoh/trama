import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { INSIGHT_RANGES, INSIGHT_SIGNAL_IDS, type InsightSignalId } from '../contracts/domain.js';
import { InsightsService } from './insights.service.js';

class InsightsQueryDto {
  @IsOptional() @Type(() => Number) @IsIn(INSIGHT_RANGES) days?: number;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) staleDays?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@Controller('w/:slug/insights')
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get()
  report(@Ctx() ctx: WorkspaceContext, @Query() query: InsightsQueryDto) {
    return this.insights.report(ctx, query);
  }

  @Get('signals/:id')
  signal(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Query() query: InsightsQueryDto,
  ) {
    if (!INSIGHT_SIGNAL_IDS.includes(id as InsightSignalId)) {
      throw new NotFoundException(`Unknown signal "${id}"`);
    }
    return this.insights.signal(ctx, id as InsightSignalId, {
      days: query.days,
      teamId: query.teamId,
      projectId: query.projectId,
      staleDays: query.staleDays,
      limit: query.limit ?? 100,
    });
  }
}
