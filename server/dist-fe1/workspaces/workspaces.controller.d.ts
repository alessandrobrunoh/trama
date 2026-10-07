import { type AuthInfo, type WorkspaceContext } from '../auth/request-context.js';
import { TokensService } from '../auth/tokens.service.js';
import type { ExecutionProvider, Role } from '../contracts/domain.js';
import { WorkspacesService } from './workspaces.service.js';
declare class CreateWorkspaceDto {
    name: string;
    slug?: string;
}
declare class UpdateWorkspaceDto {
    name?: string;
    slug?: string;
}
declare class AddMemberDto {
    email: string;
    role: Role;
}
declare class ChangeRoleDto {
    role: Role;
}
declare class CreateAgentDto {
    name: string;
    provider: Exclude<ExecutionProvider, 'human'>;
    description?: string;
    ownerUserId?: string;
}
declare class UpdateAgentDto {
    name?: string;
    provider?: Exclude<ExecutionProvider, 'human'>;
    description?: string | null;
    ownerUserId?: string | null;
}
declare class CreateTokenDto {
    name: string;
    agentId?: string;
    expiresAt?: string;
}
export declare class WorkspacesController {
    private readonly service;
    constructor(service: WorkspacesService);
    list(auth: AuthInfo): Promise<import("../auth/auth.service.js").WorkspaceWithRole[]>;
    create(auth: AuthInfo, dto: CreateWorkspaceDto): Promise<import("../database/entities/index.js").WorkspaceEntity & {
        role: Role;
    }>;
}
export declare class WorkspaceController {
    private readonly service;
    constructor(service: WorkspacesService);
    get(ctx: WorkspaceContext): import("../database/entities/index.js").WorkspaceEntity & {
        role: Role;
    };
    update(ctx: WorkspaceContext, dto: UpdateWorkspaceDto): Promise<import("../database/entities/index.js").WorkspaceEntity & {
        role: Role;
    }>;
    remove(ctx: WorkspaceContext): Promise<void>;
}
export declare class MembersController {
    private readonly service;
    constructor(service: WorkspacesService);
    list(ctx: WorkspaceContext): Promise<(import("../database/entities/index.js").MembershipEntity & {
        user: import("../database/entities/index.js").UserEntity | undefined;
    })[]>;
    add(ctx: WorkspaceContext, dto: AddMemberDto): Promise<import("../database/entities/index.js").MembershipEntity & {
        user: import("../database/entities/index.js").UserEntity;
    }>;
    change(ctx: WorkspaceContext, id: string, dto: ChangeRoleDto): Promise<import("../database/entities/index.js").MembershipEntity & {
        user: import("../database/entities/index.js").UserEntity | null;
    }>;
    remove(ctx: WorkspaceContext, id: string): Promise<void>;
}
export declare class AgentsController {
    private readonly service;
    constructor(service: WorkspacesService);
    list(ctx: WorkspaceContext): Promise<import("../database/entities/index.js").AgentEntity[]>;
    create(ctx: WorkspaceContext, dto: CreateAgentDto): Promise<import("../database/entities/index.js").AgentEntity>;
    get(ctx: WorkspaceContext, id: string): Promise<import("../database/entities/index.js").AgentEntity>;
    update(ctx: WorkspaceContext, id: string, dto: UpdateAgentDto): Promise<import("../database/entities/index.js").AgentEntity>;
    remove(ctx: WorkspaceContext, id: string): Promise<void>;
}
export declare class TokensController {
    private readonly service;
    private readonly tokens;
    constructor(service: WorkspacesService, tokens: TokensService);
    list(ctx: WorkspaceContext): Promise<import("../database/entities/index.js").ApiTokenEntity[]>;
    create(ctx: WorkspaceContext, dto: CreateTokenDto): Promise<{
        token: import("../database/entities/index.js").ApiTokenEntity;
        secret: string;
    }>;
    remove(ctx: WorkspaceContext, id: string): Promise<void>;
}
export {};
