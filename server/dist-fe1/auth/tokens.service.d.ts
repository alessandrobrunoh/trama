import { type Repository } from 'typeorm';
import type { ActorRef } from '../contracts/domain.js';
import { ApiTokenEntity } from '../database/entities/index.js';
export declare const TOKEN_PREFIX = "nbl_";
export declare class TokensService {
    private readonly repo;
    constructor(repo: Repository<ApiTokenEntity>);
    create(input: {
        workspaceId: string;
        name: string;
        actor: ActorRef;
        createdByUserId?: string;
        expiresAt?: Date | null;
    }): Promise<{
        token: ApiTokenEntity;
        secret: string;
    }>;
    authenticate(secret: string): Promise<ApiTokenEntity | null>;
}
