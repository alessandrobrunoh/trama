import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, Max, Min, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Actor, Can, Ctx, type WorkspaceContext } from '../auth/request-context.js';
import { CUSTOMER_REVENUE_MAX, PROJECT_STATUSES, type ActorRef, type Priority, type ProjectStatus } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { PROJECT_ICON_MAX, PROJECT_ICON_PATTERN } from './project-icon.js';
import { CustomersService } from '../customers/customers.service.js';
import { ProjectsService } from './projects.service.js';

const PRIORITIES: Priority[] = ['none', 'urgent', 'high', 'medium', 'low'];
const COLOR = /^#[0-9a-fA-F]{6}$/;

class CreateProjectDto {
  @IsString() @MinLength(1) @MaxLength(200) name: string;
  @IsOptional() @IsString() @MaxLength(300) summary?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @Matches(COLOR) color?: string;
  @IsOptional() @IsString() @MaxLength(PROJECT_ICON_MAX) @Matches(PROJECT_ICON_PATTERN) icon?: string;
  @IsOptional() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) teamIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
  /** Workspace label ids. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) labels?: string[];
  @IsOptional() @IsISO8601() startDate?: string;
  @IsOptional() @IsISO8601() targetDate?: string;
}

class UpdateProjectDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @Clearable() @IsString() @MaxLength(300) summary?: string | null;
  @Clearable() @IsString() @MaxLength(20000) description?: string | null;
  @OptionalNotNull() @Matches(COLOR) color?: string;
  @Clearable() @IsString() @MaxLength(PROJECT_ICON_MAX) @Matches(PROJECT_ICON_PATTERN) icon?: string | null;
  @OptionalNotNull() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @Clearable() @IsString() leadId?: string | null;
  @OptionalNotNull() @IsArray() @IsString({ each: true }) teamIds?: string[];
  @OptionalNotNull() @IsArray() @IsString({ each: true }) repositoryIds?: string[];
  /** Workspace label ids. Replaces the whole list. */
  @OptionalNotNull() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) labels?: string[];
  @Clearable() @IsISO8601() startDate?: string | null;
  @Clearable() @IsISO8601() targetDate?: string | null;
}

class ListProjectsQuery {
  @IsOptional() @IsIn(PROJECT_STATUSES) status?: ProjectStatus;
  @IsOptional() @IsString() teamId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() repositoryId?: string;
  @IsOptional() @IsString() q?: string;
  /** Only projects this customer asked for. */
  @IsOptional() @IsString() @MaxLength(100) customerId?: string;
  /** Only projects a customer of this tier asked for. */
  @IsOptional() @IsString() @MaxLength(100) tierId?: string;
  /** At least this many distinct requesting customers. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) minCustomers?: number;
  /** At least this many customer requests. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) minRequests?: number;
  /** The requesting customers' revenue adds up to at least this. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(CUSTOMER_REVENUE_MAX) minRevenue?: number;
  /** `true`: only projects with at least one request flagged important. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  important?: boolean;
}

@Controller('w/:slug/projects')
export class ProjectsController {
  constructor(
    private readonly service: ProjectsService,
    private readonly customers: CustomersService,
  ) {}

  @Get()
  async list(@Ctx() ctx: WorkspaceContext, @Query() q: ListProjectsQuery) {
    return this.customers.attachProjectCounts(ctx.workspace.id, await this.service.list(ctx.workspace.id, q));
  }

  @Get(':id')
  async get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    const row = await this.service.get(ctx.workspace.id, id);
    await this.customers.attachProjectCounts(ctx.workspace.id, [row]);
    return row;
  }

  @Post()
  @Can('manageProjects')
  create(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Body() dto: CreateProjectDto) {
    return this.service.create(ctx.workspace.id, actor, dto);
  }

  @Patch(':id')
  @Can('manageProjects')
  update(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string, @Body() dto: UpdateProjectDto) {
    return this.service.update(ctx.workspace.id, actor, id, dto);
  }

  @Delete(':id')
  @Can('manageProjects')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Actor() actor: ActorRef, @Param('id') id: string) {
    return this.service.remove(ctx.workspace.id, actor, id);
  }
}
