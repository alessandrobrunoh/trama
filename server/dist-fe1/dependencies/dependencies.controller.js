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
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Actor, Ctx } from '../auth/request-context.js';
import { DependenciesService } from './dependencies.service.js';
const NODE_TYPES = ['workstream', 'execution'];
class CreateDependencyDto {
    fromType;
    fromId;
    toType;
    toId;
}
__decorate([
    IsIn(NODE_TYPES),
    __metadata("design:type", String)
], CreateDependencyDto.prototype, "fromType", void 0);
__decorate([
    IsString(),
    __metadata("design:type", String)
], CreateDependencyDto.prototype, "fromId", void 0);
__decorate([
    IsIn(NODE_TYPES),
    __metadata("design:type", String)
], CreateDependencyDto.prototype, "toType", void 0);
__decorate([
    IsString(),
    __metadata("design:type", String)
], CreateDependencyDto.prototype, "toId", void 0);
class ListDependenciesQuery {
    fromId;
    toId;
}
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListDependenciesQuery.prototype, "fromId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListDependenciesQuery.prototype, "toId", void 0);
let DependenciesController = class DependenciesController {
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
        return this.service.create(ctx.workspace.id, actor, { type: dto.fromType, id: dto.fromId }, { type: dto.toType, id: dto.toId });
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
    __metadata("design:paramtypes", [Object, ListDependenciesQuery]),
    __metadata("design:returntype", void 0)
], DependenciesController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], DependenciesController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, CreateDependencyDto]),
    __metadata("design:returntype", void 0)
], DependenciesController.prototype, "create", null);
__decorate([
    Delete(':id'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Actor()),
    __param(2, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object, String]),
    __metadata("design:returntype", void 0)
], DependenciesController.prototype, "remove", null);
DependenciesController = __decorate([
    Controller('w/:slug/dependencies'),
    __metadata("design:paramtypes", [DependenciesService])
], DependenciesController);
export { DependenciesController };
//# sourceMappingURL=dependencies.controller.js.map