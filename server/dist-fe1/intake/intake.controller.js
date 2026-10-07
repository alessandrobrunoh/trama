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
import { CreateWorkstreamDto, PRIORITIES } from '../workstreams/workstreams.controller.js';
import { IntakeService } from './intake.service.js';
const KINDS = ['bug', 'feature', 'incident', 'tech_debt', 'feedback', 'idea', 'security'];
const STATES = ['new', 'triaged', 'accepted', 'declined', 'duplicate'];
const SOURCES = ['manual', 'github', 'gitlab', 'email', 'api', 'agent'];
class CreateIntakeDto {
    kind;
    title;
    body;
    source;
    reporterName;
    teamId;
    priority;
    externalUrl;
}
__decorate([
    IsIn(KINDS),
    __metadata("design:type", String)
], CreateIntakeDto.prototype, "kind", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(300),
    __metadata("design:type", String)
], CreateIntakeDto.prototype, "title", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(20000),
    __metadata("design:type", String)
], CreateIntakeDto.prototype, "body", void 0);
__decorate([
    IsOptional(),
    IsIn(SOURCES),
    __metadata("design:type", String)
], CreateIntakeDto.prototype, "source", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(200),
    __metadata("design:type", String)
], CreateIntakeDto.prototype, "reporterName", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateIntakeDto.prototype, "teamId", void 0);
__decorate([
    IsOptional(),
    IsIn(PRIORITIES),
    __metadata("design:type", String)
], CreateIntakeDto.prototype, "priority", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", String)
], CreateIntakeDto.prototype, "externalUrl", void 0);
class UpdateIntakeDto {
    title;
    body;
    reporterName;
    teamId;
    priority;
    externalUrl;
    workstreamIds;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(300),
    __metadata("design:type", String)
], UpdateIntakeDto.prototype, "title", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(20000),
    __metadata("design:type", Object)
], UpdateIntakeDto.prototype, "body", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(200),
    __metadata("design:type", Object)
], UpdateIntakeDto.prototype, "reporterName", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateIntakeDto.prototype, "teamId", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(PRIORITIES),
    __metadata("design:type", String)
], UpdateIntakeDto.prototype, "priority", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", Object)
], UpdateIntakeDto.prototype, "externalUrl", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateIntakeDto.prototype, "workstreamIds", void 0);
class TriageDto {
    state;
    workstreamIds;
    createWorkstream;
    duplicateOfId;
    teamId;
    priority;
}
__decorate([
    IsIn(STATES),
    __metadata("design:type", String)
], TriageDto.prototype, "state", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], TriageDto.prototype, "workstreamIds", void 0);
__decorate([
    IsOptional(),
    ValidateNested(),
    Type(() => CreateWorkstreamDto),
    __metadata("design:type", CreateWorkstreamDto)
], TriageDto.prototype, "createWorkstream", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], TriageDto.prototype, "duplicateOfId", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], TriageDto.prototype, "teamId", void 0);
__decorate([
    IsOptional(),
    IsIn(PRIORITIES),
    __metadata("design:type", String)
], TriageDto.prototype, "priority", void 0);
class ListIntakeQuery {
    kind;
    state;
    teamId;
    workstreamId;
    q;
}
__decorate([
    IsOptional(),
    IsIn(KINDS),
    __metadata("design:type", String)
], ListIntakeQuery.prototype, "kind", void 0);
__decorate([
    IsOptional(),
    IsIn(STATES),
    __metadata("design:type", String)
], ListIntakeQuery.prototype, "state", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListIntakeQuery.prototype, "teamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListIntakeQuery.prototype, "workstreamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListIntakeQuery.prototype, "q", void 0);
let IntakeController = class IntakeController {
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
    triage(ctx, actor, idOrKey, dto) {
        return this.service.triage(ctx.workspace.id, actor, idOrKey, dto);
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
    __metadata("design:paramtypes", [Object, ListIntakeQuery]),
    __metadata("design:returntype", void 0)
], IntakeController.prototype, "list", null);
__decorate([
    Get(':idOrKey'),
    __param(0, Ctx()),
    __param(1, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], IntakeController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateIntakeDto]),
    __metadata("design:returntype", void 0)
], IntakeController.prototype, "create", null);
__decorate([
    Patch(':idOrKey'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, UpdateIntakeDto]),
    __metadata("design:returntype", void 0)
], IntakeController.prototype, "update", null);
__decorate([
    Post(':idOrKey/triage'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, TriageDto]),
    __metadata("design:returntype", void 0)
], IntakeController.prototype, "triage", null);
__decorate([
    Delete(':idOrKey'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], IntakeController.prototype, "remove", null);
IntakeController = __decorate([
    Controller('w/:slug/intake'),
    __metadata("design:paramtypes", [IntakeService])
], IntakeController);
export { IntakeController };
//# sourceMappingURL=intake.controller.js.map