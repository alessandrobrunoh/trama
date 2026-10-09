import { Body, Controller, Delete, Param, Patch, Post } from '@nestjs/common';
import { IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Ctx, Roles, type WorkspaceContext } from '../auth/request-context.js';
import { CUSTOMER_TIER_NAME_MAX } from '../contracts/domain.js';
import { OptionalNotNull } from '../common/validation.js';
import { CustomerTiersService } from './customer-tiers.service.js';

class CreateTierDto {
  @IsString() @MinLength(1) @MaxLength(CUSTOMER_TIER_NAME_MAX) name: string;
  @IsOptional() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be #rrggbb' }) color?: string;
}

class UpdateTierDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(CUSTOMER_TIER_NAME_MAX) name?: string;
  @OptionalNotNull() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'color must be #rrggbb' }) color?: string;
}

/** Workspace-level customer tiers (admin). Each call returns the updated workspace. */
@Controller('w/:slug/customer-tiers')
export class CustomerTiersController {
  constructor(private readonly tiers: CustomerTiersService) {}

  @Post()
  @Roles('admin')
  async create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateTierDto) {
    return Object.assign(await this.tiers.create(ctx, dto), { role: ctx.role });
  }

  @Patch(':id')
  @Roles('admin')
  async update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateTierDto) {
    return Object.assign(await this.tiers.update(ctx, id, dto), { role: ctx.role });
  }

  @Delete(':id')
  @Roles('admin')
  async remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return Object.assign(await this.tiers.remove(ctx, id), { role: ctx.role });
  }
}
