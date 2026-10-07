var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExecutionEntity } from '../database/entities/index.js';
import { DependenciesModule } from '../dependencies/dependencies.module.js';
import { ExecutionsController } from './executions.controller.js';
import { ExecutionsService } from './executions.service.js';
let ExecutionsModule = class ExecutionsModule {
};
ExecutionsModule = __decorate([
    Module({
        imports: [TypeOrmModule.forFeature([ExecutionEntity]), DependenciesModule],
        controllers: [ExecutionsController],
        providers: [ExecutionsService],
        exports: [ExecutionsService],
    })
], ExecutionsModule);
export { ExecutionsModule };
//# sourceMappingURL=executions.module.js.map