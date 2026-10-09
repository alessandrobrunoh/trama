import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import type { ActorRef } from '../contracts/domain.js';
import { OptionalNotNull } from '../common/validation.js';
import { CustomersService } from './customers.service.js';

class CreateCustomerDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsString() @MinLength(1) @MaxLength(300) domain: string;
}

class UpdateCustomerDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) domain?: string;
  @IsOptional() @IsBoolean() archived?: boolean;
}

class ListCustomersQuery {
  @IsOptional() @IsIn(['true', 'false', 'all']) archived?: 'true' | 'false' | 'all';
  @IsOptional() @IsString() issueId?: string;
  @IsOptional() @IsString() q?: string;
}

class LinkCustomerDto {
  @IsString() @MinLength(1) @MaxLength(100) issueId: string;
  @IsOptional() @IsString() @MaxLength(4000) body?: string;
}

@Controller('w/:slug/customers')
export class CustomersController {
  constructor(private readonly service: CustomersService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListCustomersQuery) {
    return this.service.list(ctx.workspace.id, q);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.get(ctx.workspace.id, id);
  }

  @Get(':id/requests')
  requests(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.requestsFor(ctx.workspace.id, id);
  }

  @Post()
  @Can('manageCustomers')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateCustomerDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  @Can('manageCustomers')
  update(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @Can('deleteCustomers')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }

  @Post(':id/requests')
  @Can('manageCustomers')
  link(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: LinkCustomerDto,
  ) {
    return this.service.link(ctx.workspace.id, actor, id, dto);
  }

  /** POST, not DELETE: unlinking is everyday customer work, not `customers:delete`. */
  @Post(':id/requests/:requestId/unlink')
  @Can('manageCustomers')
  @HttpCode(204)
  unlink(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ) {
    return this.service.unlink(ctx.workspace.id, actor, id, requestId);
  }
}
