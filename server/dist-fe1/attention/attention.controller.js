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
import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { IsDateString, IsIn, IsOptional } from 'class-validator';
import { Ctx, RequireUser } from '../auth/request-context.js';
import { AttentionService } from './attention.service.js';
class AttentionQuery {
    scope;
    state;
}
__decorate([
    IsOptional(),
    IsIn(['mine', 'all']),
    __metadata("design:type", String)
], AttentionQuery.prototype, "scope", void 0);
__decorate([
    IsOptional(),
    IsIn(['open', 'snoozed', 'dismissed', 'active']),
    __metadata("design:type", String)
], AttentionQuery.prototype, "state", void 0);
class SnoozeDto {
    until;
}
__decorate([
    IsDateString(),
    __metadata("design:type", String)
], SnoozeDto.prototype, "until", void 0);
let AttentionController = class AttentionController {
    service;
    constructor(service) {
        this.service = service;
    }
    list(ctx, q) {
        return this.service.forUser(ctx, q);
    }
    dismiss(ctx, id) {
        return this.service.dismiss(ctx, id);
    }
    snooze(ctx, id, dto) {
        return this.service.snooze(ctx, id, dto.until);
    }
    restore(ctx, id) {
        return this.service.restore(ctx, id);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, AttentionQuery]),
    __metadata("design:returntype", void 0)
], AttentionController.prototype, "list", null);
__decorate([
    Post(':id/dismiss'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], AttentionController.prototype, "dismiss", null);
__decorate([
    Post(':id/snooze'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, SnoozeDto]),
    __metadata("design:returntype", void 0)
], AttentionController.prototype, "snooze", null);
__decorate([
    Post(':id/restore'),
    HttpCode(200),
    __param(0, Ctx()),
    __param(1, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String]),
    __metadata("design:returntype", void 0)
], AttentionController.prototype, "restore", null);
AttentionController = __decorate([
    Controller('w/:slug/attention'),
    RequireUser(),
    __metadata("design:paramtypes", [AttentionService])
], AttentionController);
export { AttentionController };
//# sourceMappingURL=attention.controller.js.map