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
import { IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, Ctx } from '../auth/request-context.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { DecisionsService } from './decisions.service.js';
const STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'];
class CreateDecisionDto {
    title;
    statement;
    rationale;
    status;
    originWorkstreamId;
    originExecutionId;
    relatedWorkstreamIds;
    tags;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(300),
    __metadata("design:type", String)
], CreateDecisionDto.prototype, "title", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(20000),
    __metadata("design:type", String)
], CreateDecisionDto.prototype, "statement", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(20000),
    __metadata("design:type", String)
], CreateDecisionDto.prototype, "rationale", void 0);
__decorate([
    IsOptional(),
    IsIn(['proposed', 'accepted', 'rejected']),
    __metadata("design:type", String)
], CreateDecisionDto.prototype, "status", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateDecisionDto.prototype, "originWorkstreamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateDecisionDto.prototype, "originExecutionId", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateDecisionDto.prototype, "relatedWorkstreamIds", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateDecisionDto.prototype, "tags", void 0);
class UpdateDecisionDto {
    title;
    statement;
    rationale;
    originWorkstreamId;
    originExecutionId;
    relatedWorkstreamIds;
    tags;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(300),
    __metadata("design:type", String)
], UpdateDecisionDto.prototype, "title", void 0);
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(20000),
    __metadata("design:type", String)
], UpdateDecisionDto.prototype, "statement", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(20000),
    __metadata("design:type", Object)
], UpdateDecisionDto.prototype, "rationale", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateDecisionDto.prototype, "originWorkstreamId", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateDecisionDto.prototype, "originExecutionId", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateDecisionDto.prototype, "relatedWorkstreamIds", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateDecisionDto.prototype, "tags", void 0);
class SupersedeDto {
    byId;
}
__decorate([
    IsString(),
    __metadata("design:type", String)
], SupersedeDto.prototype, "byId", void 0);
class ListDecisionsQuery {
    status;
    workstreamId;
    tag;
    q;
}
__decorate([
    IsOptional(),
    IsIn(STATUSES),
    __metadata("design:type", String)
], ListDecisionsQuery.prototype, "status", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListDecisionsQuery.prototype, "workstreamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListDecisionsQuery.prototype, "tag", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListDecisionsQuery.prototype, "q", void 0);
let DecisionsController = class DecisionsController {
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
    accept(ctx, actor, idOrKey) {
        return this.service.accept(ctx.workspace.id, actor, idOrKey);
    }
    reject(ctx, actor, idOrKey) {
        return this.service.reject(ctx.workspace.id, actor, idOrKey);
    }
    supersede(ctx, actor, idOrKey, dto) {
        return this.service.supersede(ctx.workspace.id, actor, idOrKey, dto.byId);
    }
    remove(ctx, actor, idOrKey) {
        return this.service.remove(ctx.workspace.id, actor, idOrKey);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ListDecisionsQuery]),
    __metadata("design:returntype", void 0)
], DecisionsController.prototype, "list", null);
__decorate([
    Get(':idOrKey'),
    __param(0, Ctx()),
    __param(1, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], DecisionsController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateDecisionDto]),
    __metadata("design:returntype", void 0)
], DecisionsController.prototype, "create", null);
__decorate([
    Patch(':idOrKey'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, UpdateDecisionDto]),
    __metadata("design:returntype", void 0)
], DecisionsController.prototype, "update", null);
__decorate([
    Post(':idOrKey/accept'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], DecisionsController.prototype, "accept", null);
__decorate([
    Post(':idOrKey/reject'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], DecisionsController.prototype, "reject", null);
__decorate([
    Post(':idOrKey/supersede'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, SupersedeDto]),
    __metadata("design:returntype", void 0)
], DecisionsController.prototype, "supersede", null);
__decorate([
    Delete(':idOrKey'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], DecisionsController.prototype, "remove", null);
DecisionsController = __decorate([
    Controller('w/:slug/decisions'),
    __metadata("design:paramtypes", [DecisionsService])
], DecisionsController);
export { DecisionsController };
//# sourceMappingURL=decisions.controller.js.map