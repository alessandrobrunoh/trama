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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, Ctx } from '../auth/request-context.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { ArtifactsService } from './artifacts.service.js';
const KINDS = ['pull_request', 'merge_request', 'commit', 'branch', 'document', 'design', 'build', 'test_report', 'deployment', 'release'];
const PROVIDERS = ['github', 'gitlab', 'delta', 'figma', 'docs', 'ci', 'other'];
const STATES = ['draft', 'open', 'merged', 'closed', 'pending', 'running', 'succeeded', 'failed', 'healthy', 'degraded', 'published'];
const CI = ['pending', 'passing', 'failing'];
const REVIEW = ['none', 'requested', 'approved', 'changes_requested'];
class CreateArtifactDto {
    workstreamId;
    kind;
    title;
    executionId;
    repositoryId;
    provider;
    url;
    externalId;
    state;
    ci;
    review;
    hasConflicts;
    environment;
}
__decorate([
    IsString(),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "workstreamId", void 0);
__decorate([
    IsIn(KINDS),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "kind", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(300),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "title", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "executionId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "repositoryId", void 0);
__decorate([
    IsOptional(),
    IsIn(PROVIDERS),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "provider", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(1000),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "url", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(200),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "externalId", void 0);
__decorate([
    IsOptional(),
    IsIn(STATES),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "state", void 0);
__decorate([
    IsOptional(),
    IsIn(CI),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "ci", void 0);
__decorate([
    IsOptional(),
    IsIn(REVIEW),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "review", void 0);
__decorate([
    IsOptional(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], CreateArtifactDto.prototype, "hasConflicts", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(100),
    __metadata("design:type", String)
], CreateArtifactDto.prototype, "environment", void 0);
class UpdateArtifactDto {
    title;
    executionId;
    repositoryId;
    provider;
    url;
    externalId;
    state;
    ci;
    review;
    hasConflicts;
    environment;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(300),
    __metadata("design:type", String)
], UpdateArtifactDto.prototype, "title", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateArtifactDto.prototype, "executionId", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateArtifactDto.prototype, "repositoryId", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(PROVIDERS),
    __metadata("design:type", String)
], UpdateArtifactDto.prototype, "provider", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(1000),
    __metadata("design:type", Object)
], UpdateArtifactDto.prototype, "url", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(200),
    __metadata("design:type", Object)
], UpdateArtifactDto.prototype, "externalId", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(STATES),
    __metadata("design:type", String)
], UpdateArtifactDto.prototype, "state", void 0);
__decorate([
    Clearable(),
    IsIn(CI),
    __metadata("design:type", Object)
], UpdateArtifactDto.prototype, "ci", void 0);
__decorate([
    Clearable(),
    IsIn(REVIEW),
    __metadata("design:type", Object)
], UpdateArtifactDto.prototype, "review", void 0);
__decorate([
    Clearable(),
    IsBoolean(),
    __metadata("design:type", Object)
], UpdateArtifactDto.prototype, "hasConflicts", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(100),
    __metadata("design:type", Object)
], UpdateArtifactDto.prototype, "environment", void 0);
class ListArtifactsQuery {
    workstreamId;
    executionId;
    repositoryId;
    kind;
    state;
}
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListArtifactsQuery.prototype, "workstreamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListArtifactsQuery.prototype, "executionId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListArtifactsQuery.prototype, "repositoryId", void 0);
__decorate([
    IsOptional(),
    IsIn(KINDS),
    __metadata("design:type", String)
], ListArtifactsQuery.prototype, "kind", void 0);
__decorate([
    IsOptional(),
    IsIn(STATES),
    __metadata("design:type", String)
], ListArtifactsQuery.prototype, "state", void 0);
let ArtifactsController = class ArtifactsController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx, q) {
        return this.service.list(ctx.workspace.id, q);
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
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ListArtifactsQuery]),
    __metadata("design:returntype", void 0)
], ArtifactsController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ArtifactsController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateArtifactDto]),
    __metadata("design:returntype", void 0)
], ArtifactsController.prototype, "create", null);
__decorate([
    Patch(':id'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, UpdateArtifactDto]),
    __metadata("design:returntype", void 0)
], ArtifactsController.prototype, "update", null);
__decorate([
    Delete(':id'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], ArtifactsController.prototype, "remove", null);
ArtifactsController = __decorate([
    Controller('w/:slug/artifacts'),
    __metadata("design:paramtypes", [ArtifactsService])
], ArtifactsController);
export { ArtifactsController };
//# sourceMappingURL=artifacts.controller.js.map