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
import { Controller, Get } from '@nestjs/common';
import { Auth, Ctx, RequireUser } from '../auth/request-context.js';
import { SnapshotService } from './snapshot.service.js';
let SnapshotController = class SnapshotController {
    service;
    constructor(service) {
        this.service = service;
    }
    get(ctx, auth) {
        return this.service.build(ctx, auth.user, ctx.role);
    }
};
__decorate([
    Get(),
    RequireUser(),
    __param(0, Ctx()),
    __param(1, Auth()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", void 0)
], SnapshotController.prototype, "get", null);
SnapshotController = __decorate([
    Controller('w/:slug/snapshot'),
    __metadata("design:paramtypes", [SnapshotService])
], SnapshotController);
export { SnapshotController };
//# sourceMappingURL=snapshot.controller.js.map