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

const KINDS: ArtifactKind[] = ['pull_request', 'merge_request', 'document', 'link', 'design', 'image', 'file', 'build', 'test_report', 'deployment', 'release'];
const PROVIDERS: ArtifactProvider[] = ['github', 'gitlab', 'bitbucket', 'delta', 'figma', 'docs', 'ci', 'other'];
const STATES: ArtifactState[] = ['draft', 'open', 'merged', 'closed', 'pending', 'running', 'succeeded', 'failed', 'healthy', 'degraded', 'published'];
const CI: CiState[] = ['pending', 'passing', 'failing'];
const REVIEW: ReviewState[] = ['none', 'requested', 'approved', 'changes_requested'];

class CreateArtifactDto {
  /** At least one of workstreamId / projectId / issueId (the nested routes fill their own owner). */
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() issueId?: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
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
  @Clearable() @IsString() workstreamId?: string | null;
  @Clearable() @IsString() projectId?: string | null;
  @Clearable() @IsString() issueId?: string | null;
  @Clearable() @IsString() @MaxLength(10000) description?: string | null;
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
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() issueId?: string;
  @IsOptional() @IsString() repositoryId?: string;
  @IsOptional() @IsIn(KINDS) kind?: ArtifactKind;
  @IsOptional() @IsIn(STATES) state?: ArtifactState;
}

/** Same filters as `ListArtifactsQuery` minus the owner (it comes from the route). */
class ListOwnedArtifactsQuery {
  @IsOptional() @IsString() repositoryId?: string;
  @IsOptional() @IsIn(KINDS) kind?: ArtifactKind;
  @IsOptional() @IsIn(STATES) state?: ArtifactState;
}

@Controller('w/:slug')
export class ArtifactsController {
  constructor(private readonly service: ArtifactsService) {}

  @Get('artifacts')
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListArtifactsQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get('artifacts/:id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post('artifacts')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateArtifactDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch('artifacts/:id')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: UpdateArtifactDto) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  @Delete('artifacts/:id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }

  // ── artifacts attached to one owner (the owner comes from the route and wins over the body) ──

  @Get('workstreams/:idOrKey/artifacts')
  async listForWorkstream(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string, @Query() q: ListOwnedArtifactsQuery) {
    const workstreamId = await this.service.resolveWorkstreamId(ctx.workspace.id, idOrKey);
    return this.service.list(ctx.workspace.id, Object.assign({}, q, { workstreamId }));
  }

  @Post('workstreams/:idOrKey/artifacts')
  async createForWorkstream(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: CreateArtifactDto) {
    const workstreamId = await this.service.resolveWorkstreamId(ctx.workspace.id, idOrKey);
    return this.service.create(ctx.workspace.id, actor, Object.assign({}, dto, { workstreamId }));
  }

  @Get('projects/:id/artifacts')
  async listForProject(@Ctx() ctx: WorkspaceContext, @Param('id') projectId: string, @Query() q: ListOwnedArtifactsQuery) {
    await this.service.assertProject(ctx.workspace.id, projectId);
    return this.service.list(ctx.workspace.id, Object.assign({}, q, { projectId }));
  }

  @Post('projects/:id/artifacts')
  async createForProject(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') projectId: string, @Body() dto: CreateArtifactDto) {
    await this.service.assertProject(ctx.workspace.id, projectId);
    return this.service.create(ctx.workspace.id, actor, Object.assign({}, dto, { projectId }));
  }

  @Get('issues/:idOrKey/artifacts')
  async listForIssue(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string, @Query() q: ListOwnedArtifactsQuery) {
    const issueId = await this.service.resolveIssueId(ctx.workspace.id, idOrKey);
    return this.service.list(ctx.workspace.id, Object.assign({}, q, { issueId }));
  }

  @Post('issues/:idOrKey/artifacts')
  async createForIssue(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('idOrKey') idOrKey: string, @Body() dto: CreateArtifactDto) {
    const issueId = await this.service.resolveIssueId(ctx.workspace.id, idOrKey);
    return this.service.create(ctx.workspace.id, actor, Object.assign({}, dto, { issueId }));
  }
}
