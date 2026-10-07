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
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Actor, Ctx } from '../auth/request-context.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { InputRequestsService } from './input-requests.service.js';
class CreateInputRequestDto {
    workstreamId;
    executionId;
    question;
    options;
    assigneeUserId;
}
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateInputRequestDto.prototype, "workstreamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateInputRequestDto.prototype, "executionId", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(2000),
    __metadata("design:type", String)
], CreateInputRequestDto.prototype, "question", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    ArrayMaxSize(10),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateInputRequestDto.prototype, "options", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateInputRequestDto.prototype, "assigneeUserId", void 0);
class UpdateInputRequestDto {
    question;
    options;
    assigneeUserId;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(2000),
    __metadata("design:type", String)
], UpdateInputRequestDto.prototype, "question", void 0);
__decorate([
    Clearable(),
    IsArray(),
    ArrayMaxSize(10),
    IsString({ each: true }),
    __metadata("design:type", Object)
], UpdateInputRequestDto.prototype, "options", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateInputRequestDto.prototype, "assigneeUserId", void 0);
class AnswerDto {
    answer;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(10000),
    __metadata("design:type", String)
], AnswerDto.prototype, "answer", void 0);
class ListQuery {
    state;
    workstreamId;
    executionId;
    assigneeUserId;
}
__decorate([
    IsOptional(),
    IsIn(['open', 'answered', 'dismissed']),
    __metadata("design:type", String)
], ListQuery.prototype, "state", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListQuery.prototype, "workstreamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListQuery.prototype, "executionId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListQuery.prototype, "assigneeUserId", void 0);
let InputRequestsController = class InputRequestsController {
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
    answer(ctx, actor, id, dto) {
        return this.service.answer(ctx.workspace.id, actor, id, dto.answer);
    }
    dismiss(ctx, actor, id) {
        return this.service.dismiss(ctx.workspace.id, actor, id);
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
    __metadata("design:paramtypes", [Object, ListQuery]),
    __metadata("design:returntype", void 0)
], InputRequestsController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], InputRequestsController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateInputRequestDto]),
    __metadata("design:returntype", void 0)
], InputRequestsController.prototype, "create", null);
__decorate([
    Patch(':id'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, UpdateInputRequestDto]),
    __metadata("design:returntype", void 0)
], InputRequestsController.prototype, "update", null);
__decorate([
    Post(':id/answer'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, AnswerDto]),
    __metadata("design:returntype", void 0)
], InputRequestsController.prototype, "answer", null);
__decorate([
    Post(':id/dismiss'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], InputRequestsController.prototype, "dismiss", null);
__decorate([
    Delete(':id'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], InputRequestsController.prototype, "remove", null);
InputRequestsController = __decorate([
    Controller('w/:slug/input-requests'),
    __metadata("design:paramtypes", [InputRequestsService])
], InputRequestsController);
export { InputRequestsController };
//# sourceMappingURL=input-requests.controller.js.map