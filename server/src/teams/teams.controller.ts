import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Actor, Ctx, Roles, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { TeamsService } from './teams.service.js';

class CreateTeamDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  /** Uppercase identifier prefix (AUTH, WEB…). Immutable after creation: workstream keys depend on it. */
  @Matches(/^[A-Z][A-Z0-9]{1,7}$/, { message: 'key must be 2-8 uppercase letters/digits' }) key: string;
  @IsOptional() @IsString() @MaxLength(32) color?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) memberIds?: string[];
}

class UpdateTeamDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @OptionalNotNull() @IsString() @MaxLength(32) color?: string;
  @Clearable() @IsString() @MaxLength(500) description?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) memberIds?: string[];
}

@Controller('w/:slug/teams')
export class TeamsController {
  constructor(private readonly service: TeamsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id);
  }

  @Get(':idOrKey')
  get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.get(ctx.workspace.id, idOrKey);
  }

  @Post()
  @Roles('admin')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateTeamDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':idOrKey')
  @Roles('admin')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: UpdateTeamDto) {
    return this.service.update(ctx.workspace.id, actor, idOrKey, dto);
  }

  @Delete(':idOrKey')
  @Roles('admin')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    return this.service.remove(ctx.workspace.id, actor, idOrKey);
  }
}
