import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Actor, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef, DependencyNodeType } from '../contracts/domain.js';
import { DependenciesService } from './dependencies.service.js';

const NODE_TYPES = ['workstream', 'execution'];

class CreateDependencyDto {
  @IsIn(NODE_TYPES) fromType: DependencyNodeType;
  @IsString() fromId: string;
  @IsIn(NODE_TYPES) toType: DependencyNodeType;
  @IsString() toId: string;
}

class ListDependenciesQuery {
  @IsOptional() @IsString() fromId?: string;
  @IsOptional() @IsString() toId?: string;
}

/** `from` blocks `to` until `from` is shipped (workstream) / completed (execution). Cycles are rejected with 409. */
@Controller('w/:slug/dependencies')
export class DependenciesController {
  constructor(private readonly service: DependenciesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListDependenciesQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Post()
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateDependencyDto) {
    return this.service.create(
      ctx.workspace.id,
      actor,
      { type: dto.fromType, id: dto.fromId },
      { type: dto.toType, id: dto.toId },
    );
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }
}
