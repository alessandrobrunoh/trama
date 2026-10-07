var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { AttentionModule } from '../attention/attention.module.js';
import { ExecutionsModule } from '../executions/executions.module.js';
import { ViewsModule } from '../views/views.module.js';
import { SnapshotController } from './snapshot.controller.js';
import { SnapshotService } from './snapshot.service.js';
let SnapshotModule = class SnapshotModule {
};
SnapshotModule = __decorate([
    Module({
        imports: [ExecutionsModule, ViewsModule, AttentionModule],
        controllers: [SnapshotController],
        providers: [SnapshotService],
    })
], SnapshotModule);
export { SnapshotModule };
//# sourceMappingURL=snapshot.module.js.map