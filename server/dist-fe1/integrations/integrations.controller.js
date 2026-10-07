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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Actor, Ctx, Roles } from '../auth/request-context.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { IntegrationsService } from './integrations.service.js';
class CreateIntegrationDto {
    provider;
    token;
    baseUrl;
}
__decorate([
    IsIn(['github', 'gitlab', 'delta']),
    __metadata("design:type", String)
], CreateIntegrationDto.prototype, "provider", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(500),
    __metadata("design:type", String)
], CreateIntegrationDto.prototype, "token", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", String)
], CreateIntegrationDto.prototype, "baseUrl", void 0);
class UpdateIntegrationDto {
    token;
    baseUrl;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(500),
    __metadata("design:type", String)
], UpdateIntegrationDto.prototype, "token", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", Object)
], UpdateIntegrationDto.prototype, "baseUrl", void 0);
class RemoteReposQuery {
    page;
    perPage;
}
__decorate([
    IsOptional(),
    Type(() => Number),
    IsInt(),
    Min(1),
    __metadata("design:type", Number)
], RemoteReposQuery.prototype, "page", void 0);
__decorate([
    IsOptional(),
    Type(() => Number),
    IsInt(),
    Min(1),
    Max(100),
    __metadata("design:type", Number)
], RemoteReposQuery.prototype, "perPage", void 0);
class LinkRepositoryDto {
    fullName;
    teamIds;
}
__decorate([
    IsString(),
    MinLength(3),
    MaxLength(300),
    __metadata("design:type", String)
], LinkRepositoryDto.prototype, "fullName", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], LinkRepositoryDto.prototype, "teamIds", void 0);
let IntegrationsController = class IntegrationsController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx, req) {
        return this.service.list(ctx.workspace.id, IntegrationsService.publicUrl(req));
    }
    get(ctx, id, req) {
        return this.service.get(ctx.workspace.id, id, IntegrationsService.publicUrl(req));
    }
    create(ctx, actor, dto, req) {
        return this.service.create(ctx.workspace.id, actor, dto, IntegrationsService.publicUrl(req));
    }
    update(ctx, id, dto, req) {
        return this.service.update(ctx.workspace.id, id, dto, IntegrationsService.publicUrl(req));
    }
    remove(ctx, id) {
        return this.service.remove(ctx.workspace.id, id);
    }
    rotate(ctx, id, req) {
        return this.service.rotateWebhookSecret(ctx.workspace.id, id, IntegrationsService.publicUrl(req));
    }
    remote(ctx, id, q) {
        return this.service.remoteRepositories(ctx.workspace.id, id, q.page ?? 1, q.perPage ?? 30);
    }
    async link(ctx, actor, id, dto, res) {
        const { repository, created } = await this.service.linkRepository(ctx.workspace.id, actor, id, dto);
        res.status(created ? 201 : 200);
        return repository;
    }
    unlink(ctx, id, repositoryId) {
        return this.service.unlinkRepository(ctx.workspace.id, id, repositoryId);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __param(1, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __param(3, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateIntegrationDto, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "create", null);
__decorate([
    Patch(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body()),
    __param(3, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, UpdateIntegrationDto, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "update", null);
__decorate([
    Delete(':id'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "remove", null);
__decorate([
    Post(':id/rotate-webhook-secret'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Req()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, Object]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "rotate", null);
__decorate([
    Get(':id/remote-repositories'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, RemoteReposQuery]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "remote", null);
__decorate([
    Post(':id/link-repository'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __param(3, Body()),
    __param(4, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, LinkRepositoryDto, Object]),
    __metadata("design:returntype", Promise)
], IntegrationsController.prototype, "link", null);
__decorate([
    Delete(':id/repositories/:repositoryId'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Param('repositoryId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String]),
    __metadata("design:returntype", void 0)
], IntegrationsController.prototype, "unlink", null);
IntegrationsController = __decorate([
    Controller('w/:slug/integrations'),
    Roles('admin'),
    __metadata("design:paramtypes", [IntegrationsService])
], IntegrationsController);
export { IntegrationsController };
//# sourceMappingURL=integrations.controller.js.map