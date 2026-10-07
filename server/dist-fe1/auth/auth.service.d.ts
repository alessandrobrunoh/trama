import { type Repository } from 'typeorm';
import { MembershipEntity, SessionEntity, UserEntity, WorkspaceEntity } from '../database/entities/index.js';
import type { Role } from '../contracts/domain.js';
export declare const SESSION_COOKIE = "nabla_session";
export declare const SESSION_TTL_MS: number;
export type WorkspaceWithRole = WorkspaceEntity & {
    role: Role;
};
export declare class AuthService {
    private readonly users;
    private readonly sessions;
    private readonly memberships;
    constructor(users: Repository<UserEntity>, sessions: Repository<SessionEntity>, memberships: Repository<MembershipEntity>);
    hashPassword(password: string): Promise<string>;
    createUser(input: {
        name: string;
        email: string;
        password: string;
    }): Promise<UserEntity>;
    verifyCredentials(emailRaw: string, password: string): Promise<UserEntity>;
    createSession(userId: string, userAgent?: string): Promise<{
        raw: string;
        expiresAt: Date;
    }>;
    authenticateSession(raw: string): Promise<{
        user: UserEntity;
        sessionId: string;
    } | null>;
    destroySession(sessionId: string): Promise<void>;
    workspacesOf(userId: string): Promise<WorkspaceWithRole[]>;
}
