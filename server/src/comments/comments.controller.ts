import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Ctx, Roles, type WorkspaceContext } from '../auth/request-context.js';
import type { SubjectType } from '../contracts/domain.js';
import { CommentsService } from './comments.service.js';

const SUBJECTS: SubjectType[] = ['workstream', 'issue', 'artifact', 'decision', 'input_request', 'repository', 'team'];

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

@Controller('w/:slug/comments')
export class CommentsController {
  constructor(private readonly service: CommentsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListCommentsQuery) {
    return this.service.list(ctx.workspace.id, q);
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
