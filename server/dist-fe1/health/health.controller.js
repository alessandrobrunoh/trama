var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from '../auth/request-context.js';
let HealthController = class HealthController {
    ds;
    constructor(ds) {
        this.ds = ds;
    }
    async check() {
        try {
            await this.ds.query('SELECT 1');
            return { status: 'ok', db: 'up', time: new Date().toISOString() };
        }
        catch {
            throw new ServiceUnavailableException({ status: 'error', db: 'down' });
        }
    }
};
__decorate([
    Public(),
    Get(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "check", null);
HealthController = __decorate([
    Controller('health'),
    __metadata("design:paramtypes", [DataSource])
], HealthController);
export { HealthController };
//# sourceMappingURL=health.controller.js.map