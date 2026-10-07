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
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Or } from 'typeorm';
import { ApiTokenEntity } from '../database/entities/index.js';
import { sha256 } from '../common/crypto.js';
import { uid } from '../common/util.js';
export const TOKEN_PREFIX = 'nbl_';
let TokensService = class TokensService {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    async create(input) {
        const secret = TOKEN_PREFIX + randomBytes(32).toString('base64url');
        const token = await this.repo.save(this.repo.create({
            id: uid('tk'),
            workspaceId: input.workspaceId,
            name: input.name,
            prefix: `${secret.slice(0, 8)}…`,
            tokenHash: sha256(secret),
            actor: input.actor,
            createdByUserId: input.createdByUserId ?? null,
            expiresAt: input.expiresAt ?? null,
        }));
        return { token, secret };
    }
    async authenticate(secret) {
        if (!secret.startsWith(TOKEN_PREFIX))
            return null;
        const token = await this.repo.findOne({
            where: {
                tokenHash: sha256(secret),
                expiresAt: Or(IsNull(), MoreThan(new Date())),
            },
        });
        if (!token)
            return null;
        if (!token.lastUsedAt || Date.now() - token.lastUsedAt.getTime() > 60_000) {
            token.lastUsedAt = new Date();
            await this.repo.update({ id: token.id }, { lastUsedAt: token.lastUsedAt });
        }
        return token;
    }
};
TokensService = __decorate([
    Injectable(),
    __param(0, InjectRepository(ApiTokenEntity)),
    __metadata("design:paramtypes", [Function])
], TokensService);
export { TokensService };
//# sourceMappingURL=tokens.service.js.map