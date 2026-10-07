import { DataSource, type Repository } from 'typeorm';
import { AuthService } from '../auth/auth.service.js';
import type { Role } from '../contracts/domain.js';
import { AgentEntity, ApiTokenEntity, MembershipEntity, UserEntity, WorkspaceEntity } from '../database/entities/index.js';
import { EventsService } from '../events/events.service.js';
export declare const RESERVED_SLUGS: Set<string>;
export declare class WorkspacesService {
    private readonly ds;
    private readonly auth;
    private readonly events;
    private readonly workspaces;
    private readonly memberships;
    private readonly users;
    private readonly agents;
    private readonly tokens;
    constructor(ds: DataSource, auth: AuthService, events: EventsService, workspaces: Repository<WorkspaceEntity>, memberships: Repository<MembershipEntity>, users: Repository<UserEntity>, agents: Repository<AgentEntity>, tokens: Repository<ApiTokenEntity>);
    listMine(userId: string): Promise<import("../auth/auth.service.js").WorkspaceWithRole[]>;
    create(user: UserEntity, input: {
        name: string;
        slug?: string;
    }): Promise<WorkspaceEntity & {
        role: Role;
    }>;
    update(ws: WorkspaceEntity, patch: {
        name?: string;
        slug?: string;
    }): Promise<WorkspaceEntity>;
    remove(ws: WorkspaceEntity): Promise<void>;
    listMembers(workspaceId: string): Promise<(MembershipEntity & {
        user: UserEntity | undefined;
    })[]>;
    private getMembership;
    addMember(workspaceId: string, callerRole: Role, input: {
        email: string;
        role: Role;
    }): Promise<MembershipEntity & {
        user: UserEntity;
    }>;
    changeRole(workspaceId: string, callerRole: Role, id: string, role: Role): Promise<MembershipEntity & {
        user: UserEntity | null;
    }>;
    removeMember(workspaceId: string, callerRole: Role, callerUserId: string | undefined, id: string): Promise<void>;
    private assertCanGrant;
    private assertNotLastOwner;
    listAgents(workspaceId: string): Promise<AgentEntity[]>;
    getAgent(workspaceId: string, id: string): Promise<AgentEntity>;
    createAgent(workspaceId: string, input: Partial<AgentEntity> & Pick<AgentEntity, 'name' | 'provider'>): Promise<AgentEntity>;
    updateAgent(workspaceId: string, id: string, patch: Partial<AgentEntity>): Promise<AgentEntity>;
    removeAgent(workspaceId: string, id: string): Promise<void>;
    listTokens(workspaceId: string, onlyUserId?: string): Promise<ApiTokenEntity[]>;
    removeToken(workspaceId: string, id: string, onlyUserId?: string): Promise<void>;
}
