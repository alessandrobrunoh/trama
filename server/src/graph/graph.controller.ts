import { Controller, Get, Param, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { WorkstreamsService } from '../workstreams/workstreams.service.js';
import { GraphService } from './graph.service.js';

const bool = () => Transform(({ value }: { value: unknown }) => (value === 'false' || value === '0' ? false : value === 'true' || value === '1' ? true : value));

class GraphQuery {
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @bool() @IsBoolean() includeArtifacts?: boolean;
  @IsOptional() @bool() @IsBoolean() includeActors?: boolean;
  @IsOptional() @bool() @IsBoolean() includeRepositories?: boolean;
}

class WorkstreamGraphQuery {
  @IsOptional() @bool() @IsBoolean() includeArtifacts?: boolean;
  @IsOptional() @bool() @IsBoolean() includeActors?: boolean;
  @IsOptional() @bool() @IsBoolean() includeRepositories?: boolean;
}

@Controller('w/:slug')
export class GraphController {
  constructor(
    private readonly service: GraphService,
    private readonly workstreams: WorkstreamsService,
  ) {}

  @Get('graph')
  workspace(@Ctx() ctx: WorkspaceContext, @Query() q: GraphQuery) {
    return this.service.build(ctx.workspace.id, q);
  }

  @Get('workstreams/:idOrKey/graph')
  async forWorkstream(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string, @Query() q: WorkstreamGraphQuery) {
    const ws = await this.workstreams.get(ctx.workspace.id, idOrKey);
    return this.service.build(ctx.workspace.id, { includeArtifacts: q.includeArtifacts, includeActors: q.includeActors, includeRepositories: q.includeRepositories, workstreamId: ws.id });
  }
}
