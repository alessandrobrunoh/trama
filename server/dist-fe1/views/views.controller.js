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
import { Type } from 'class-transformer';
import { Allow, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Ctx } from '../auth/request-context.js';
import { Clearable, OptionalNotNull } from '../common/validation.js';
import { ViewsService } from './views.service.js';
const ENTITIES = ['workstream', 'intake', 'execution', 'decision'];
const LAYOUTS = ['list', 'board', 'graph'];
const OPS = ['is', 'is_not', 'in', 'not_in', 'contains', 'before', 'after'];
class FilterDto {
    field;
    op;
    value;
}
__decorate([
    IsString(),
    MaxLength(100),
    __metadata("design:type", String)
], FilterDto.prototype, "field", void 0);
__decorate([
    IsIn(OPS),
    __metadata("design:type", Object)
], FilterDto.prototype, "op", void 0);
__decorate([
    Allow(),
    __metadata("design:type", Object)
], FilterDto.prototype, "value", void 0);
class SortDto {
    field;
    direction;
}
__decorate([
    IsString(),
    __metadata("design:type", String)
], SortDto.prototype, "field", void 0);
__decorate([
    IsIn(['asc', 'desc']),
    __metadata("design:type", String)
], SortDto.prototype, "direction", void 0);
class CreateViewDto {
    name;
    entity;
    filters;
    sort;
    groupBy;
    layout;
    shared;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(100),
    __metadata("design:type", String)
], CreateViewDto.prototype, "name", void 0);
__decorate([
    IsIn(ENTITIES),
    __metadata("design:type", String)
], CreateViewDto.prototype, "entity", void 0);
__decorate([
    IsOptional(),
    IsArray(),
    ValidateNested({ each: true }),
    Type(() => FilterDto),
    __metadata("design:type", Array)
], CreateViewDto.prototype, "filters", void 0);
__decorate([
    IsOptional(),
    IsObject(),
    ValidateNested(),
    Type(() => SortDto),
    __metadata("design:type", Object)
], CreateViewDto.prototype, "sort", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], CreateViewDto.prototype, "groupBy", void 0);
__decorate([
    IsOptional(),
    IsIn(LAYOUTS),
    __metadata("design:type", String)
], CreateViewDto.prototype, "layout", void 0);
__decorate([
    IsOptional(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], CreateViewDto.prototype, "shared", void 0);
class UpdateViewDto {
    name;
    entity;
    filters;
    sort;
    groupBy;
    layout;
    shared;
}
__decorate([
    OptionalNotNull(),
    IsString(),
    MinLength(1),
    MaxLength(100),
    __metadata("design:type", String)
], UpdateViewDto.prototype, "name", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(ENTITIES),
    __metadata("design:type", String)
], UpdateViewDto.prototype, "entity", void 0);
__decorate([
    OptionalNotNull(),
    IsArray(),
    ValidateNested({ each: true }),
    Type(() => FilterDto),
    __metadata("design:type", Array)
], UpdateViewDto.prototype, "filters", void 0);
__decorate([
    Clearable(),
    IsObject(),
    ValidateNested(),
    Type(() => SortDto),
    __metadata("design:type", Object)
], UpdateViewDto.prototype, "sort", void 0);
__decorate([
    Clearable(),
    IsString(),
    __metadata("design:type", Object)
], UpdateViewDto.prototype, "groupBy", void 0);
__decorate([
    OptionalNotNull(),
    IsIn(LAYOUTS),
    __metadata("design:type", String)
], UpdateViewDto.prototype, "layout", void 0);
__decorate([
    OptionalNotNull(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], UpdateViewDto.prototype, "shared", void 0);
let ViewsController = class ViewsController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx) {
        return this.service.list(ctx.workspace.id, ctx.userId);
    }
    get(ctx, id) {
        return this.service.get(ctx, id);
    }
    create(ctx, dto) {
        return this.service.create(ctx, dto);
    }
    update(ctx, id, dto) {
        return this.service.update(ctx, id, dto);
    }
    remove(ctx, id) {
        return this.service.remove(ctx, id);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], ViewsController.prototype, "list", null);
__decorate([
    Get(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ViewsController.prototype, "get", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, CreateViewDto]),
    __metadata("design:returntype", void 0)
], ViewsController.prototype, "create", null);
__decorate([
    Patch(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, UpdateViewDto]),
    __metadata("design:returntype", void 0)
], ViewsController.prototype, "update", null);
__decorate([
    Delete(':id'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], ViewsController.prototype, "remove", null);
ViewsController = __decorate([
    Controller('w/:slug/views'),
    __metadata("design:paramtypes", [ViewsService])
], ViewsController);
export { ViewsController };
//# sourceMappingURL=views.controller.js.map