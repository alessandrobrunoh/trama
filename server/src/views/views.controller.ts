import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Type } from 'class-transformer';
import { Allow, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { SavedView, ViewEntity, ViewFilter, ViewLayout } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { VIEW_ENTITIES, VIEW_LAYOUTS } from './view-rules.js';
import { ViewsService } from './views.service.js';

const ENTITIES = [...VIEW_ENTITIES];
const LAYOUTS = [...VIEW_LAYOUTS];
const OPS = ['is', 'is_not', 'in', 'not_in', 'contains', 'before', 'after'];

class FilterDto {
  @IsString() @MaxLength(100) field: string;
  @IsIn(OPS) op: ViewFilter['op'];
  @Allow() value: string | string[];
}

class SortDto {
  @IsString() field: string;
  @IsIn(['asc', 'desc']) direction: 'asc' | 'desc';
}

export class CreateViewDto {
  @IsString() @MinLength(1) @MaxLength(100) name: string;
  @IsIn(ENTITIES) entity: ViewEntity;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => FilterDto) filters?: FilterDto[];
  @IsOptional() @IsObject() @ValidateNested() @Type(() => SortDto) sort?: SavedView['sort'];
  @IsOptional() @IsString() groupBy?: string;
  @IsOptional() @IsIn(LAYOUTS) layout?: ViewLayout;
  @IsOptional() @IsBoolean() shared?: boolean;
}

export class UpdateViewDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(100) name?: string;
  @OptionalNotNull() @IsIn(ENTITIES) entity?: ViewEntity;
  @OptionalNotNull() @IsArray() @ValidateNested({ each: true }) @Type(() => FilterDto) filters?: FilterDto[];
  @Clearable() @IsObject() @ValidateNested() @Type(() => SortDto) sort?: SavedView['sort'] | null;
  @Clearable() @IsString() groupBy?: string | null;
  @OptionalNotNull() @IsIn(LAYOUTS) layout?: ViewLayout;
  @OptionalNotNull() @IsBoolean() shared?: boolean;
}

@Controller('w/:slug/views')
export class ViewsController {
  constructor(private readonly service: ViewsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id, ctx.userId);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateViewDto) {
    return this.service.create(ctx, dto);
  }

  @Patch(':id')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateViewDto) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ctx, id);
  }
}
