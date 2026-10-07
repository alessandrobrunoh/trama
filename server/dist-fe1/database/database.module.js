var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { dataSourceOptions, databaseUrl } from './data-source.options.js';
import { ensureDatabase } from './ensure-database.js';
import { AdminController } from './admin.controller.js';
import { SeedService } from './seed/seed.service.js';
let DatabaseModule = class DatabaseModule {
};
DatabaseModule = __decorate([
    Global(),
    Module({
        imports: [
            TypeOrmModule.forRootAsync({
                useFactory: async () => {
                    await ensureDatabase(databaseUrl());
                    return dataSourceOptions();
                },
            }),
        ],
        controllers: [AdminController],
        providers: [SeedService],
        exports: [SeedService],
    })
], DatabaseModule);
export { DatabaseModule };
//# sourceMappingURL=database.module.js.map