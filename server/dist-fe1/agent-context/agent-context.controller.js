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
import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { Ctx } from '../auth/request-context.js';
import { AgentContextService } from './agent-context.service.js';
class ContextQuery {
    format;
}
__decorate([
    IsOptional(),
    IsIn(['markdown', 'json']),
    __metadata("design:type", String)
], ContextQuery.prototype, "format", void 0);
let AgentContextController = class AgentContextController {
    service;
    constructor(service) {
        this.service = service;
    }
    async get(ctx, idOrKey, q, req, res) {
        const context = await this.service.build(ctx.workspace.id, idOrKey);
        const wantsJson = q.format ? q.format === 'json' : req.accepts(['text/markdown', 'application/json']) === 'application/json';
        if (wantsJson)
            return context;
        res.type('text/markdown; charset=utf-8');
        return AgentContextService.toMarkdown(context);
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __param(1, Param('idOrKey')),
    __param(2, Query()),
    __param(3, Req()),
    __param(4, Res({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, ContextQuery, Object, Object]),
    __metadata("design:returntype", Promise)
], AgentContextController.prototype, "get", null);
AgentContextController = __decorate([
    Controller('w/:slug/workstreams/:idOrKey/context'),
    __metadata("design:paramtypes", [AgentContextService])
], AgentContextController);
export { AgentContextController };
//# sourceMappingURL=agent-context.controller.js.map