import type { Request } from 'express';
import type { ActorRef, Role } from '../contracts/domain.js';
import type { ApiTokenEntity, UserEntity, WorkspaceEntity } from '../database/entities/index.js';
export interface AuthInfo {
    actor: ActorRef;
    user?: UserEntity;
    token?: ApiTokenEntity;
    method: 'session' | 'token';
    sessionId?: string;
}
export interface WorkspaceContext {
    workspace: WorkspaceEntity;
    actor: ActorRef;
    userId?: string;
    role: Role;
}
export interface AppRequest extends Request {
    auth?: AuthInfo;
    ctx?: WorkspaceContext;
}
export declare const ROLE_RANK: Record<Role, number>;
export declare function hasRole(role: Role, min: Role): boolean;
export declare const IS_PUBLIC_KEY = "nabla:public";
export declare const ROLES_KEY = "nabla:roles";
export declare const REQUIRE_USER_KEY = "nabla:require-user";
export declare const Public: () => import("@nestjs/common").CustomDecorator<string>;
export declare const Roles: (min: Role) => import("@nestjs/common").CustomDecorator<string>;
export declare const RequireUser: () => import("@nestjs/common").CustomDecorator<string>;
export declare const Ctx: (...dataOrPipes: unknown[]) => ParameterDecorator;
export declare const Actor: (...dataOrPipes: unknown[]) => ParameterDecorator;
export declare const Auth: (...dataOrPipes: unknown[]) => ParameterDecorator;
