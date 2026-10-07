var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkstreamEntity } from '../database/entities/index.js';
import { WorkstreamsController } from './workstreams.controller.js';
import { WorkstreamsService } from './workstreams.service.js';
let WorkstreamsModule = class WorkstreamsModule {
};
WorkstreamsModule = __decorate([
    Module({
        imports: [TypeOrmModule.forFeature([WorkstreamEntity])],
        controllers: [WorkstreamsController],
        providers: [WorkstreamsService],
        exports: [WorkstreamsService],
    })
], WorkstreamsModule);
export { WorkstreamsModule };
//# sourceMappingURL=workstreams.module.js.map