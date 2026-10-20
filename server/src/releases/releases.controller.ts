import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Actor, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type {
  ActorRef,
  ReleasePipelineType,
  ReleaseStatus,
} from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { ReleasesService } from './releases.service.js';

const PIPELINE_TYPES: ReleasePipelineType[] = ['continuous', 'scheduled'];
const RELEASE_STATUSES: ReleaseStatus[] = ['draft', 'released', 'canceled'];

class CreatePipelineDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsIn(PIPELINE_TYPES) type?: ReleasePipelineType;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsBoolean() moveOpenIssuesToNext?: boolean;
}

class UpdatePipelineDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @OptionalNotNull() @IsIn(PIPELINE_TYPES) type?: ReleasePipelineType;
  @Clearable() @IsString() teamId?: string | null;
  @OptionalNotNull() @IsBoolean() moveOpenIssuesToNext?: boolean;
}

class CreateReleaseDto {
  @IsString() pipelineId: string;
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(100000) notes?: string;
  @IsOptional() @IsISO8601() targetAt?: string;
}

class UpdateReleaseDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @Clearable() @IsString() @MaxLength(100000) notes?: string | null;
  @Clearable() @IsISO8601() targetAt?: string | null;
  @OptionalNotNull() @IsIn(RELEASE_STATUSES) status?: ReleaseStatus;
}

class ListReleasesQuery {
  @IsOptional() @IsString() pipelineId?: string;
}

class CompleteReleaseDto {
  @IsOptional() @IsBoolean() moveOpenIssuesToDone?: boolean;
  @IsOptional() @IsString() targetStatusId?: string;
  @IsOptional() @IsBoolean() moveOpenIssuesToNext?: boolean;
}

@Controller('w/:slug/releases/pipelines')
export class ReleasePipelinesController {
  constructor(private readonly service: ReleasesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.listPipelines(ctx.workspace.id);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.getPipeline(ctx.workspace.id, id);
  }

  @Post()
  create(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Body() dto: CreatePipelineDto,
  ) {
    return this.service.createPipeline(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  update(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: UpdatePipelineDto,
  ) {
    return this.service.updatePipeline(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
  ) {
    return this.service.removePipeline(ctx.workspace.id, actor, id);
  }
}

@Controller('w/:slug/releases')
export class ReleasesController {
  constructor(private readonly service: ReleasesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListReleasesQuery) {
    return this.service.listReleases(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.getRelease(ctx.workspace.id, id);
  }

  @Post()
  create(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Body() dto: CreateReleaseDto,
  ) {
    return this.service.createRelease(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  update(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: UpdateReleaseDto,
  ) {
    return this.service.updateRelease(ctx.workspace.id, actor, id, dto);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: CompleteReleaseDto,
  ) {
    return this.service.complete(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
  ) {
    return this.service.removeRelease(ctx.workspace.id, actor, id);
  }
}
