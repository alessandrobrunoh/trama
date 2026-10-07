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
import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException, UnsupportedMediaTypeException, } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { AuthService, SESSION_COOKIE } from '../auth/auth.service.js';
import { IS_PUBLIC_KEY, REQUIRE_USER_KEY, ROLES_KEY, hasRole, } from '../auth/request-context.js';
import { TokensService } from '../auth/tokens.service.js';
import { AgentEntity, MembershipEntity, UserEntity, WorkspaceEntity, } from '../database/entities/index.js';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
function parseCookies(header) {
    const out = {};
    for (const part of (header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0)
            continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}
function hasBody(req) {
    const len = req.headers['content-length'];
    return (len !== undefined && len !== '0') || req.headers['transfer-encoding'] !== undefined;
}
let AccessGuard = class AccessGuard {
    reflector;
    auth;
    tokens;
    workspaces;
    memberships;
    users;
    agents;
    constructor(reflector, auth, tokens, workspaces, memberships, users, agents) {
        this.reflector = reflector;
        this.auth = auth;
        this.tokens = tokens;
        this.workspaces = workspaces;
        this.memberships = memberships;
        this.users = users;
        this.agents = agents;
    }
    async canActivate(context) {
        if (context.getType() !== 'http')
            return true;
        const req = context.switchToHttp().getRequest();
        const targets = [context.getHandler(), context.getClass()];
        const mutating = !SAFE_METHODS.has(req.method);
        if (this.reflector.getAllAndOverride(IS_PUBLIC_KEY, targets)) {
            if (mutating && hasBody(req) && !req.is('application/json'))
                throw new UnsupportedMediaTypeException('Content-Type must be application/json');
            return true;
        }
        const auth = await this.authenticate(req);
        if (!auth)
            throw new UnauthorizedException('Authentication required');
        req.auth = auth;
        if (mutating && auth.method === 'session') {
            if (hasBody(req) && !req.is('application/json'))
                throw new UnsupportedMediaTypeException('Content-Type must be application/json');
            if (!req.headers['x-requested-with'] && !req.headers['x-client-id'])
                throw new ForbiddenException('Missing X-Requested-With or X-Client-Id header');
        }
        if (this.reflector.getAllAndOverride(REQUIRE_USER_KEY, targets) && !auth.user)
            throw new ForbiddenException('This endpoint requires a user, not an agent token');
        const slug = req.params.slug;
        if (slug) {
            const min = this.reflector.getAllAndOverride(ROLES_KEY, targets) ??
                (mutating ? 'member' : 'viewer');
            const workspace = await this.workspaces.findOneBy({ slug });
            const role = workspace ? await this.roleIn(auth, workspace.id) : null;
            if (!workspace || !role)
                throw new NotFoundException(`Workspace "${slug}" not found`);
            if (!hasRole(role, min))
                throw new ForbiddenException(`Requires role ${min} or higher`);
            req.ctx = { workspace, actor: auth.actor, userId: auth.user?.id, role };
        }
        return true;
    }
    async authenticate(req) {
        const header = req.headers.authorization;
        if (header) {
            const m = /^Bearer\s+(\S+)$/i.exec(header);
            if (!m)
                return null;
            const token = await this.tokens.authenticate(m[1]);
            if (!token)
                return null;
            if (token.actor.type === 'user') {
                const user = await this.users.findOneBy({ id: token.actor.id });
                return user ? { actor: { type: 'user', id: user.id }, user, token, method: 'token' } : null;
            }
            return { actor: token.actor, token, method: 'token' };
        }
        const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
        if (!raw)
            return null;
        const found = await this.auth.authenticateSession(raw);
        if (!found)
            return null;
        return {
            actor: { type: 'user', id: found.user.id },
            user: found.user,
            method: 'session',
            sessionId: found.sessionId,
        };
    }
    async roleIn(auth, workspaceId) {
        if (auth.token && auth.token.workspaceId !== workspaceId)
            return null;
        if (auth.user) {
            const m = await this.memberships.findOneBy({ workspaceId, userId: auth.user.id });
            return m?.role ?? null;
        }
        if (auth.actor.type === 'agent' && auth.actor.id) {
            return (await this.agents.existsBy({ id: auth.actor.id, workspaceId })) ? 'member' : null;
        }
        return null;
    }
};
AccessGuard = __decorate([
    Injectable(),
    __param(3, InjectRepository(WorkspaceEntity)),
    __param(4, InjectRepository(MembershipEntity)),
    __param(5, InjectRepository(UserEntity)),
    __param(6, InjectRepository(AgentEntity)),
    __metadata("design:paramtypes", [Reflector,
        AuthService,
        TokensService, Function, Function, Function, Function])
], AccessGuard);
export { AccessGuard };
//# sourceMappingURL=access.guard.js.map