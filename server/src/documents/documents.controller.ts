import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { DOCUMENT_LIMITS } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { DocumentsService, MAX_LIST_LIMIT } from './documents.service.js';

/** Empty strings from a form or CLI flag mean "not given". */
const blankToUndefined = Transform(({ value }: { value: unknown }) =>
  value === '' ? undefined : value,
);

class ListDocumentsQuery {
  /** Full-text search over title and body (every word is a prefix). */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
  @IsOptional() @blankToUndefined @IsString() @MaxLength(64) projectId?: string;
  /** Workstream id or key. */
  @IsOptional()
  @blankToUndefined
  @IsString()
  @MaxLength(64)
  workstreamId?: string;
  /** Issue id or key. */
  @IsOptional() @blankToUndefined @IsString() @MaxLength(64) issueId?: string;
  /** `true`: attached to something. `false`: loose documents. */
  @IsOptional() @blankToUndefined @IsIn(['true', 'false']) attached?:
    'true' | 'false';
  @IsOptional() @blankToUndefined @IsIn(['false', 'only', 'all']) archived?:
    'false' | 'only' | 'all';
  /** Actor id (`usr_…` or `ag_…`) of the author. */
  @IsOptional() @blankToUndefined @IsString() @MaxLength(64) authorId?: string;
  @IsOptional() @blankToUndefined @IsIn(['updated', 'created', 'title']) sort?:
    'updated' | 'created' | 'title';
  @IsOptional() @blankToUndefined @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIST_LIMIT)
  limit?: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100_000)
  offset?: number;
}

class CreateDocumentDto {
  @IsString() @MinLength(1) @MaxLength(DOCUMENT_LIMITS.titleMax) title: string;
  @IsOptional() @IsString() @MaxLength(DOCUMENT_LIMITS.bodyMax) body?: string;
  @Clearable() @IsString() @MaxLength(32) icon?: string | null;
  @IsOptional() @IsString() @MaxLength(64) projectId?: string;
  /** Workstream id or key. */
  @IsOptional() @IsString() @MaxLength(64) workstreamId?: string;
  /** Issue id or key. */
  @IsOptional() @IsString() @MaxLength(64) issueId?: string;
}

class UpdateDocumentDto {
  /** The `version` this edit is based on; a stale one answers 409 with the current document. */
  @Type(() => Number) @IsInt() @Min(1) baseVersion: number;
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(DOCUMENT_LIMITS.titleMax)
  title?: string;
  @OptionalNotNull()
  @IsString()
  @MaxLength(DOCUMENT_LIMITS.bodyMax)
  body?: string;
  @Clearable() @IsString() @MaxLength(32) icon?: string | null;
}

class RestoreRevisionDto {
  @Type(() => Number) @IsInt() @Min(1) baseVersion: number;
}

class AttachDto {
  @IsOptional() @IsString() @MaxLength(64) projectId?: string;
  @IsOptional() @IsString() @MaxLength(64) workstreamId?: string;
  @IsOptional() @IsString() @MaxLength(64) issueId?: string;
}

class DetachDto {
  @IsString() @MinLength(1) @MaxLength(64) artifactId: string;
}

/**
 * Any member can read, create and edit documents (like a wiki); deleting needs the author or an admin
 * (checked in the service). The route's permission is `documents:read|write|delete`.
 */
@Controller('w/:slug/documents')
export class DocumentsController {
  constructor(private readonly service: DocumentsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListDocumentsQuery) {
    return this.service.list(
      ctx.workspace.id,
      Object.assign({}, q, {
        attached: q.attached === undefined ? undefined : q.attached === 'true',
      }),
    );
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateDocumentDto) {
    return this.service.create(ctx, dto);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Patch(':id')
  update(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() dto: UpdateDocumentDto,
  ) {
    return this.service.update(ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ctx, id);
  }

  @Post(':id/archive')
  @HttpCode(200)
  archive(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.archive(ctx, id);
  }

  @Post(':id/restore')
  @HttpCode(200)
  restore(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.restore(ctx, id);
  }

  @Get(':id/revisions')
  revisions(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.revisions(ctx.workspace.id, id);
  }

  @Get(':id/revisions/:version')
  revision(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.service.revision(ctx.workspace.id, id, version);
  }

  @Post(':id/revisions/:version/restore')
  @HttpCode(200)
  restoreRevision(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() dto: RestoreRevisionDto,
  ) {
    return this.service.restoreRevision(ctx, id, version, dto.baseVersion);
  }

  @Post(':id/attach')
  @HttpCode(200)
  attach(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() dto: AttachDto,
  ) {
    return this.service.attach(ctx, id, dto);
  }

  @Post(':id/detach')
  @HttpCode(200)
  detach(
    @Ctx() ctx: WorkspaceContext,
    @Param('id') id: string,
    @Body() dto: DetachDto,
  ) {
    return this.service.detach(ctx, id, dto.artifactId);
  }
}
