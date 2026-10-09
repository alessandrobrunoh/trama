import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Actor, Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import {
  CUSTOMER_DOMAINS_MAX,
  CUSTOMER_REQUEST_BODY_MAX,
  CUSTOMER_REVENUE_MAX,
  CUSTOMER_SIZE_MAX,
  CUSTOMER_STATUSES,
  type ActorRef,
  type CustomerStatus,
} from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { CustomersService } from './customers.service.js';

class CreateCustomerDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  /** Single domain (kept for older clients). Use `domains` for several. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) domain?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(CUSTOMER_DOMAINS_MAX) @IsString({ each: true }) @MaxLength(300, { each: true })
  domains?: string[];
  @IsOptional() @IsString() @MaxLength(2000) logoUrl?: string;
  @IsOptional() @IsInt() @Min(0) @Max(CUSTOMER_REVENUE_MAX) revenue?: number;
  @IsOptional() @IsInt() @Min(0) @Max(CUSTOMER_SIZE_MAX) size?: number;
  @IsOptional() @IsString() @MaxLength(100) tierId?: string;
  @IsOptional() @IsIn(CUSTOMER_STATUSES) status?: CustomerStatus;
}

class UpdateCustomerDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) domain?: string;
  @OptionalNotNull() @IsArray() @ArrayMaxSize(CUSTOMER_DOMAINS_MAX) @IsString({ each: true }) @MaxLength(300, { each: true })
  domains?: string[];
  @Clearable() @IsString() @MaxLength(2000) logoUrl?: string | null;
  @Clearable() @IsInt() @Min(0) @Max(CUSTOMER_REVENUE_MAX) revenue?: number | null;
  @Clearable() @IsInt() @Min(0) @Max(CUSTOMER_SIZE_MAX) size?: number | null;
  @Clearable() @IsString() @MaxLength(100) tierId?: string | null;
  @OptionalNotNull() @IsIn(CUSTOMER_STATUSES) status?: CustomerStatus;
  @IsOptional() @IsBoolean() archived?: boolean;
}

class ListCustomersQuery {
  @IsOptional() @IsIn(['true', 'false', 'all']) archived?: 'true' | 'false' | 'all';
  @IsOptional() @IsString() issueId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() tierId?: string;
  @IsOptional() @IsIn(CUSTOMER_STATUSES) status?: CustomerStatus;
  @IsOptional() @IsString() q?: string;
}

class CreateCustomerRequestDto {
  /** Exactly one of `issueId` / `projectId`. */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) issueId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) projectId?: string;
  @IsOptional() @IsString() @MaxLength(CUSTOMER_REQUEST_BODY_MAX) body?: string;
  @IsOptional() @IsBoolean() important?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) sourceUrl?: string;
}

class UpdateCustomerRequestDto {
  @Clearable() @IsString() @MaxLength(CUSTOMER_REQUEST_BODY_MAX) body?: string | null;
  @OptionalNotNull() @IsBoolean() important?: boolean;
  @Clearable() @IsString() @MaxLength(2000) sourceUrl?: string | null;
}

class ListCustomerRequestsQuery {
  @IsOptional() @IsString() customerId?: string;
  @IsOptional() @IsString() issueId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsIn(['true', 'false']) important?: 'true' | 'false';
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
  createRequest(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Body() dto: CreateCustomerRequestDto,
  ) {
    return this.service.createRequest(ctx.workspace.id, actor, id, dto);
  }

  @Patch(':id/requests/:requestId')
  @Can('manageCustomers')
  updateRequest(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
    @Body() dto: UpdateCustomerRequestDto,
  ) {
    return this.service.updateRequest(ctx.workspace.id, actor, id, requestId, dto);
  }

  /**
   * POST, not DELETE: removing a request is everyday customer work, not `customers:delete`.
   * Kept as the verb older clients and the MCP/CLI catalog use.
   */
  @Post(':id/requests/:requestId/unlink')
  @Can('manageCustomers')
  @HttpCode(204)
  unlink(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('id') id: string,
    @Param('requestId') requestId: string,
  ) {
    return this.service.removeRequest(ctx.workspace.id, actor, id, requestId);
  }
}

/** Requests across customers: what is asked on an issue, on a project, or flagged important. */
@Controller('w/:slug/customer-requests')
export class CustomerRequestsController {
  constructor(private readonly service: CustomersService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext, @Query() q: ListCustomerRequestsQuery) {
    return this.service.listRequests(ctx.workspace.id, {
      ...(q.customerId ? { customerId: q.customerId } : {}),
      ...(q.issueId ? { issueId: q.issueId } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.important ? { important: q.important === 'true' } : {}),
    });
  }
}
