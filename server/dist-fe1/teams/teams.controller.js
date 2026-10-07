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
import { IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Actor, Ctx, Roles } from '../auth/request-context.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { TeamsService } from './teams.service.js';
class CreateTeamDto {
    name;
    key;
    color;
    description;
    memberIds;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(80),
    __metadata("design:type", String)
], CreateTeamDto.prototype, "name", void 0);
__decorate([
    Matches(/^[A-Z][A-Z0-9]{1,7}$/, { message: 'key must be 2-8 uppercase letters/digits' }),
    __metadata("design:type", String)
], CreateTeamDto.prototype, "key", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(32),
    __metadata("design:type", String)
], CreateTeamDto.prototype, "color", void 0);
__decorate([
    IsOptional(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", String)
], CreateTeamDto.prototype, "description", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], CreateTeamDto.prototype, "memberIds", void 0);
class UpdateTeamDto {
    name;
    color;
    description;
    memberIds;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(80),
    __metadata("design:type", String)
], UpdateTeamDto.prototype, "name", void 0);
__decorate([
    OptionalNotNull(),
    IsString(),
    MaxLength(32),
    __metadata("design:type", String)
], UpdateTeamDto.prototype, "color", void 0);
__decorate([
    Clearable(),
    IsString(),
    MaxLength(500),
    __metadata("design:type", Object)
], UpdateTeamDto.prototype, "description", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    IsString({ each: true }),
    __metadata("design:type", Array)
], UpdateTeamDto.prototype, "memberIds", void 0);
let TeamsController = class TeamsController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx) {
        return this.service.list(ctx.workspace.id);
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
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], TeamsController.prototype, "list", null);
__decorate([
    Get(':idOrKey'),
    __param(0, Ctx()),
    __param(1, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], TeamsController.prototype, "get", null);
__decorate([
    Post(),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateTeamDto]),
    __metadata("design:returntype", void 0)
], TeamsController.prototype, "create", null);
__decorate([
    Patch(':idOrKey'),
    Roles('admin'),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __param(3, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String, UpdateTeamDto]),
    __metadata("design:returntype", void 0)
], TeamsController.prototype, "update", null);
__decorate([
    Delete(':idOrKey'),
    Roles('admin'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('idOrKey')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], TeamsController.prototype, "remove", null);
TeamsController = __decorate([
    Controller('w/:slug/teams'),
    __metadata("design:paramtypes", [TeamsService])
], TeamsController);
export { TeamsController };
//# sourceMappingURL=teams.controller.js.map