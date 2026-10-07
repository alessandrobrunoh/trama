var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Controller, HttpCode, NotFoundException, Post } from '@nestjs/common';
import { Public } from '../auth/request-context.js';
import { SeedService } from './seed/seed.service.js';
let AdminController = class AdminController {
    seed;
    constructor(seed) {
        this.seed = seed;
    }
    async reset() {
        if (process.env.NODE_ENV === 'production')
            throw new NotFoundException();
        await this.seed.reset();
        return { ok: true };
    }
};
__decorate([
    Public(),
    Post('reset'),
    HttpCode(200),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], AdminController.prototype, "reset", null);
AdminController = __decorate([
    Controller('admin'),
    __metadata("design:paramtypes", [SeedService])
], AdminController);
export { AdminController };
//# sourceMappingURL=admin.controller.js.map