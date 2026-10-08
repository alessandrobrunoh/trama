import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Actor, Can, Ctx, canDo, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, TeamEditPolicy } from '../contracts/domain.js';
import { PermissionsService } from '../workspaces/permissions.service.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { TeamsService } from './teams.service.js';

class CreateTeamDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  /** Uppercase identifier prefix (AUTH, WEB…). Immutable after creation: workstream keys depend on it. */
  @Matches(/^[A-Z][A-Z0-9]{1,7}$/, { message: 'key must be 2-8 uppercase letters/digits' }) key: string;
  @IsOptional() @IsString() @MaxLength(32) color?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) memberIds?: string[];
  /** Must be a subset of `memberIds`. */
  @IsOptional() @IsArray() @IsString({ each: true }) leadIds?: string[];
  @IsOptional() @IsIn(['workspace', 'members']) editPolicy?: TeamEditPolicy;
}

class UpdateTeamDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @OptionalNotNull() @IsString() @MaxLength(32) color?: string;
  @Clearable() @IsString() @MaxLength(500) description?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) memberIds?: string[];
  @OptionalNotNull() @IsArray() @IsString({ each: true }) leadIds?: string[];
  @OptionalNotNull() @IsIn(['workspace', 'members']) editPolicy?: TeamEditPolicy;
}

@Controller('w/:slug/teams')
export class TeamsController {
  constructor(
    private readonly service: TeamsService,
    private readonly permissions: PermissionsService,
  ) {}

  /** `manageTeams` capability, or being a lead of this very team. */
  private async assertCanManage(ctx: WorkspaceContext, idOrKey: string, leadMay: boolean): Promise<void> {
    if (canDo(ctx, 'manageTeams')) return;
    if (leadMay && (await this.permissions.isLead(ctx, await this.service.get(ctx.workspace.id, idOrKey)))) return;
    throw new ForbiddenException('Requires the manageTeams permission (or being a lead of this team)');
  }

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.list(ctx.workspace.id);
  }

  @Get(':idOrKey')
  get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.get(ctx.workspace.id, idOrKey);
  }

  @Post()
  @Can('createTeams')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateTeamDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':idOrKey')
  async update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: UpdateTeamDto) {
    await this.assertCanManage(ctx, idOrKey, true);
    return this.service.update(ctx.workspace.id, actor, idOrKey, dto);
  }

  @Delete(':idOrKey')
  @HttpCode(204)
  async remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string) {
    await this.assertCanManage(ctx, idOrKey, false);
    return this.service.remove(ctx.workspace.id, actor, idOrKey);
  }
}
