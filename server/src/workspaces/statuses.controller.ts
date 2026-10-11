import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Ctx, Roles, type WorkspaceContext } from '../auth/request-context.js';
import { STATUS_ICON_MAX, STATUS_NAME_MAX } from '../contracts/domain.js';
import { OptionalNotNull } from '../common/validation.js';
import { StatusesService } from './statuses.service.js';

const COLOR = /^#[0-9a-fA-F]{6}$/;

class CreateStatusDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(STATUS_NAME_MAX) name?: string;
  @IsString() @MinLength(1) @MaxLength(STATUS_ICON_MAX) icon: string;
  @Matches(COLOR, { message: 'color must be #rrggbb' }) color: string;
  @IsString() @MinLength(1) @MaxLength(40) type: string;
}

class UpdateStatusDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(STATUS_NAME_MAX) name?: string;
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(STATUS_ICON_MAX) icon?: string;
  @OptionalNotNull() @Matches(COLOR, { message: 'color must be #rrggbb' }) color?: string;
}

/** Workspace status catalogs (admin). Each call returns the updated workspace. */
@Controller('w/:slug/statuses')
export class StatusesController {
  constructor(private readonly statuses: StatusesService) {}

  @Post(':subject')
  @Roles('admin')
  async create(@Ctx() ctx: WorkspaceContext, @Param('subject') subject: string, @Body() dto: CreateStatusDto) {
    return Object.assign(await this.statuses.create(ctx, subject, dto), { role: ctx.role });
  }

  @Patch(':subject/:id')
  @Roles('admin')
  async update(
    @Ctx() ctx: WorkspaceContext,
    @Param('subject') subject: string,
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
  ) {
    return Object.assign(await this.statuses.update(ctx, subject, id, dto), { role: ctx.role });
  }

  @Delete(':subject/:id')
  @Roles('admin')
  async remove(@Ctx() ctx: WorkspaceContext, @Param('subject') subject: string, @Param('id') id: string) {
    return Object.assign(await this.statuses.remove(ctx, subject, id), { role: ctx.role });
  }
}
