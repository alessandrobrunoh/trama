import {
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
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  Auth,
  Ctx,
  RequireUser,
  Roles,
  type AuthInfo,
  type WorkspaceContext,
} from '../auth/request-context.js';
import { TokensService } from '../auth/tokens.service.js';
import type { ExecutionProvider, Role } from '../contracts/domain.js';
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

class CreateTokenDto {
  @IsString() @MinLength(1) @MaxLength(80) name: string;
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
  @Roles('admin')
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
  @Roles('admin')
  create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateAgentDto) {
    return this.service.createAgent(ctx.workspace.id, dto);
  }

  @Get(':id')
  get(@Ctx() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.service.getAgent(ctx.workspace.id, id);
  }

  @Patch(':id')
  @Roles('admin')
  update(@Ctx() ctx: WorkspaceContext, @Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.service.updateAgent(ctx.workspace.id, id, dto);
  }

  @Delete(':id')
  @Roles('admin')
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
  list(@Ctx() ctx: WorkspaceContext) {
    return this.service.listTokens(ctx.workspace.id, ctx.role === 'admin' || ctx.role === 'owner' ? undefined : ctx.userId ?? '-');
  }

  /** Returns `{ token, secret }`; the secret is shown only this once. */
  @Post()
  @RequireUser()
  @Roles('member')
  async create(@Ctx() ctx: WorkspaceContext, @Body() dto: CreateTokenDto) {
    let actor = ctx.actor;
    if (dto.agentId) {
      if (ctx.role !== 'admin' && ctx.role !== 'owner') throw new ForbiddenException('Only admins can create agent tokens');
      const agent = await this.service.getAgent(ctx.workspace.id, dto.agentId);
      actor = { type: 'agent', id: agent.id };
    }
    return this.tokens.create({
      workspaceId: ctx.workspace.id,
      name: dto.name,
      actor,
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
