import { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service.js';
import { TokensService } from '../auth/tokens.service.js';
import { AgentEntity, MembershipEntity, UserEntity, WorkspaceEntity } from '../database/entities/index.js';
export declare class AccessGuard implements CanActivate {
    private readonly reflector;
    private readonly auth;
    private readonly tokens;
    private readonly workspaces;
    private readonly memberships;
    private readonly users;
    private readonly agents;
    constructor(reflector: Reflector, auth: AuthService, tokens: TokensService, workspaces: Repository<WorkspaceEntity>, memberships: Repository<MembershipEntity>, users: Repository<UserEntity>, agents: Repository<AgentEntity>);
    canActivate(context: ExecutionContext): Promise<boolean>;
    private authenticate;
    private roleIn;
}
