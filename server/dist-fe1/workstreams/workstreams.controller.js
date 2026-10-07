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
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsISO8601, IsOptional, IsString, MaxLength, MinLength, ValidateNested, } from 'class-validator';
import { Actor, Ctx } from '../auth/request-context.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { WorkstreamsService } from './workstreams.service.js';
export const PRIORITIES = ['none', 'urgent', 'high', 'medium', 'low'];
export const STATUSES = ['draft', 'planned', 'working', 'needs_input', 'in_review', 'blocked', 'ready_to_land', 'shipped', 'canceled'];
const CRITERION_STATES = ['pending', 'in_progress', 'met'];
export class CriterionDto {
    id;
    text;
    state;
}
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CriterionDto.prototype, "id", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(500),
    __metadata("design:type", String)
], CriterionDto.prototype, "text", void 0);
__decorate([
    IsOptional(),
    IsIn(CRITERION_STATES),
    __metadata("design:type", String)
], CriterionDto.prototype, "state", void 0);
class UpdateCriterionDto {
    text;
    state;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(500),
    __metadata("design:type", String)
], UpdateCriterionDto.prototype, "text", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(CRITERION_STATES),
    __metadata("design:type", String)
], UpdateCriterionDto.prototype, "state", void 0);
export class CreateWorkstreamDto {
    title;
    ownerTeamId;
    objective;
    context;
    participatingTeamIds;
    accountableUserId;
    repositoryIds;
    acceptanceCriteria;
    priority;
    labels;
    statusOverride;
    targetDate;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(200),
    __metadata("design:type", String)
], CreateWorkstreamDto.prototype, "title", void 0);
__decorate([
    IsString(),
    __metadata("design:type", String)
], CreateWorkstreamDto.prototype, "ownerTeamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(20000),
    __metadata("design:type", String)
], CreateWorkstreamDto.prototype, "objective", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(20000),
    __metadata("design:type", String)
], CreateWorkstreamDto.prototype, "context", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateWorkstreamDto.prototype, "participatingTeamIds", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateWorkstreamDto.prototype, "accountableUserId", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateWorkstreamDto.prototype, "repositoryIds", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    ArrayMaxSize(50),
    ValidateNested({ each: true }),
    Type(() => CriterionDto),
    __metadata("design:type", Array)
], CreateWorkstreamDto.prototype, "acceptanceCriteria", void 0);
__decorate([
    IsOptional(),
    IsIn(PRIORITIES),
    __metadata("design:type", String)
], CreateWorkstreamDto.prototype, "priority", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateWorkstreamDto.prototype, "labels", void 0);
__decorate([
    IsOptional(),
    IsIn(['draft', 'canceled']),
    __metadata("design:type", String)
], CreateWorkstreamDto.prototype, "statusOverride", void 0);
__decorate([
    IsOptional(),
    IsISO8601(),
    __metadata("design:type", String)
], CreateWorkstreamDto.prototype, "targetDate", void 0);
class UpdateWorkstreamDto {
    title;
    objective;
    context;
    ownerTeamId;
    participatingTeamIds;
    accountableUserId;
    repositoryIds;
    acceptanceCriteria;
    priority;
    labels;
    statusOverride;
    targetDate;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(200),
    __metadata("design:type", String)
], UpdateWorkstreamDto.prototype, "title", void 0);
__decorate([
    OptionalNotNull(),
    IsString(),
    MaxLength(20000),
    __metadata("design:type", String)
], UpdateWorkstreamDto.prototype, "objective", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(20000),
    __metadata("design:type", Object)
], UpdateWorkstreamDto.prototype, "context", void 0);
__decorate([
    OptionalNotNull(),
    IsString(),
    __metadata("design:type", String)
], UpdateWorkstreamDto.prototype, "ownerTeamId", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateWorkstreamDto.prototype, "participatingTeamIds", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateWorkstreamDto.prototype, "accountableUserId", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateWorkstreamDto.prototype, "repositoryIds", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    ArrayMaxSize(50),
    ValidateNested({ each: true }),
    Type(() => CriterionDto),
    __metadata("design:type", Array)
], UpdateWorkstreamDto.prototype, "acceptanceCriteria", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(PRIORITIES),
    __metadata("design:type", String)
], UpdateWorkstreamDto.prototype, "priority", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateWorkstreamDto.prototype, "labels", void 0);
__decorate([
    Clearable(),
    IsIn(['draft', 'canceled']),
    __metadata("design:type", Object)
], UpdateWorkstreamDto.prototype, "statusOverride", void 0);
__decorate([
    Clearable(),
    IsISO8601(),
    __metadata("design:type", Object)
], UpdateWorkstreamDto.prototype, "targetDate", void 0);
class ListWorkstreamsQuery {
    status;
    ownerTeamId;
    teamId;
    accountableUserId;
    priority;
    repositoryId;
    label;
    q;
}
__decorate([
    IsOptional(),
    IsIn(STATUSES),
    __metadata("design:type", String)
], ListWorkstreamsQuery.prototype, "status", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListWorkstreamsQuery.prototype, "ownerTeamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListWorkstreamsQuery.prototype, "teamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListWorkstreamsQuery.prototype, "accountableUserId", void 0);
__decorate([
    IsOptional(),
    IsIn(PRIORITIES),
    __metadata("design:type", String)
], ListWorkstreamsQuery.prototype, "priority", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListWorkstreamsQuery.prototype, "repositoryId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListWorkstreamsQuery.prototype, "label", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListWorkstreamsQuery.prototype, "q", void 0);
let WorkstreamsController = class WorkstreamsController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx, q) {
        return this.service.list(ctx.workspace.id, q);
    }
    get(ctx, idOrKey) {
        return this.service.get(ctx.workspace.id, idOrKey);
    }
    create(ctx, actor, dto) {
        return this.service.create(ctx.workspace.id, actor, dto);
    }
    update(ctx, actor, idOrKey, dto) {
        return this.service.update(ctx.workspace.id, actor, idOrKey, dto);
    }
    remove(ctx, actor, idOrKey) {
        return this.service.remove(ctx.workspace.id, actor, idOrKey);
    }
    addCriterion(ctx, actor, idOrKey, dto) {
        return this.service.addCriterion(ctx.workspace.id, actor, idOrKey, dto);
    }
    updateCriterion(ctx, actor, idOrKey, criterionId, dto) {
        return this.service.updateCriterion(ctx.workspace.id, actor, idOrKey, criterionId, dto);
    }
    removeCriterion(ctx, actor, idOrKey, criterionId) {
        return this.service.removeCriterion(ctx.workspace.id, actor, idOrKey, criterionId);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ListWorkstreamsQuery]),
    __metadata("design:returntype", void 0)
], WorkstreamsController.prototype, "list", null);
__decorate([
    Get(':idOrKey'),
    __param(0, Ctx()),
    __param(1, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], WorkstreamsController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateWorkstreamDto]),
    __metadata("design:returntype", void 0)
], WorkstreamsController.prototype, "create", null);
__decorate([
    Patch(':idOrKey'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, UpdateWorkstreamDto]),
    __metadata("design:returntype", void 0)
], WorkstreamsController.prototype, "update", null);
__decorate([
    Delete(':idOrKey'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], WorkstreamsController.prototype, "remove", null);
__decorate([
    Post(':idOrKey/criteria'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, CriterionDto]),
    __metadata("design:returntype", void 0)
], WorkstreamsController.prototype, "addCriterion", null);
__decorate([
    Patch(':idOrKey/criteria/:criterionId'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Param('criterionId')),
    __param(4, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String, UpdateCriterionDto]),
    __metadata("design:returntype", void 0)
], WorkstreamsController.prototype, "updateCriterion", null);
__decorate([
    Delete(':idOrKey/criteria/:criterionId'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Param('criterionId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, String]),
    __metadata("design:returntype", void 0)
], WorkstreamsController.prototype, "removeCriterion", null);
WorkstreamsController = __decorate([
    Controller('w/:slug/workstreams'),
    __metadata("design:paramtypes", [WorkstreamsService])
], WorkstreamsController);
export { WorkstreamsController };
//# sourceMappingURL=workstreams.controller.js.map