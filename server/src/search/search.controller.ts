import { Controller, Get, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { SEARCH_TYPES, SearchService, type SearchType } from './search.service.js';

class SearchQuery {
  @IsString() q: string;
  /** comma-separated: workstream,issue,decision,execution,artifact,repository,team */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value))
  @IsArray()
  @IsIn(SEARCH_TYPES, { each: true })
  types?: SearchType[];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

@Controller('w/:slug/search')
export class SearchController {
  constructor(private readonly service: SearchService) {}

  @Get()
  search(@Ctx() ctx: WorkspaceContext, @Query() q: SearchQuery) {
    return this.service.search(ctx.workspace.id, q.q, { types: q.types, limit: q.limit });
  }
}
