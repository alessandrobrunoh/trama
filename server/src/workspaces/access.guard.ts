import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { AuthService, SESSION_COOKIE } from '../auth/auth.service.js';
import {
  ALLOW_CUSTOM_TOKEN_KEY,
  CAPABILITY_KEY,
  IS_PUBLIC_KEY,
  REQUIRE_USER_KEY,
  TEAM_SCOPE_KEY,
  ROLES_KEY,
  hasRole,
  type AppRequest,
  type AuthInfo,
} from '../auth/request-context.js';
import { requiredPermission } from '../auth/api-permissions.js';
import { TokensService } from '../auth/tokens.service.js';
import type { Capability, Role, TokenScope } from '../contracts/domain.js';
import { PermissionsService } from './permissions.service.js';
import {
  AgentEntity,
  MembershipEntity,
  UserEntity,
  WorkspaceEntity,
} from '../database/entities/index.js';

/** Effective role of a token: read -> viewer, write -> member (never above the member's own role). */
export function capRole(role: Role, scope: TokenScope | undefined): Role {
  const cap: Role | undefined = scope === 'read' ? 'viewer' : scope === 'write' ? 'member' : undefined;
  return cap && !hasRole(cap, role) ? cap : role;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function hasBody(req: AppRequest): boolean {
  const len = req.headers['content-length'];
  return (len !== undefined && len !== '0') || req.headers['transfer-encoding'] !== undefined;
}

/**
 * The single global guard. In order:
 *  1. `@Public()` routes pass through (but mutating ones with a body must be JSON).
 *  2. Authenticates: `Authorization: Bearer nbl_…` (API token, acting as a user or an agent)
 *     or the httpOnly `nabla_session` cookie. → 401 otherwise. Sets `req.auth`.
 *  3. CSRF for cookie sessions: mutating requests need `X-Requested-With` or `X-Client-Id`
 *     (forces a CORS preflight, so only allow-listed origins can send them); bodies must be JSON.
 *  4. API token scopes: `read` tokens can only call safe (GET) routes; the effective role of a
 *     `read` token is capped at viewer and of a `write` token at member, so neither can reach
 *     workspace-admin routes. `admin` tokens keep the full role of the user they act as.
 *  5. For routes with a `:slug` param: resolves the workspace + the caller's role → `req.ctx`.
 *     Non-members get 404 (existence is not leaked), too-low role gets 403.
 *     The minimum role is `@Can(capability)` (workspace permission settings), else `@Roles(min)`,
 *     else viewer for reads / member for writes.
 *     Agent tokens get role `member` in the workspace the token belongs to.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    @InjectRepository(WorkspaceEntity) private readonly workspaces: Repository<WorkspaceEntity>,
    @InjectRepository(MembershipEntity) private readonly memberships: Repository<MembershipEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(AgentEntity) private readonly agents: Repository<AgentEntity>,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const targets = [context.getHandler(), context.getClass()];
    const mutating = !SAFE_METHODS.has(req.method);

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      if (mutating && hasBody(req) && !req.is('application/json'))
        throw new UnsupportedMediaTypeException('Content-Type must be application/json');
      return true;
    }

    const auth = await this.authenticate(req);
    if (!auth) throw new UnauthorizedException('Authentication required');
    req.auth = auth;

    if (mutating && auth.method === 'session') {
      if (hasBody(req) && !req.is('application/json'))
        throw new UnsupportedMediaTypeException('Content-Type must be application/json');
      if (!req.headers['x-requested-with'] && !req.headers['x-client-id'])
        throw new ForbiddenException('Missing X-Requested-With or X-Client-Id header');
    }

    if (auth.token) {
      await this.tokens.enforceLimits(auth.token, mutating);
      if (auth.token.scope === 'custom') this.enforceCustomPermission(req, targets, mutating);
    }

    if (auth.token?.scope === 'read' && mutating)
      throw new ForbiddenException('This API token has the "read" scope and can only call GET routes');

    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_USER_KEY, targets) && !auth.user)
      throw new ForbiddenException('This endpoint requires a user, not an agent token');

    const slug = (req.params as Record<string, string | undefined>).slug;
    if (slug) {
      const workspace = await this.workspaces.findOneBy({ slug });
      const memberRole = workspace ? await this.roleIn(auth, workspace.id) : null;
      if (!workspace || !memberRole) throw new NotFoundException(`Workspace "${slug}" not found`);
      const capability = this.reflector.getAllAndOverride<Capability | undefined>(CAPABILITY_KEY, targets);
      const min: Role = capability
        ? workspace.resolved().permissions[capability]
        : (this.reflector.getAllAndOverride<Role | undefined>(ROLES_KEY, targets) ?? (mutating ? 'member' : 'viewer'));
      const scope = auth.token?.scope;
      const role = capRole(memberRole, scope);
      if (!hasRole(role, min)) {
        if (scope && hasRole(memberRole, min))
          throw new ForbiddenException(`This route needs role ${min}: use an admin-scoped token (this one is "${scope}")`);
        throw new ForbiddenException(`Requires role ${min} or higher`);
      }
      req.ctx = { workspace, actor: auth.actor, userId: auth.user?.id, role, memberRole, tokenScope: scope };
      const teamScope = this.reflector.getAllAndOverride<'workstream' | 'issue' | undefined>(TEAM_SCOPE_KEY, targets);
      if (teamScope) await this.permissions.enforceTeamScope(teamScope, req, req.ctx);
    }
    return true;
  }

  /** `custom` tokens: the route's `<resource>:<action>` must be in the token's explicit list. */
  private enforceCustomPermission(req: AppRequest, targets: Parameters<Reflector['getAllAndOverride']>[1], mutating: boolean): void {
    const token = req.auth!.token!;
    const path = (req.route as { path?: string } | undefined)?.path ?? '';
    const needed = requiredPermission(req.method, path);
    if (!needed) {
      if (this.reflector.getAllAndOverride<boolean>(ALLOW_CUSTOM_TOKEN_KEY, targets) && !mutating) return;
      throw new ForbiddenException('This route is not available to custom API tokens');
    }
    if (!token.permissions?.includes(needed))
      throw new ForbiddenException(`This API token lacks the "${needed}" permission`);
  }

  private async authenticate(req: AppRequest): Promise<AuthInfo | null> {
    const header = req.headers.authorization;
    if (header) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      if (!m) return null;
      const token = await this.tokens.authenticate(m[1]);
      // A presented bearer token that is missing, revoked or expired is not a session.
      // Do not fall through to the cookie: the caller asked to act as that token.
      if (!token) return null;
      if (token.actor.type === 'user') {
        const user = await this.users.findOneBy({ id: token.actor.id });
        return user ? { actor: { type: 'user', id: user.id }, user, token, method: 'token' } : null;
      }
      return { actor: token.actor, token, method: 'token' };
    }
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    const found = await this.auth.authenticateSession(raw);
    if (!found) return null;
    return {
      actor: { type: 'user', id: found.user.id },
      user: found.user,
      method: 'session',
      sessionId: found.sessionId,
    };
  }

  /** The caller's role in a workspace, or null when they have no access to it. */
  private async roleIn(auth: AuthInfo, workspaceId: string): Promise<Role | null> {
    if (auth.token && auth.token.workspaceId !== workspaceId) return null;
    if (auth.user) {
      const m = await this.memberships.findOneBy({ workspaceId, userId: auth.user.id });
      return m?.role ?? null;
    }
    // Agent token: valid only while the agent still exists in this workspace.
    if (auth.actor.type === 'agent' && auth.actor.id) {
      return (await this.agents.existsBy({ id: auth.actor.id, workspaceId })) ? 'member' : null;
    }
    return null;
  }
}
