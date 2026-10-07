var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntakeItemEntity } from '../database/entities/index.js';
import { WorkstreamsModule } from '../workstreams/workstreams.module.js';
import { IntakeController } from './intake.controller.js';
import { IntakeService } from './intake.service.js';
let IntakeModule = class IntakeModule {
};
IntakeModule = __decorate([
    Module({
        imports: [TypeOrmModule.forFeature([IntakeItemEntity]), WorkstreamsModule],
        controllers: [IntakeController],
        providers: [IntakeService],
        exports: [IntakeService],
    })
], IntakeModule);
export { IntakeModule };
//# sourceMappingURL=intake.module.js.map