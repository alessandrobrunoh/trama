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
import { Controller, Get, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Ctx } from '../auth/request-context.js';
import { SEARCH_TYPES, SearchService } from './search.service.js';
class SearchQuery {
    q;
    types;
    limit;
}
__decorate([
    IsString(),
    __metadata("design:type", String)
], SearchQuery.prototype, "q", void 0);
__decorate([
    IsOptional(),
    Transform(({ value }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value)),
    IsArray(),
    IsIn(SEARCH_TYPES, { each: true }),
    __metadata("design:type", Array)
], SearchQuery.prototype, "types", void 0);
__decorate([
    IsOptional(),
    Type(() => Number),
    IsInt(),
    Min(1),
    Max(100),
    __metadata("design:type", Number)
], SearchQuery.prototype, "limit", void 0);
let SearchController = class SearchController {
    service;
    constructor(service) {
        this.service = service;
    }
    search(ctx, q) {
        return this.service.search(ctx.workspace.id, q.q, { types: q.types, limit: q.limit });
    }
};
__decorate([
    Get(),
    __param(0, Ctx()),
    __param(1, Query()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, SearchQuery]),
    __metadata("design:returntype", void 0)
], SearchController.prototype, "search", null);
SearchController = __decorate([
    Controller('w/:slug/search'),
    __metadata("design:paramtypes", [SearchService])
], SearchController);
export { SearchController };
//# sourceMappingURL=search.controller.js.map