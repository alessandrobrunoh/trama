import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  Actor,
  Can,
  Ctx,
  type WorkspaceContext,
} from '../auth/request-context.js';
import type { ActorRef } from '../contracts/domain.js';
import { LunagestService } from './lunagest.service.js';

class SaveLunaGestConnectionDto {
  @IsString() @MinLength(1) @MaxLength(320) username: string;
  @IsString() @MinLength(1) @MaxLength(2000) password: string;
  @IsOptional() @IsString() @MaxLength(2000) apiKey?: string;
  @IsOptional() @IsString() @MaxLength(500) baseUrl?: string;
}

class BindLunaGestProjectDto {
  @IsString() @MinLength(1) @MaxLength(200) remoteProjectId: string;
}

class LinkLunaGestTaskDto {
  @IsString() @MinLength(1) @MaxLength(200) remoteTaskId: string;
}

class RealignChoiceDto {
  @IsString() @MinLength(1) @MaxLength(100) issueId: string;
  @IsIn(['title', 'description']) field: 'title' | 'description';
  @IsIn(['local', 'remote']) take: 'local' | 'remote';
}

class RealignDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RealignChoiceDto)
  choices?: RealignChoiceDto[];
}

/** One LunaGest login for the workspace. Reading the account is open to members; writing it is `manageIntegrations`. The secret is never returned. */
@Controller('w/:slug/lunagest')
export class LunaGestConnectionController {
  constructor(private readonly service: LunagestService) {}

  @Get('connection')
  get(@Ctx() ctx: WorkspaceContext) {
    return this.service.getConnection(ctx.workspace.id);
  }

  /** Projects a manager can bind. Does not create a remote project. */
  @Get('remote-projects')
  @Can('manageProjects')
  remoteProjects(@Ctx() ctx: WorkspaceContext) {
    return this.service.listRemoteProjects(ctx.workspace.id);
  }

  @Put('connection')
  @Can('manageIntegrations')
  save(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Body() dto: SaveLunaGestConnectionDto,
  ) {
    return this.service.saveConnection(ctx.workspace.id, actor, dto);
  }

  @Delete('connection')
  @Can('manageIntegrations')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext) {
    return this.service.removeConnection(ctx.workspace.id);
  }
}

/** Binds one existing LunaGest project to one Trama project. Reading follows project visibility. */
@Controller('w/:slug/projects/:id/lunagest')
export class LunaGestProjectController {
  constructor(private readonly service: LunagestService) {}

  @Get()
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.getLink(ctx.workspace.id, id);
  }

  @Put()
  @Can('manageProjects')
  bind(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() dto: BindLunaGestProjectDto,
  ) {
    return this.service.bind(ctx.workspace.id, id, dto.remoteProjectId);
  }

  @Delete()
  @Can('manageProjects')
  @HttpCode(204)
  unbind(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.unbind(ctx.workspace.id, id);
  }

  @Post('realign')
  @Can('manageProjects')
  realign(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: RealignDto,
  ) {
    return this.service.realign(ctx.workspace.id, actor, id, dto.choices ?? []);
  }
}

/** Task push and manual link for one issue. A failed push does not remove the issue. */
@Controller('w/:slug/issues/:idOrKey/lunagest')
export class LunaGestIssueController {
  constructor(private readonly service: LunagestService) {}

  @Get()
  get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.getIssueLink(ctx.workspace.id, idOrKey);
  }

  @Get('remote-tasks')
  remoteTasks(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.listRemoteTasks(ctx.workspace.id, idOrKey);
  }

  @Post('push')
  push(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.service.pushIssue(ctx.workspace.id, idOrKey);
  }

  @Put()
  link(
    @Ctx() ctx: WorkspaceContext,
    @Param('idOrKey') idOrKey: string,
    @Body() dto: LinkLunaGestTaskDto,
  ) {
    return this.service.linkIssueTask(ctx.workspace.id, idOrKey, dto.remoteTaskId);
  }
}
