import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Ctx, Roles, type WorkspaceContext } from '../auth/request-context.js';
import { COMMENT_PAGE_SIZE, type SubjectType } from '../contracts/domain.js';
import { CommentsService } from './comments.service.js';

const SUBJECTS: SubjectType[] = ['workstream', 'issue', 'artifact', 'decision', 'input_request', 'repository', 'team', 'project', 'project_update', 'document'];

class SubjectDto {
  @IsIn(SUBJECTS) type: SubjectType;
  @IsString() id: string;
}

class CreateCommentDto {
  @ValidateNested() @Type(() => SubjectDto) subject: SubjectDto;
  @IsString() @MinLength(1) @MaxLength(20000) body: string;
}

class UpdateCommentDto {
  @IsString() @MinLength(1) @MaxLength(20000) body: string;
}

class ListCommentsQuery {
  @IsOptional() @IsIn(SUBJECTS) subjectType?: SubjectType;
  @IsOptional() @IsString() subjectId?: string;
}

export class PageCommentsQuery {
  @IsIn(SUBJECTS) subjectType: SubjectType;
  @IsString() @IsNotEmpty() @MaxLength(64) subjectId: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(COMMENT_PAGE_SIZE.max) limit?: number;
  @IsOptional() @IsString() @MaxLength(200) cursor?: string;
}

@Controller('w/:slug/comments')
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListCommentsQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  /** Cursor-paginated comments of one subject, newest first (`CommentPage`). Declared before `:id`. */
  @Get('page')
  page(@Ctx() ctx: WorkspaceContext, @Query() q: PageCommentsQuery) {
    return this.service.page(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateCommentDto) {
    return this.service.create(ctx, dto.subject, dto.body);
  }

  @Patch(':id')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateCommentDto) {
    return this.service.update(ctx, id, dto.body);
  }

  @Delete(':id')
  @Roles('member')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.remove(ctx, id);
  }
}
