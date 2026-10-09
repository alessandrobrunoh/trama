import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Ctx, Roles, type WorkspaceContext } from '../auth/request-context.js';
import { LABEL_NAME_MAX } from '../contracts/domain.js';
import { OptionalNotNull } from '../common/validation.js';
import { LabelsService } from './labels.service.js';

class CreateLabelDto {
  @IsString() @MinLength(1) @MaxLength(LABEL_NAME_MAX) name: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be #rrggbb' }) color?: string;
}

class UpdateLabelDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(LABEL_NAME_MAX) name?: string;
  @OptionalNotNull() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be #rrggbb' }) color?: string;
  @OptionalNotNull() @IsBoolean() archived?: boolean;
}

class MergeLabelDto {
  @IsString() @MinLength(1) @MaxLength(80) into: string;
}

@Controller('w/:slug/labels')
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  /** Members can create a label while tagging (the picker offers it inline); everything else about the catalog is admin-only. */
  @Post()
  @Roles('member')
  async create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateLabelDto) {
    return Object.assign(await this.labels.create(ctx, dto), { role: ctx.role });
  }

  @Patch(':id')
  @Roles('admin')
  async update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateLabelDto) {
    return Object.assign(await this.labels.update(ctx, id, dto), { role: ctx.role });
  }

  /** Move everything labelled `:id` onto `into` and remove `:id`. */
  @Post(':id/merge')
  @Roles('admin')
  async merge(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: MergeLabelDto) {
    return Object.assign(await this.labels.merge(ctx, id, dto.into), { role: ctx.role });
  }

  @Delete(':id')
  @Roles('admin')
  async remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return Object.assign(await this.labels.remove(ctx, id), { role: ctx.role });
  }
}
