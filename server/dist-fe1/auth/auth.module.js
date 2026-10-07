var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiTokenEntity, MembershipEntity, SessionEntity, UserEntity, WorkspaceEntity, } from '../database/entities/index.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokensService } from './tokens.service.js';
let AuthModule = class AuthModule {
};
AuthModule = __decorate([
    Module({
        imports: [
            TypeOrmModule.forFeature([
                UserEntity,
                SessionEntity,
                MembershipEntity,
                WorkspaceEntity,
                ApiTokenEntity,
            ]),
        ],
        controllers: [AuthController],
        providers: [AuthService, TokensService],
        exports: [AuthService, TokensService],
    })
], AuthModule);
export { AuthModule };
//# sourceMappingURL=auth.module.js.map