import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  Actor,
  Auth,
  Can,
  Ctx,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import { projectHidden } from '../auth/member-access.js';
import { isPlanArtifact } from '../contracts/domain.js';
import type {
  ActorRef,
  IssueKind,
  IssueSource,
  Priority,
} from '../contracts/domain.js';
import { Clearable, IsThreadUrl, OptionalNotNull } from '../common/validation.js';
import { ArtifactsService } from '../artifacts/artifacts.service.js';
import { renderIssueBriefing } from './issue-briefing.js';
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
const PRIORITIES: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];
const SOURCES: IssueSource[] = [
  'manual',
  'github',
  'gitlab',
  'linear',
  'email',
  'api',
  'agent',
];

/** Custom tokens must not learn artifact metadata without the artifacts resource permission. */
function canReadArtifacts(auth: AuthInfo): boolean {
  return (
    auth.token?.scope !== 'custom' ||
    auth.token.permissions?.includes('artifacts:read') === true
  );
}

/** A seeded issue status, or an id created in workspace settings (`st_…`). */
const ISSUE_STATUS_INPUT =
  /^(draft|backlog|todo|in_progress|in_review|done|canceled|st_[a-z0-9]+)$/;

class CreateIssueDto {
  @IsIn(KINDS) kind: IssueKind;
  @IsString() @MinLength(1) @MaxLength(300) title: string;
  @IsOptional() @IsString() @MaxLength(20000) body?: string;
  @IsOptional() @IsIn(SOURCES) source?: IssueSource;
  @IsOptional() @IsString() @MaxLength(200) reporterName?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsString() projectId?: string;
  /** Id or key of the parent issue. */
  @IsOptional() @IsString() parentId?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: Priority;
  @IsOptional() @Matches(ISSUE_STATUS_INPUT) status?: string;
  @IsOptional() @IsString() @MaxLength(500) externalUrl?: string;
  /** Link to the Delta thread worked on for this task (http/https, at most 2048 characters). */
  @IsOptional() @IsString() @IsThreadUrl() threadUrl?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1000) estimate?: number;
  /** Workspace label ids. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  labels?: string[];
}

class UpdateIssueDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(300) title?: string;
  /** Changes the issue classification without changing its key. */
  @OptionalNotNull() @IsIn(KINDS) kind?: IssueKind;
  /** Story points: non-negative number, `null` clears. */
  @Clearable() @IsNumber() @Min(0) @Max(1000) estimate?: number | null;
  @Clearable() @IsString() @MaxLength(20000) body?: string | null;
  @Clearable() @IsString() @MaxLength(200) reporterName?: string | null;
  @Clearable() @IsString() assigneeId?: string | null;
  /** Project the issue is planned under. `null` clears it and drops that project's milestone. */
  @Clearable() @IsString() projectId?: string | null;
  /** Id or key of the parent issue. `null` makes this issue a root issue. */
  @Clearable() @IsString() parentId?: string | null;
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @OptionalNotNull() @Matches(ISSUE_STATUS_INPUT) status?: string;
  @Clearable() @IsString() @MaxLength(500) externalUrl?: string | null;
  /** Link to the Delta thread worked on for this task. `null` clears it. */
  @Clearable() @IsString() @IsThreadUrl() threadUrl?: string | null;
  /** At most one milestone per project, from the issue's project. */
  @OptionalNotNull()
  @IsArray()
  @IsString({ each: true })
  milestoneIds?: string[];
  /** Id or key of the issue this duplicates. `null` clears it. */
  @Clearable() @IsString() duplicateOfId?: string | null;
  /** Workspace label ids. Replaces the whole list. */
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  labels?: string[];
}

/** At most this many issues per bulk request. */
export const BULK_ISSUES_MAX = 100;

/** Ids or keys of the issues a bulk request acts on. */
class IssueRefsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_ISSUES_MAX)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  ids: string[];
}

/** One change applied to every issue. Labels are added / removed, not replaced. */
export class BulkIssuePatchDto {
  @OptionalNotNull() @Matches(ISSUE_STATUS_INPUT) status?: string;
  @OptionalNotNull() @IsIn(PRIORITIES) priority?: Priority;
  @Clearable() @IsString() assigneeId?: string | null;
  /** `null` clears it and drops that project's milestone. */
  @Clearable() @IsString() projectId?: string | null;
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  addLabels?: string[];
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  removeLabels?: string[];
}

export class BulkUpdateIssuesDto extends IssueRefsDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => BulkIssuePatchDto)
  patch: BulkIssuePatchDto;
}

export class BulkDeleteIssuesDto extends IssueRefsDto {}

class ContextQuery {
  @IsOptional() @IsIn(['markdown', 'json']) format?: 'markdown' | 'json';
}

class ListIssueQuery {
  @IsOptional() @IsIn(KINDS) kind?: IssueKind;
  @IsOptional() @Matches(ISSUE_STATUS_INPUT) status?: string;
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() milestoneId?: string;
  @IsOptional() @IsString() q?: string;
  /** Comma-separated priorities, e.g. `high,urgent`. */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @IsIn(PRIORITIES, { each: true })
  priority?: Priority[];
  /** `true`: only issues still being worked on (backlog, todo, in progress, in review). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  open?: boolean;
  /** Newest first; at most this many (1-500). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit?: number;
}

@Controller('w/:slug/tasks')
export class IssuesController {
  constructor(
    private readonly service: IssuesService,
    private readonly artifacts: ArtifactsService,
  ) {}

  @Get()
  async list(@Ctx() ctx: WorkspaceContext, @Query() q: ListIssueQuery) {
    return this.withCounts(ctx, await this.service.list(ctx.workspace.id, q));
  }

  /**
   * One patch for up to 100 issues, all-or-nothing: unknown issues / references or a team the caller
   * may not edit reject the whole request, and nothing is written. Responds with the updated issues.
   */
  @Post('bulk')
  @HttpCode(200)
  async bulkUpdate(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Body() dto: BulkUpdateIssuesDto,
  ) {
    const rows = await this.service.getMany(ctx.workspace.id, dto.ids);
    await this.assertTeams(ctx, rows);
    const updated = await this.service.updateMany(
      ctx.workspace.id,
      actor,
      rows,
      dto.patch,
    );
    return this.withCounts(ctx, updated);
  }

  /** Delete up to 100 issues in one transaction. Needs the `deleteIssues` capability. */
  @Post('bulk-delete')
  @Can('deleteIssues')
  @HttpCode(200)
  async bulkDelete(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Body() dto: BulkDeleteIssuesDto,
  ) {
    const rows = await this.service.getMany(ctx.workspace.id, dto.ids);
    await this.assertTeams(ctx, rows);
    await this.service.removeMany(
      ctx.workspace.id,
      actor,
      rows,
      (affected) => this.assertTeams(ctx, affected),
    );
    return { deleted: rows.map((r) => r.id) };
  }

  @Get(':idOrKey')
  async get(
    @Ctx() ctx: WorkspaceContext,
    @Auth() auth: AuthInfo,
    @Param('idOrKey') idOrKey: string,
  ) {
    const issue = await this.service.get(ctx.workspace.id, idOrKey);
    const counts = this.withCounts(ctx, issue);
    const artifactCount = canReadArtifacts(auth)
      ? this.artifacts.countForIssue(ctx.workspace.id, issue.id)
      : undefined;
    await counts;
    if (artifactCount !== undefined) issue.artifactCount = await artifactCount;
    return issue;
  }

  /**
   * JSON by default; a markdown briefing (what to know to pick the work up) with `?format=markdown` or
   * `Accept: text/markdown`.
   */
  @Get(':idOrKey/context')
  async context(
    @Ctx() ctx: WorkspaceContext,
    @Auth() auth: AuthInfo,
    @Param('idOrKey') idOrKey: string,
    @Query() q: ContextQuery = {},
    @Req() req?: Request,
    @Res({ passthrough: true }) res?: Response,
  ) {
    const issue = await this.service.get(ctx.workspace.id, idOrKey);
    await this.hideInvisibleParents(ctx, issue);
    const artifacts = canReadArtifacts(auth)
      ? await this.artifacts.list(ctx.workspace.id, { issueId: issue.id })
      : [];
    const wantsMarkdown =
      q.format === 'markdown' ||
      (!q.format &&
        req?.accepts(['application/json', 'text/markdown']) === 'text/markdown');
    if (wantsMarkdown) {
      res?.type('text/markdown; charset=utf-8');
      return renderIssueBriefing({ issue, artifacts });
    }
    const plans = artifacts.filter(isPlanArtifact);
    const latestArtifact = [...plans].sort(
      (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
    )[0];
    return {
      issue,
      planSummary: plans.length
        ? {
            artifactCount: plans.length,
            latestArtifact,
          }
        : undefined,
      artifacts,
    };
  }

  @Post()
  @Can('createIssues')
  async create(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Body() dto: CreateIssueDto,
  ) {
    return this.withCounts(
      ctx,
      await this.service.create(
        ctx.workspace.id,
        actor,
        dto,
        (parents) => this.assertTeams(ctx, parents),
      ),
    );
  }

  @Patch(':idOrKey')
  async update(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
    @Body() dto: UpdateIssueDto,
  ) {
    return this.withCounts(
      ctx,
      await this.service.update(
        ctx.workspace.id,
        actor,
        idOrKey,
        dto,
        (affected) => this.assertTeams(ctx, affected),
      ),
    );
  }

  @Delete(':idOrKey')
  @Can('deleteIssues')
  @HttpCode(204)
  async remove(
    @Ctx() ctx: WorkspaceContext,
    @Actor() actor: ActorRef,
    @Param('idOrKey') idOrKey: string,
  ) {
    return this.service.remove(
      ctx.workspace.id,
      actor,
      idOrKey,
      (affected) => this.assertTeams(ctx, affected),
    );
  }

  /** Team policies are gone. Hidden projects still conceal the parent issue. */
  private async assertTeams(
    ctx: WorkspaceContext,
    rows: readonly { projectId?: string | null }[],
  ) {
    if (rows.some((row) => projectHidden(ctx.access, row.projectId))) return;
  }

  private async withCounts<T extends { id: string; parentId?: string | null }>(
    ctx: WorkspaceContext,
    rows: T,
  ): Promise<T>;
  private async withCounts<T extends { id: string; parentId?: string | null }>(
    ctx: WorkspaceContext,
    rows: T[],
  ): Promise<T[]>;
  private async withCounts<T extends { id: string; parentId?: string | null }>(
    ctx: WorkspaceContext,
    rows: T | T[],
  ) {
    const list = Array.isArray(rows) ? rows : [rows];
    await this.hideInvisibleParents(ctx, list);
    return rows;
  }

  private async hideInvisibleParents<
    T extends { id: string; parentId?: string | null },
  >(ctx: WorkspaceContext, rows: T | T[]): Promise<void> {
    const list = Array.isArray(rows) ? rows : [rows];
    const parentIds = [
      ...new Set(list.flatMap((row) => (row.parentId ? [row.parentId] : []))),
    ];
    if (!parentIds.length) return;
    const visibleParentIds = await this.service.visibleParentIds(
      ctx.workspace.id,
      parentIds,
    );
    for (const row of list)
      if (row.parentId && !visibleParentIds.has(row.parentId))
        row.parentId = null;
  }
}
