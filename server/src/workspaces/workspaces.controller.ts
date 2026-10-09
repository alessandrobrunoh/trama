import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { normalizePermissions } from '../auth/api-permissions.js';
import { ASSISTANT_TOKEN_NAME } from '../ai/assistant-tools.service.js';
import {
  Auth,
  Can,
  Ctx,
  RequireUser,
  Roles,
  canDo,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import { TokensService } from '../auth/tokens.service.js';
import { ESTIMATE_SCALES, MAX_TOKEN_LIMITS, WEEK_STARTS } from '../contracts/domain.js';
import type { EstimateScale, ExecutionProvider, Role, TokenScope, WeekStart } from '../contracts/domain.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { toDate } from '../common/util.js';
import { WorkspacesService } from './workspaces.service.js';

const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];
const PROVIDERS: Exclude<ExecutionProvider, 'human'>[] = ['delta', 'claude_code', 'codex', 'cursor', 'other'];

class CreateWorkspaceDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsOptional() @IsString() @MaxLength(40) slug?: string;
}

class UpdateWorkspaceDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @OptionalNotNull() @IsString() @MaxLength(40) slug?: string;
}

/** Everything optional; `null` clears `defaultTeamId` / `iconColor` / `iconInitial`. `permissions` is owner-only. */
class UpdateSettingsDto {
  @OptionalNotNull() @IsObject() permissions?: Record<string, string>;
  @Clearable() @IsString() defaultTeamId?: string | null;
  @OptionalNotNull() @IsIn(ESTIMATE_SCALES) estimateScale?: EstimateScale;
  @OptionalNotNull() @IsIn(WEEK_STARTS) weekStart?: WeekStart;
  @OptionalNotNull() @IsString() @MaxLength(64) timeZone?: string;
  @Clearable() @Matches(/^#[0-9a-fA-F]{6}$/, { message: 'iconColor must be #rrggbb' }) iconColor?: string | null;
  @Clearable() @IsString() @MaxLength(2) iconInitial?: string | null;
  @OptionalNotNull() @IsBoolean() deltaThreads?: boolean;
}

class AddMemberDto {
  @IsEmail() email: string;
  @IsIn(ROLES) role: Role;
}

class ChangeRoleDto {
  @IsIn(ROLES) role: Role;
}

class CreateAgentDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  @IsIn(PROVIDERS) provider: Exclude<ExecutionProvider, 'human'>;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() ownerUserId?: string;
}

class UpdateAgentDto {
  @OptionalNotNull() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @OptionalNotNull() @IsIn(PROVIDERS) provider?: Exclude<ExecutionProvider, 'human'>;
  @Clearable() @IsString() @MaxLength(500) description?: string | null;
  @Clearable() @IsString() ownerUserId?: string | null;
}

const TOKEN_SCOPE_VALUES: TokenScope[] = ['read', 'write', 'admin', 'custom'];

class TokenLimitsDto {
  @IsOptional() @IsInt() @Min(1) @Max(MAX_TOKEN_LIMITS.requestsPerMinute) requestsPerMinute?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_TOKEN_LIMITS.writesPerMinute) writesPerMinute?: number;
  @IsOptional() @IsInt() @Min(1) @Max(MAX_TOKEN_LIMITS.writesPerDay) writesPerDay?: number;
}

class CreateTokenDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
  /** Default `write`. `admin` needs an admin caller and a user token. */
  @IsOptional() @IsIn(TOKEN_SCOPE_VALUES) scope?: TokenScope;
  /** `<resource>:<action>` list; implies `scope: 'custom'` (see API_RESOURCES). */
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(60, { each: true }) permissions?: string[];
  /** Request / write budget; omitted values use the defaults. */
  @IsOptional() @ValidateNested() @Type(() => TokenLimitsDto) limits?: TokenLimitsDto;
  /** Omit to create a token that acts as you; set to create an agent token (admin). */
  @IsOptional() @IsString() @Matches(/^ag_/) agentId?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
}

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly service: WorkspacesService) {}

  /** Workspaces I belong to, each with my `role`. */
  @Get()
  @RequireUser()
  list(@Auth() auth: AuthInfo) {
    return this.service.listMine(auth.user!.id);
  }

  @Post()
  @RequireUser()
  create(@Auth() auth: AuthInfo, @Body() dto: CreateWorkspaceDto) {
    return this.service.create(auth.user!, dto);
  }
}

@Controller('w/:slug')
export class WorkspaceController {
  constructor(private readonly service: WorkspacesService) {}

  @Get()
  get(@Ctx() ctx: WorkspaceContext) {
    return Object.assign(ctx.workspace, { role: ctx.role });
  }

  @Patch()
  @Roles('admin')
  async update(@Ctx() ctx: WorkspaceContext, @Body() dto: UpdateWorkspaceDto) {
    return Object.assign(await this.service.update(ctx.workspace, dto), { role: ctx.role });
  }

  /** Workspace customization (default team, estimate scale, icon, week start, time zone, permission policy). */
  @Patch('settings')
  @Roles('admin')
  async updateSettings(@Ctx() ctx: WorkspaceContext, @Body() dto: UpdateSettingsDto) {
    return Object.assign(await this.service.updateSettings(ctx, dto), { role: ctx.role });
  }

  @Delete()
  @Roles('owner')
  @HttpCode(204)
  async remove(@Ctx() ctx: WorkspaceContext): Promise<void> {
    await this.service.remove(ctx.workspace);
  }
}

@Controller('w/:slug/members')
export class MembersController {
  constructor(private readonly service: WorkspacesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.listMembers(ctx.workspace.id);
  }

  @Post()
  @Can('inviteMembers')
  add(@Ctx() ctx: WorkspaceContext, @Body() dto: AddMemberDto) {
    return this.service.addMember(ctx.workspace.id, ctx.role, dto);
  }

  @Patch(':id')
  @Roles('admin')
  change(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: ChangeRoleDto) {
    return this.service.changeRole(ctx.workspace.id, ctx.role, id, dto.role);
  }

  /** Admins remove anyone below owner; any member can remove themselves (leave). */
  @Delete(':id')
  @Roles('viewer')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.removeMember(ctx.workspace.id, ctx.role, ctx.userId, id);
  }
}

@Controller('w/:slug/agents')
export class AgentsController {
  constructor(private readonly service: WorkspacesService) {}

  @Get()
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.listAgents(ctx.workspace.id);
  }

  @Post()
  @Can('manageAgents')
  create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateAgentDto) {
    return this.service.createAgent(ctx.workspace.id, dto);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.getAgent(ctx.workspace.id, id);
  }

  @Patch(':id')
  @Can('manageAgents')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.service.updateAgent(ctx.workspace.id, id, dto);
  }

  @Delete(':id')
  @Can('manageAgents')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.removeAgent(ctx.workspace.id, id);
  }
}

@Controller('w/:slug/tokens')
export class TokensController {
  constructor(
    private readonly service: WorkspacesService,
    private readonly tokens: TokensService,
  ) {}

  /** Admins see every token of the workspace; others only their own. */
  @Get()
  async list(@Ctx() ctx: WorkspaceContext) {
    const all = await this.service.listTokens(ctx.workspace.id, ctx.role === 'admin' || ctx.role === 'owner' ? undefined : ctx.userId ?? '-');
    // the assistant's per-turn tokens live for seconds; they are not something to manage
    return all.filter((t) => t.name !== ASSISTANT_TOKEN_NAME);
  }

  /** Returns `{ token, secret }`; the secret is shown only this once. */
  @Post()
  @RequireUser()
  @Can('manageTokens')
  async create(@Ctx() ctx: WorkspaceContext, @Auth() auth: AuthInfo, @Body() dto: CreateTokenDto) {
    const scope: TokenScope = dto.scope ?? (dto.permissions ? 'custom' : 'write');
    const permissions = scope === 'custom' ? normalizePermissions(dto.permissions ?? []) : undefined;
    if (scope === 'custom' && !permissions?.length) throw new BadRequestException('A custom token needs at least one valid permission');
    if (scope !== 'custom' && dto.permissions) throw new BadRequestException('permissions can only be set on custom tokens');
    // A custom token can only mint custom tokens that are a subset of itself (no escalation).
    if (auth.token?.scope === 'custom') {
      const own = new Set(auth.token.permissions ?? []);
      if (scope !== 'custom' || permissions!.some((p) => !own.has(p)))
        throw new ForbiddenException('A custom token can only create custom tokens with a subset of its own permissions');
    }
    // A write token is capped at member; custom tokens are not capped by role, so minting one
    // from a write token would hand out the user's full role (and any permission) to the new secret.
    if (auth.token?.scope === 'write' && scope !== 'write' && scope !== 'read')
      throw new ForbiddenException('A write-scoped token can only create read or write tokens');
    if (scope === 'admin' && ctx.role !== 'admin' && ctx.role !== 'owner')
      throw new ForbiddenException('Only admins can create admin-scoped tokens');
    let actor = ctx.actor;
    if (dto.agentId) {
      if (!canDo(ctx, 'manageAgents')) throw new ForbiddenException('You are not allowed to create agent tokens');
      if (scope === 'admin') throw new BadRequestException('Agents act with the member role: use the read or write scope');
      const agent = await this.service.getAgent(ctx.workspace.id, dto.agentId);
      actor = { type: 'agent', id: agent.id };
    }
    return this.tokens.create({
      workspaceId: ctx.workspace.id,
      name: dto.name,
      actor,
      scope,
      permissions,
      limits: dto.limits,
      createdByUserId: ctx.userId,
      expiresAt: toDate(dto.expiresAt) as Date | undefined,
    });
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    const admin = ctx.role === 'admin' || ctx.role === 'owner';
    return this.service.removeToken(ctx.workspace.id, id, admin ? undefined : ctx.userId ?? '-');
  }
}
