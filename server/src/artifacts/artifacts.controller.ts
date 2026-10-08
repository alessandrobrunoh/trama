import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type {
  ActorRef,
  ArtifactKind,
  ArtifactProvider,
  ArtifactState,
  CiState,
  ReviewState,
} from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { ArtifactsService } from './artifacts.service.js';

const KINDS: ArtifactKind[] = ['pull_request', 'merge_request', 'document', 'design', 'image', 'file', 'build', 'test_report', 'deployment', 'release'];
const PROVIDERS: ArtifactProvider[] = ['github', 'gitlab', 'delta', 'figma', 'docs', 'ci', 'other'];
const STATES: ArtifactState[] = ['draft', 'open', 'merged', 'closed', 'pending', 'running', 'succeeded', 'failed', 'healthy', 'degraded', 'published'];
const CI: CiState[] = ['pending', 'passing', 'failing'];
const REVIEW: ReviewState[] = ['none', 'requested', 'approved', 'changes_requested'];

class CreateArtifactDto {
  @IsString() workstreamId: string;
  @IsIn(KINDS) kind: ArtifactKind;
  @IsString() @MinLength(1) @MaxLength(300) title: string;
  @IsOptional() @IsString() repositoryId?: string;
  @IsOptional() @IsIn(PROVIDERS) provider?: ArtifactProvider;
  @IsOptional() @IsString() @MaxLength(1000) url?: string;
  @IsOptional() @IsString() @MaxLength(200) externalId?: string;
  @IsOptional() @IsIn(STATES) state?: ArtifactState;
  @IsOptional() @IsIn(CI) ci?: CiState;
  @IsOptional() @IsIn(REVIEW) review?: ReviewState;
  @IsOptional() @IsBoolean() hasConflicts?: boolean;
  @IsOptional() @IsString() @MaxLength(100) environment?: string;
}

class UpdateArtifactDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  @Clearable() @IsString() repositoryId?: string | null;
  @OptionalNotNull() @IsIn(PROVIDERS) provider?: ArtifactProvider;
  @Clearable() @IsString() @MaxLength(1000) url?: string | null;
  @Clearable() @IsString() @MaxLength(200) externalId?: string | null;
  @OptionalNotNull() @IsIn(STATES) state?: ArtifactState;
  @Clearable() @IsIn(CI) ci?: CiState | null;
  @Clearable() @IsIn(REVIEW) review?: ReviewState | null;
  @Clearable() @IsBoolean() hasConflicts?: boolean | null;
  @Clearable() @IsString() @MaxLength(100) environment?: string | null;
}

class ListArtifactsQuery {
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsString() repositoryId?: string;
  @IsOptional() @IsIn(KINDS) kind?: ArtifactKind;
  @IsOptional() @IsIn(STATES) state?: ArtifactState;
}

@Controller('w/:slug/artifacts')
export class ArtifactsController {
  constructor(private readonly service: ArtifactsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListArtifactsQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateArtifactDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: UpdateArtifactDto) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }
}
