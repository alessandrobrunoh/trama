import {
  Body,
  Controller,
  ForbiddenException,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  Actor,
  Can,
  Ctx,
  EditsTeamWork,
  canDo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import { CUSTOMER_REVENUE_MAX } from '../contracts/domain.js';
import type {
  ActorRef,
  IssueKind,
  IssueSource,
  IssueStatus,
  Priority,
} from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import {
  CreateWorkstreamDto,
  PRIORITIES,
} from '../workstreams/workstreams.controller.js';
import { CustomersService } from '../customers/customers.service.js';
import { IssuesService } from './issues.service.js';

const KINDS: IssueKind[] = [
  'bug',
  'feature',
  'incident',
  'tech_debt',
  'feedback',
  'idea',
  'security',
];
const STATUSES: IssueStatus[] = [
  'draft',
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
];
const SOURCES: IssueSource[] = [
  'manual',
  'github',
  'gitlab',
  'linear',
  'email',
  'api',
  'agent',
];

class CreateIssueDto {
  @IsIn(KINDS) kind: IssueKind;
  @IsString() @MinLength(1) @MaxLength(300) title: string;
  @IsOptional() @IsString() @MaxLength(20000) body?: string;
  @IsOptional() @IsIn(SOURCES) source?: IssueSource;
  @IsOptional() @IsString() @MaxLength(200) reporterName?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsIn(STATUSES) status?: IssueStatus;
  @IsOptional() @IsString() @MaxLength(500) externalUrl?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) estimate?: number;
  /** Workspace label ids. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) labels?: string[];
}

class UpdateIssueDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  /** Changing the kind re-keys the issue (BUG-148 → FEAT-35); the old key stays valid as an alias. */
  @OptionalNotNull() @IsIn(KINDS) kind?: IssueKind;
  /** Story points: non-negative number, `null` clears. */
  @Clearable() @IsNumber() @Min(0) @Max(1000) estimate?: number | null;
  @Clearable() @IsString() @MaxLength(20000) body?: string | null;
  @Clearable() @IsString() @MaxLength(200) reporterName?: string | null;
  @Clearable() @IsString() assigneeId?: string | null;
  @Clearable() @IsString() teamId?: string | null;
  /** Project the issue is planned under. `null` clears it and drops that project's milestone. */
  @Clearable() @IsString() projectId?: string | null;
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @OptionalNotNull() @IsIn(STATUSES) status?: IssueStatus;
  @Clearable() @IsString() @MaxLength(500) externalUrl?: string | null;
  @OptionalNotNull()
  @IsArray()
  @IsString({ each: true })
  workstreamIds?: string[];
  /** At most one milestone per project, from `projectId` or the linked workstreams' projects. */
  @OptionalNotNull()
  @IsArray()
  @IsString({ each: true })
  milestoneIds?: string[];
  /** Id or key of the issue this duplicates. `null` clears it. */
  @Clearable() @IsString() duplicateOfId?: string | null;
  /** Workspace label ids. Replaces the whole list. */
  @OptionalNotNull() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) labels?: string[];
}

class LinkIssueDto {
  @IsOptional() @IsArray() @IsString({ each: true }) workstreamIds?: string[];
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateWorkstreamDto)
  createWorkstream?: CreateWorkstreamDto;
  @IsOptional() @IsIn(STATUSES) status?: IssueStatus;
}

class ListIssueQuery {
  @IsOptional() @IsIn(KINDS) kind?: IssueKind;
  @IsOptional() @IsIn(STATUSES) status?: IssueStatus;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() workstreamId?: string;
  @IsOptional() @IsString() milestoneId?: string;
  @IsOptional() @IsString() customerId?: string;
  /** At least this many distinct linked customers. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) minCustomers?: number;
  /** At least this many customer requests. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) minRequests?: number;
  /** Only issues a customer of this tier asked for. */
  @IsOptional() @IsString() @MaxLength(100) tierId?: string;
  /** The requesting customers' revenue adds up to at least this. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(CUSTOMER_REVENUE_MAX) minRevenue?: number;
  /** `true`: only issues with at least one request flagged important. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  important?: boolean;
  @IsOptional() @IsString() q?: string;
  /** Comma-separated priorities, e.g. `high,urgent`. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').map((p) => p.trim()).filter(Boolean) : value))
  @IsArray()
  @IsIn(PRIORITIES, { each: true })
  priority?: Priority[];
  /** `true`: only issues still being worked on (backlog, todo, in progress, in review). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  open?: boolean;
  /** Newest first; at most this many (1-500). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@Controller('w/:slug/issues')
@EditsTeamWork('issue')
export class IssuesController {
  constructor(
    private readonly service: IssuesService,
    private readonly customers: CustomersService,
  ) {}

  @Get()
  async list(@Ctx() ctx: WorkspaceContext, @Query() q: ListIssueQuery) {
    return this.withCounts(ctx, await this.service.list(ctx.workspace.id, q));
  }

  @Get(':idOrKey')
  async get(@Ctx() ctx: WorkspaceContext, @Param('idOrKey') idOrKey: string) {
    return this.withCounts(ctx, await this.service.get(ctx.workspace.id, idOrKey));
  }

  @Post()
  @Can('createIssues')
  async create(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Body() dto: CreateIssueDto,
  ) {
    return this.withCounts(ctx, await this.service.create(ctx.workspace.id, actor, dto));
  }

  @Patch(':idOrKey')
  async update(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
    @Body() dto: UpdateIssueDto,
  ) {
    return this.withCounts(ctx, await this.service.update(ctx.workspace.id, actor, idOrKey, dto));
  }

  /** Link to existing workstreams and/or create one. Does not change the issue status unless `status` is given. */
  @Post(':idOrKey/link')
  @HttpCode(200)
  async link(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
    @Body() dto: LinkIssueDto,
  ) {
    if (dto.createWorkstream && !canDo(ctx, 'createWorkstreams'))
      throw new ForbiddenException('You are not allowed to create workstreams');
    return this.withCounts(ctx, await this.service.link(ctx.workspace.id, actor, idOrKey, dto));
  }

  @Delete(':idOrKey')
  @Can('deleteIssues')
  @HttpCode(204)
  remove(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
  ) {
    return this.service.remove(ctx.workspace.id, actor, idOrKey);
  }

  private async withCounts<T extends { id: string }>(ctx: WorkspaceContext, rows: T): Promise<T>;
  private async withCounts<T extends { id: string }>(ctx: WorkspaceContext, rows: T[]): Promise<T[]>;
  private async withCounts<T extends { id: string }>(ctx: WorkspaceContext, rows: T | T[]) {
    await this.customers.attachCounts(ctx.workspace.id, Array.isArray(rows) ? rows : [rows]);
    return rows;
  }
}
