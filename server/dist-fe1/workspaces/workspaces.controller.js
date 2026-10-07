var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, } from '@nestjs/common';
import { IsEmail, IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength, MinLength, } from 'class-validator';
import { Auth, Ctx, RequireUser, Roles, } from '../auth/request-context.js';
import { TokensService } from '../auth/tokens.service.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { toDate } from '../common/util.js';
import { WorkspacesService } from './workspaces.service.js';
const ROLES = ['owner', 'admin', 'member', 'viewer'];
const PROVIDERS = ['delta', 'claude_code', 'codex', 'cursor', 'other'];
class CreateWorkspaceDto {
    name;
    slug;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(80),
    __metadata("design:type", String)
], CreateWorkspaceDto.prototype, "name", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(40),
    __metadata("design:type", String)
], CreateWorkspaceDto.prototype, "slug", void 0);
class UpdateWorkspaceDto {
    name;
    slug;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(80),
    __metadata("design:type", String)
], UpdateWorkspaceDto.prototype, "name", void 0);
__decorate([
    OptionalNotNull(),
    IsString(),
    MaxLength(40),
    __metadata("design:type", String)
], UpdateWorkspaceDto.prototype, "slug", void 0);
class AddMemberDto {
    email;
    role;
}
__decorate([
    IsEmail(),
    __metadata("design:type", String)
], AddMemberDto.prototype, "email", void 0);
__decorate([
    IsIn(ROLES),
    __metadata("design:type", String)
], AddMemberDto.prototype, "role", void 0);
class ChangeRoleDto {
    role;
}
__decorate([
    IsIn(ROLES),
    __metadata("design:type", String)
], ChangeRoleDto.prototype, "role", void 0);
class CreateAgentDto {
    name;
    provider;
    description;
    ownerUserId;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(80),
    __metadata("design:type", String)
], CreateAgentDto.prototype, "name", void 0);
__decorate([
    IsIn(PROVIDERS),
    __metadata("design:type", Object)
], CreateAgentDto.prototype, "provider", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", String)
], CreateAgentDto.prototype, "description", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateAgentDto.prototype, "ownerUserId", void 0);
class UpdateAgentDto {
    name;
    provider;
    description;
    ownerUserId;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(80),
    __metadata("design:type", String)
], UpdateAgentDto.prototype, "name", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(PROVIDERS),
    __metadata("design:type", Object)
], UpdateAgentDto.prototype, "provider", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", Object)
], UpdateAgentDto.prototype, "description", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateAgentDto.prototype, "ownerUserId", void 0);
class CreateTokenDto {
    name;
    agentId;
    expiresAt;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(80),
    __metadata("design:type", String)
], CreateTokenDto.prototype, "name", void 0);
__decorate([
    IsOptional(),
    IsString(),
    Matches(/^ag_/),
    __metadata("design:type", String)
], CreateTokenDto.prototype, "agentId", void 0);
__decorate([
    IsOptional(),
    IsISO8601(),
    __metadata("design:type", String)
], CreateTokenDto.prototype, "expiresAt", void 0);
let WorkspacesController = class WorkspacesController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(auth) {
        return this.service.listMine(auth.user.id);
    }
    create(auth, dto) {
        return this.service.create(auth.user, dto);
    }
};
__decorate([
    Get(),
    RequireUser(),
    __param(0, Auth()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], WorkspacesController.prototype, "list", null);
__decorate([
    Post(),
    RequireUser(),
    __param(0, Auth()),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, CreateWorkspaceDto]),
    __metadata("design:returntype", void 0)
], WorkspacesController.prototype, "create", null);
WorkspacesController = __decorate([
    Controller('workspaces'),
    __metadata("design:paramtypes", [WorkspacesService])
], WorkspacesController);
export { WorkspacesController };
let WorkspaceController = class WorkspaceController {
    service;
    constructor(service) {
        this.service = service;
    }
    get(ctx) {
        return Object.assign(ctx.workspace, { role: ctx.role });
    }
    async update(ctx, dto) {
        return Object.assign(await this.service.update(ctx.workspace, dto), { role: ctx.role });
    }
    async remove(ctx) {
        await this.service.remove(ctx.workspace);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], WorkspaceController.prototype, "get", null);
__decorate([
    Patch(),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, UpdateWorkspaceDto]),
    __metadata("design:returntype", Promise)
], WorkspaceController.prototype, "update", null);
__decorate([
    Delete(),
    Roles('owner'),
    HttpCode(204),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], WorkspaceController.prototype, "remove", null);
WorkspaceController = __decorate([
    Controller('w/:slug'),
    __metadata("design:paramtypes", [WorkspacesService])
], WorkspaceController);
export { WorkspaceController };
let MembersController = class MembersController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx) {
        return this.service.listMembers(ctx.workspace.id);
    }
    add(ctx, dto) {
        return this.service.addMember(ctx.workspace.id, ctx.role, dto);
    }
    change(ctx, id, dto) {
        return this.service.changeRole(ctx.workspace.id, ctx.role, id, dto.role);
    }
    remove(ctx, id) {
        return this.service.removeMember(ctx.workspace.id, ctx.role, ctx.userId, id);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], MembersController.prototype, "list", null);
__decorate([
    Post(),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, AddMemberDto]),
    __metadata("design:returntype", void 0)
], MembersController.prototype, "add", null);
__decorate([
    Patch(':id'),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, ChangeRoleDto]),
    __metadata("design:returntype", void 0)
], MembersController.prototype, "change", null);
__decorate([
    Delete(':id'),
    Roles('viewer'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], MembersController.prototype, "remove", null);
MembersController = __decorate([
    Controller('w/:slug/members'),
    __metadata("design:paramtypes", [WorkspacesService])
], MembersController);
export { MembersController };
let AgentsController = class AgentsController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx) {
        return this.service.listAgents(ctx.workspace.id);
    }
    create(ctx, dto) {
        return this.service.createAgent(ctx.workspace.id, dto);
    }
    get(ctx, id) {
        return this.service.getAgent(ctx.workspace.id, id);
    }
    update(ctx, id, dto) {
        return this.service.updateAgent(ctx.workspace.id, id, dto);
    }
    remove(ctx, id) {
        return this.service.removeAgent(ctx.workspace.id, id);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "list", null);
__decorate([
    Post(),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, CreateAgentDto]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "create", null);
__decorate([
    Get(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "get", null);
__decorate([
    Patch(':id'),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, UpdateAgentDto]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "update", null);
__decorate([
    Delete(':id'),
    Roles('admin'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], AgentsController.prototype, "remove", null);
AgentsController = __decorate([
    Controller('w/:slug/agents'),
    __metadata("design:paramtypes", [WorkspacesService])
], AgentsController);
export { AgentsController };
let TokensController = class TokensController {
    service;
    tokens;
    constructor(service, tokens) {
        this.service = service;
        this.tokens = tokens;
    }
    list(ctx) {
        return this.service.listTokens(ctx.workspace.id, ctx.role === 'admin' || ctx.role === 'owner' ? undefined : ctx.userId ?? '-');
    }
    async create(ctx, dto) {
        let actor = ctx.actor;
        if (dto.agentId) {
            if (ctx.role !== 'admin' && ctx.role !== 'owner')
                throw new ForbiddenException('Only admins can create agent tokens');
            const agent = await this.service.getAgent(ctx.workspace.id, dto.agentId);
            actor = { type: 'agent', id: agent.id };
        }
        return this.tokens.create({
            workspaceId: ctx.workspace.id,
            name: dto.name,
            actor,
            createdByUserId: ctx.userId,
            expiresAt: toDate(dto.expiresAt),
        });
    }
    remove(ctx, id) {
        const admin = ctx.role === 'admin' || ctx.role === 'owner';
        return this.service.removeToken(ctx.workspace.id, id, admin ? undefined : ctx.userId ?? '-');
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TokensController.prototype, "list", null);
__decorate([
    Post(),
    RequireUser(),
    Roles('member'),
    __param(0, Ctx()),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, CreateTokenDto]),
    __metadata("design:returntype", Promise)
], TokensController.prototype, "create", null);
__decorate([
    Delete(':id'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], TokensController.prototype, "remove", null);
TokensController = __decorate([
    Controller('w/:slug/tokens'),
    __metadata("design:paramtypes", [WorkspacesService,
        TokensService])
], TokensController);
export { TokensController };
//# sourceMappingURL=workspaces.controller.js.map