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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { IsArray, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Actor, Ctx, Roles } from '../auth/request-context.js';
import { OptionalNotNull } from '../common/validation.js';
import { RepositoriesService } from './repositories.service.js';
class CreateRepositoryDto {
    provider;
    fullName;
    url;
    defaultBranch;
    teamIds;
}
__decorate([
    IsIn(['github', 'gitlab']),
    __metadata("design:type", String)
], CreateRepositoryDto.prototype, "provider", void 0);
__decorate([
    Matches(/^[\w.-]+(\/[\w.-]+)+$/, { message: 'fullName must look like "owner/name"' }),
    __metadata("design:type", String)
], CreateRepositoryDto.prototype, "fullName", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(300),
    __metadata("design:type", String)
], CreateRepositoryDto.prototype, "url", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(100),
    __metadata("design:type", String)
], CreateRepositoryDto.prototype, "defaultBranch", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateRepositoryDto.prototype, "teamIds", void 0);
class UpdateRepositoryDto {
    url;
    defaultBranch;
    teamIds;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MaxLength(300),
    __metadata("design:type", String)
], UpdateRepositoryDto.prototype, "url", void 0);
__decorate([
    OptionalNotNull(),
    IsString(),
    MaxLength(100),
    __metadata("design:type", String)
], UpdateRepositoryDto.prototype, "defaultBranch", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateRepositoryDto.prototype, "teamIds", void 0);
let RepositoriesController = class RepositoriesController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx) {
        return this.service.list(ctx.workspace.id);
    }
    get(ctx, id) {
        return this.service.get(ctx.workspace.id, id);
    }
    create(ctx, actor, dto) {
        return this.service.create(ctx.workspace.id, actor, dto);
    }
    update(ctx, actor, id, dto) {
        return this.service.update(ctx.workspace.id, actor, id, dto);
    }
    remove(ctx, actor, id) {
        return this.service.remove(ctx.workspace.id, actor, id);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], RepositoriesController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], RepositoriesController.prototype, "get", null);
__decorate([
    Post(),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateRepositoryDto]),
    __metadata("design:returntype", void 0)
], RepositoriesController.prototype, "create", null);
__decorate([
    Patch(':id'),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, UpdateRepositoryDto]),
    __metadata("design:returntype", void 0)
], RepositoriesController.prototype, "update", null);
__decorate([
    Delete(':id'),
    Roles('admin'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], RepositoriesController.prototype, "remove", null);
RepositoriesController = __decorate([
    Controller('w/:slug/repositories'),
    __metadata("design:paramtypes", [RepositoriesService])
], RepositoriesController);
export { RepositoriesController };
//# sourceMappingURL=repositories.controller.js.map