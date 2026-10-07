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
import { Type } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Actor, Ctx } from '../auth/request-context.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { ExecutionsService } from './executions.service.js';
const PROVIDERS = ['human', 'delta', 'claude_code', 'codex', 'cursor', 'other'];
const STATES = ['queued', 'running', 'needs_input', 'in_review', 'blocked', 'failed', 'completed', 'canceled'];
class ActorRefDto {
    type;
    id;
}
__decorate([
    IsIn(['user', 'agent', 'team']),
    __metadata("design:type", String)
], ActorRefDto.prototype, "type", void 0);
__decorate([
    IsString(),
    __metadata("design:type", String)
], ActorRefDto.prototype, "id", void 0);
class CreateExecutionDto {
    workstreamId;
    title;
    parentExecutionId;
    description;
    teamId;
    repositoryIds;
    performers;
    provider;
    state;
    dependsOnExecutionIds;
    sessionUrl;
    branch;
    progressNote;
}
__decorate([
    IsString(),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "workstreamId", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(200),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "title", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "parentExecutionId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(10000),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "description", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "teamId", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateExecutionDto.prototype, "repositoryIds", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    ValidateNested({ each: true }),
    Type(() => ActorRefDto),
    __metadata("design:type", Array)
], CreateExecutionDto.prototype, "performers", void 0);
__decorate([
    IsOptional(),
    IsIn(PROVIDERS),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "provider", void 0);
__decorate([
    IsOptional(),
    IsIn(STATES),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "state", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateExecutionDto.prototype, "dependsOnExecutionIds", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "sessionUrl", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(200),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "branch", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(5000),
    __metadata("design:type", String)
], CreateExecutionDto.prototype, "progressNote", void 0);
class UpdateExecutionDto {
    title;
    parentExecutionId;
    description;
    teamId;
    repositoryIds;
    performers;
    provider;
    state;
    dependsOnExecutionIds;
    sessionUrl;
    branch;
    progressNote;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(200),
    __metadata("design:type", String)
], UpdateExecutionDto.prototype, "title", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateExecutionDto.prototype, "parentExecutionId", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(10000),
    __metadata("design:type", Object)
], UpdateExecutionDto.prototype, "description", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateExecutionDto.prototype, "teamId", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateExecutionDto.prototype, "repositoryIds", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    ValidateNested({ each: true }),
    Type(() => ActorRefDto),
    __metadata("design:type", Array)
], UpdateExecutionDto.prototype, "performers", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(PROVIDERS),
    __metadata("design:type", String)
], UpdateExecutionDto.prototype, "provider", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(STATES),
    __metadata("design:type", String)
], UpdateExecutionDto.prototype, "state", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateExecutionDto.prototype, "dependsOnExecutionIds", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", Object)
], UpdateExecutionDto.prototype, "sessionUrl", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(200),
    __metadata("design:type", Object)
], UpdateExecutionDto.prototype, "branch", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(5000),
    __metadata("design:type", Object)
], UpdateExecutionDto.prototype, "progressNote", void 0);
class ProgressDto {
    note;
    state;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(5000),
    __metadata("design:type", String)
], ProgressDto.prototype, "note", void 0);
__decorate([
    IsOptional(),
    IsIn(STATES),
    __metadata("design:type", String)
], ProgressDto.prototype, "state", void 0);
class CompleteDto {
    note;
}
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(5000),
    __metadata("design:type", String)
], CompleteDto.prototype, "note", void 0);
class ListExecutionsQuery {
    workstreamId;
    state;
    parentExecutionId;
    teamId;
}
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListExecutionsQuery.prototype, "workstreamId", void 0);
__decorate([
    IsOptional(),
    IsIn(STATES),
    __metadata("design:type", String)
], ListExecutionsQuery.prototype, "state", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListExecutionsQuery.prototype, "parentExecutionId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListExecutionsQuery.prototype, "teamId", void 0);
let ExecutionsController = class ExecutionsController {
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
    progress(ctx, actor, id, dto) {
        return this.service.progress(ctx.workspace.id, actor, id, dto);
    }
    complete(ctx, actor, id, dto) {
        return this.service.complete(ctx.workspace.id, actor, id, dto);
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
    __metadata("design:paramtypes", [Object, ListExecutionsQuery]),
    __metadata("design:returntype", void 0)
], ExecutionsController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ExecutionsController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateExecutionDto]),
    __metadata("design:returntype", void 0)
], ExecutionsController.prototype, "create", null);
__decorate([
    Patch(':id'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, UpdateExecutionDto]),
    __metadata("design:returntype", void 0)
], ExecutionsController.prototype, "update", null);
__decorate([
    Post(':id/progress'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, ProgressDto]),
    __metadata("design:returntype", void 0)
], ExecutionsController.prototype, "progress", null);
__decorate([
    Post(':id/complete'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, CompleteDto]),
    __metadata("design:returntype", void 0)
], ExecutionsController.prototype, "complete", null);
__decorate([
    Delete(':id'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], ExecutionsController.prototype, "remove", null);
ExecutionsController = __decorate([
    Controller('w/:slug/executions'),
    __metadata("design:paramtypes", [ExecutionsService])
], ExecutionsController);
export { ExecutionsController };
//# sourceMappingURL=executions.controller.js.map