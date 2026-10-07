import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { type AppRequest, type AuthInfo } from './request-context.js';
declare class SignupDto {
    name: string;
    email: string;
    password: string;
}
declare class LoginDto {
    email: string;
    password: string;
}
export declare function setSessionCookie(res: Response, raw: string): void;
export declare class AuthController {
    private readonly auth;
    constructor(auth: AuthService);
    signup(dto: SignupDto, req: AppRequest, res: Response): Promise<{
        user: import("../database/entities/index.js").UserEntity;
        workspaces: never[];
    }>;
    login(dto: LoginDto, req: AppRequest, res: Response): Promise<{
        user: import("../database/entities/index.js").UserEntity;
        workspaces: import("./auth.service.js").WorkspaceWithRole[];
    }>;
    logout(auth: AuthInfo, res: Response): Promise<void>;
    me(auth: AuthInfo): Promise<{
        user: import("../database/entities/index.js").UserEntity | undefined;
        workspaces: import("./auth.service.js").WorkspaceWithRole[];
    }>;
}
export {};
