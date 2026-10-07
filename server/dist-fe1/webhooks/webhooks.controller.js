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
import { Controller, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import { Public } from '../auth/request-context.js';
import { WebhooksService } from './webhooks.service.js';
let WebhooksController = class WebhooksController {
    service;
    constructor(service) {
        this.service = service;
    }
    async run(provider, connectionId, req, res) {
        const result = await this.service.handle({
            provider,
            connectionId,
            rawBody: req.rawBody,
            payload: req.body,
            headers: req.headers,
        });
        res.status(result.httpStatus).json(result.body);
    }
    github(id, req, res) {
        return this.run('github', id, req, res);
    }
    gitlab(id, req, res) {
        return this.run('gitlab', id, req, res);
    }
};
__decorate([
    Post('github/:connectionId'),
    HttpCode(200),
    __param(0, Param('connectionId')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "github", null);
__decorate([
    Post('gitlab/:connectionId'),
    HttpCode(200),
    __param(0, Param('connectionId')),
    __param(1, Req()),
    __param(2, Res()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", void 0)
], WebhooksController.prototype, "gitlab", null);
WebhooksController = __decorate([
    Public(),
    Controller('webhooks'),
    __metadata("design:paramtypes", [WebhooksService])
], WebhooksController);
export { WebhooksController };
//# sourceMappingURL=webhooks.controller.js.map