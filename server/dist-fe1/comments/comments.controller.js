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
import { IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Ctx, Roles } from '../auth/request-context.js';
import { CommentsService } from './comments.service.js';
const SUBJECTS = ['workstream', 'execution', 'intake', 'artifact', 'decision', 'input_request', 'repository', 'team'];
class SubjectDto {
    type;
    id;
}
__decorate([
    IsIn(SUBJECTS),
    __metadata("design:type", String)
], SubjectDto.prototype, "type", void 0);
__decorate([
    IsString(),
    __metadata("design:type", String)
], SubjectDto.prototype, "id", void 0);
class CreateCommentDto {
    subject;
    body;
}
__decorate([
    ValidateNested(),
    Type(() => SubjectDto),
    __metadata("design:type", SubjectDto)
], CreateCommentDto.prototype, "subject", void 0);
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(20000),
    __metadata("design:type", String)
], CreateCommentDto.prototype, "body", void 0);
class UpdateCommentDto {
    body;
}
__decorate([
    IsString(),
    MinLength(1),
    MaxLength(20000),
    __metadata("design:type", String)
], UpdateCommentDto.prototype, "body", void 0);
class ListCommentsQuery {
    subjectType;
    subjectId;
}
__decorate([
    IsOptional(),
    IsIn(SUBJECTS),
    __metadata("design:type", String)
], ListCommentsQuery.prototype, "subjectType", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], ListCommentsQuery.prototype, "subjectId", void 0);
let CommentsController = class CommentsController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx, q) {
        return this.service.list(ctx.workspace.id, q);
    }
    create(ctx, dto) {
        return this.service.create(ctx, dto.subject, dto.body);
    }
    update(ctx, id, dto) {
        return this.service.update(ctx, id, dto.body);
    }
    remove(ctx, id) {
        return this.service.remove(ctx, id);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, ListCommentsQuery]),
    __metadata("design:returntype", void 0)
], CommentsController.prototype, "list", null);
__decorate([
    Post(),
    __param(0, Ctx()),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, CreateCommentDto]),
    __metadata("design:returntype", void 0)
], CommentsController.prototype, "create", null);
__decorate([
    Patch(':id'),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, UpdateCommentDto]),
    __metadata("design:returntype", void 0)
], CommentsController.prototype, "update", null);
__decorate([
    Delete(':id'),
    Roles('member'),
    HttpCode(204),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], CommentsController.prototype, "remove", null);
CommentsController = __decorate([
    Controller('w/:slug/comments'),
    __metadata("design:paramtypes", [CommentsService])
], CommentsController);
export { CommentsController };
//# sourceMappingURL=comments.controller.js.map