import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, InputRequestState } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { InputRequestsService } from './input-requests.service.js';

class CreateInputRequestDto {
  @IsString() workstreamId: string;
  @IsString() @MinLength(1) @MaxLength(2000) question: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) options?: string[];
  @IsOptional() @IsString() assigneeUserId?: string;
}

class UpdateInputRequestDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(2000) question?: string;
  @Clearable() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) options?: string[] | null;
  @Clearable() @IsString() assigneeUserId?: string | null;
}

class AnswerDto {
  @IsString() @MinLength(1) @MaxLength(10000) answer: string;
}

class ListQuery {
  @IsOptional() @IsIn(['open', 'answered', 'dismissed']) state?: InputRequestState;
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsString() assigneeUserId?: string;
}

@Controller('w/:slug/input-requests')
export class InputRequestsController {
  constructor(private readonly service: InputRequestsService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateInputRequestDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: UpdateInputRequestDto) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  @Post(':id/answer')
  @HttpCode(200)
  answer(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: AnswerDto) {
    return this.service.answer(ctx.workspace.id, actor, id, dto.answer);
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  dismiss(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.dismiss(ctx.workspace.id, actor, id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }
}
