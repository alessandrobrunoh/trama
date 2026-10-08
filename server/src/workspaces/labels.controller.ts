import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
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
}

@Controller('w/:slug/labels')
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  @Post()
  @Roles('admin')
  async create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateLabelDto) {
    return Object.assign(await this.labels.create(ctx, dto), { role: ctx.role });
  }

  @Patch(':id')
  @Roles('admin')
  async update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateLabelDto) {
    return Object.assign(await this.labels.update(ctx, id, dto), { role: ctx.role });
  }

  @Delete(':id')
  @Roles('admin')
  async remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return Object.assign(await this.labels.remove(ctx, id), { role: ctx.role });
  }
}
