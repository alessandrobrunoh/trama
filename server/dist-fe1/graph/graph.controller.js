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
import { Controller, Get, Param, Query } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Ctx } from '../auth/request-context.js';
import { WorkstreamsService } from '../workstreams/workstreams.service.js';
import { GraphService } from './graph.service.js';
const bool = () => Transform(({ value }) => (value === 'false' || value === '0' ? false : value === 'true' || value === '1' ? true : value));
class GraphQuery {
    teamId;
    workstreamId;
    includeArtifacts;
    includeActors;
    includeRepositories;
}
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], GraphQuery.prototype, "teamId", void 0);
__decorate([
    IsOptional(),
    IsString(),
    __metadata("design:type", String)
], GraphQuery.prototype, "workstreamId", void 0);
__decorate([
    IsOptional(),
    bool(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], GraphQuery.prototype, "includeArtifacts", void 0);
__decorate([
    IsOptional(),
    bool(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], GraphQuery.prototype, "includeActors", void 0);
__decorate([
    IsOptional(),
    bool(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], GraphQuery.prototype, "includeRepositories", void 0);
class WorkstreamGraphQuery {
    includeArtifacts;
    includeActors;
    includeRepositories;
}
__decorate([
    IsOptional(),
    bool(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], WorkstreamGraphQuery.prototype, "includeArtifacts", void 0);
__decorate([
    IsOptional(),
    bool(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], WorkstreamGraphQuery.prototype, "includeActors", void 0);
__decorate([
    IsOptional(),
    bool(),
    IsBoolean(),
    __metadata("design:type", Boolean)
], WorkstreamGraphQuery.prototype, "includeRepositories", void 0);
let GraphController = class GraphController {
    service;
    workstreams;
    constructor(service, workstreams) {
        this.service = service;
        this.workstreams = workstreams;
    }
    workspace(ctx, q) {
        return this.service.build(ctx.workspace.id, q);
    }
    async forWorkstream(ctx, idOrKey, q) {
        const ws = await this.workstreams.get(ctx.workspace.id, idOrKey);
        return this.service.build(ctx.workspace.id, { includeArtifacts: q.includeArtifacts, includeActors: q.includeActors, includeRepositories: q.includeRepositories, workstreamId: ws.id });
    }
};
__decorate([
    Get('graph'),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, GraphQuery]),
    __metadata("design:returntype", void 0)
], GraphController.prototype, "workspace", null);
__decorate([
    Get('workstreams/:idOrKey/graph'),
    __param(0, Ctx()),
    __param(1, Param('idOrKey')),
    __param(2, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, WorkstreamGraphQuery]),
    __metadata("design:returntype", Promise)
], GraphController.prototype, "forWorkstream", null);
GraphController = __decorate([
    Controller('w/:slug'),
    __metadata("design:paramtypes", [GraphService,
        WorkstreamsService])
], GraphController);
export { GraphController };
//# sourceMappingURL=graph.controller.js.map